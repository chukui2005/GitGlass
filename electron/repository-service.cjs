const { parseStatus, parseBranches, parseCommits, parseCommitDetail, parseReflog, parseNumstat } = require('./git-parsers.cjs')
const { NETWORK_TIMEOUT_MS } = require('./git-command-service.cjs')
const { hunkDiffArgs, hunkApplyArgs, hunkRange, diffSnapshot, parsePatchHunks, buildHunkPatch, locateHunk, describeHunks, REASON_STALE_SNAPSHOT, REASON_TRUNCATED } = require('./patch-hunks.cjs')
const fs = require('node:fs')
const path = require('node:path')

function isPath(value) { return typeof value === 'string' && value.length > 0 && !value.includes('\0') }
function isBranchInput(value) { return typeof value === 'string' && value.length > 0 && value.length <= 255 && !value.includes('\0') }
function isRemoteName(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) }
function isCommitHash(value) { return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value) }
function rescueBranchName(timestamp, shortHash) {
  const safeTime = String(timestamp || '').replace(/[^0-9A-Za-z]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown-time'
  const safeHash = String(shortHash || '').toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 12)
  return `rescue/${safeTime}-${safeHash || 'unknown'}`
}

// 批量暂存的安全上限：超过时不执行命令，直接返回中文原因。
const STAGE_SELECTED_MAX_PATHS = 200
const STAGE_SELECTED_MAX_TOTAL_CHARS = 8192
// Diff review keeps a larger budget than ordinary reads (the ledger default is 64 KiB).
const DIFF_OUTPUT_BYTES = 1024 * 1024
const HISTORY_QUERY_LIMIT = 200
const HISTORY_DEFAULT_LIMIT = 80
const HISTORY_PRETTY = '--pretty=format:%H%x1f%h%x1f%P%x1f%s%x1f%an%x1f%ae%x1f%aI%x1f%D'
// eslint-disable-next-line no-control-regex -- strips control characters from git output on purpose
const controlCharacter = /[\u0000-\u001f\u007f]/

// A merge, rebase, cherry-pick or revert left in progress is not a dirty
// working tree: Git already wrote a marker inside the git directory, and
// GitGlass must say so instead of blaming uncommitted changes.
const IN_PROGRESS_MARKERS = [
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
]

function resolveGitDirectory(workingDirectory) {
  if (typeof workingDirectory !== 'string' || !workingDirectory) return null
  const candidate = path.join(workingDirectory, '.git')
  try {
    const stat = fs.statSync(candidate)
    if (stat.isDirectory()) return candidate
    const match = /^gitdir:\\s*(.+)$/m.exec(fs.readFileSync(candidate, 'utf8'))
    if (!match) return null
    return path.resolve(workingDirectory, match[1].trim())
  } catch {
    // A bare repository keeps HEAD and objects directly in the folder.
    return fs.existsSync(path.join(workingDirectory, 'HEAD')) && fs.existsSync(path.join(workingDirectory, 'objects')) ? workingDirectory : null
  }
}

function invalidHistoryText(value, maximum) { return typeof value !== 'string' || value.length > maximum || controlCharacter.test(value) }
// git log --author uses a POSIX basic regular expression. `+`, `?`, `(`,
// `)` and `|` are ordinary there, while a dot is safely represented by `[.]`.
function escapeGitRegexLiteral(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]').replace(/\./g, '[.]').replace(/[\^$*]/g, '\\$&')
}
// 仓库相对路径：拒绝绝对路径、盘符路径、路径穿越与空段。历史筛选与按块操作共用。
function isRepositoryRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || controlCharacter.test(value)) return false
  if (/^[\\/]|^[A-Za-z]:[\\/]/.test(value) || value === '.' || value === '..') return false
  return !value.split(/[\\/]/).some((part) => part === '..' || part === '.')
}
function normalizeHistoryFilters(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: '筛选条件格式无效。请重新填写后应用。' }
  const allowed = new Set(['keyword', 'author', 'branch', 'filePath'])
  if (Object.keys(input).some((key) => !allowed.has(key))) return { ok: false, reason: '筛选条件包含不支持的内容。请重新填写后应用。' }
  const filters = { keyword: input.keyword ?? '', author: input.author ?? '', branch: input.branch ?? '', filePath: input.filePath ?? '' }
  if (invalidHistoryText(filters.keyword, 160)) return { ok: false, reason: '关键词无效或过长，请控制在 160 个字符以内。' }
  if (invalidHistoryText(filters.author, 120)) return { ok: false, reason: '作者条件无效或过长，请控制在 120 个字符以内。' }
  if (invalidHistoryText(filters.branch, 255)) return { ok: false, reason: '分支条件无效，请重新选择本地分支。' }
  if (filters.filePath && !isRepositoryRelativePath(filters.filePath)) return { ok: false, reason: '文件路径必须是当前仓库中的相对路径。' }
  return { ok: true, filters }
}

// 只接受非空、去重后的合法路径数组；任何一项非法都会拒绝整批操作。
function normalizeStagePaths(paths) {
  if (!Array.isArray(paths)) return { ok: false, reason: '暂存所选需要传入文件路径数组。', requested: [] }
  const unique = []
  for (const entry of paths) {
    if (!isPath(entry)) return { ok: false, reason: '存在无效的文件路径；已取消本次暂存。', requested: paths }
    if (!unique.includes(entry)) unique.push(entry)
  }
  if (!unique.length) return { ok: false, reason: '请先勾选至少一个未暂存文件。', requested: paths }
  if (unique.length > STAGE_SELECTED_MAX_PATHS) return { ok: false, reason: `单次最多暂存 ${STAGE_SELECTED_MAX_PATHS} 个文件；请减少选择后重试。`, requested: paths }
  const totalChars = unique.reduce((sum, entry) => sum + entry.length, 0)
  if (totalChars > STAGE_SELECTED_MAX_TOTAL_CHARS) return { ok: false, reason: '所选文件路径总长度过长；请减少选择后重试。', requested: paths }
  return { ok: true, paths: unique }
}

// 按块操作只接受「哪一次读取、哪个文件、哪一块」：区域由操作方向决定，
// 补丁由主进程从当前真实 Diff 重建，渲染层不能提供命令、路径以外的任何内容。
const HUNK_LOCATOR_KEYS = new Set(['path', 'snapshot', 'hunk'])
// 块标识只认「序号 + 内容摘要」：块头里可能带函数上下文（甚至像凭据的内容），
// 它不在 IPC 契约里，也不接受渲染层回传。行号范围只用来复核位置。
const HUNK_KEYS = new Set(['index', 'contentHash', 'range', 'oldStart', 'oldLines', 'newStart', 'newLines'])
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const HUNK_RANGE_PATTERN = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@$/

function normalizeHunkLocator(input) {
  const reason = (text) => ({ ok: false, reason: text, path: '', hunk: null })
  if (!input || typeof input !== 'object' || Array.isArray(input)) return reason('缺少 Diff 块标识，请刷新工作区后重试。')
  if (Object.keys(input).some((key) => !HUNK_LOCATOR_KEYS.has(key))) return reason('Diff 块请求包含不支持的内容，请刷新工作区后重试。')
  if (!isRepositoryRelativePath(input.path)) return reason('文件路径必须是当前仓库中的相对路径。')
  if (typeof input.snapshot !== 'string' || !SHA256_PATTERN.test(input.snapshot)) return { ok: false, reason: '缺少有效的 Diff 版本标识，请刷新工作区后重试。', path: input.path, hunk: null }
  const hunk = input.hunk
  const hunkReason = (text) => ({ ok: false, reason: text, path: input.path, hunk: null })
  if (!hunk || typeof hunk !== 'object' || Array.isArray(hunk)) return hunkReason('缺少 Diff 块标识，请刷新工作区后重试。')
  if (Object.keys(hunk).some((key) => !HUNK_KEYS.has(key))) return hunkReason('Diff 块请求包含不支持的内容，请刷新工作区后重试。')
  // 索引必须有上限：块编号来自主进程自己下发的清单，超出范围说明请求是伪造或过期的。
  if (!Number.isSafeInteger(hunk.index) || hunk.index < 0 || hunk.index > 999) return hunkReason('Diff 块编号无效，请刷新工作区后重试。')
  if (typeof hunk.contentHash !== 'string' || !SHA256_PATTERN.test(hunk.contentHash)) return hunkReason('Diff 块标识无效，请刷新工作区后重试。')
  const range = typeof hunk.range === 'string' ? hunk.range : ''
  if (range && !HUNK_RANGE_PATTERN.test(range)) return hunkReason('Diff 块位置无效，请刷新工作区后重试。')
  return { ok: true, path: input.path, snapshot: input.snapshot, hunk: { index: hunk.index, contentHash: hunk.contentHash, range } }
}

function redactRemoteUrl(value) {
  return String(value || '').split(/(\r?\n)/).map((line) => {
    if (!line || /^\r?$/.test(line)) return line
    try {
      const parsed = new URL(line.trim())
      parsed.username = ''
      parsed.password = ''
      parsed.search = ''
      parsed.hash = ''
      return parsed.toString()
    } catch {
      // SCP-style and local remotes do not use URL parsing. Strip any query or
      // fragment rather than risking an opaque credential reaching the ledger.
      return line.replace(/([?#]).*$/, '')
    }
  }).join('')
}

function parseUpstream(value) {
  const ref = String(value || '').trim()
  const separator = ref.indexOf('/')
  if (separator <= 0 || separator === ref.length - 1) return null
  return { ref, remote: ref.slice(0, separator), branch: ref.slice(separator + 1) }
}

function parseAheadBehind(value) {
  const [behind, ahead] = String(value || '').trim().split(/\s+/).map(Number)
  return Number.isSafeInteger(ahead) && ahead >= 0 && Number.isSafeInteger(behind) && behind >= 0 ? { ahead, behind } : null
}

class RepositoryService {
  constructor(commands, getRepoPath) { this.commands = commands; this.getRepoPath = getRepoPath }
  get cwd() { return this.getRepoPath() }
  run(argv, intent, source = 'background', operationId, redactOutput, maxOutputBytes, timeoutMs, extras = null) { return this.commands.run({ argv, intent, source, cwd: this.cwd, operationId, redactOutput, maxOutputBytes, timeoutMs, ...(extras || {}) }) }
  // 按块操作的读取要拿到脱敏前的原始输出：补丁必须逐字节回到 Git，而账本记录照旧脱敏。
  async readPatch(area, filePath, intent) {
    const { record, stdout } = await this.commands.runCapturingOutput({ argv: hunkDiffArgs(area, filePath), intent, source: 'background', cwd: this.cwd, maxOutputBytes: DIFF_OUTPUT_BYTES })
    return { record, stdout }
  }
  plan(argv, intent, operationId) { return this.commands.plan({ argv, intent, cwd: this.cwd, operationId }) }

  async state() {
    const [branchRecord, statusRecord] = await Promise.all([
      this.run(['branch', '--show-current'], 'Read current branch'),
      // -uall：未跟踪文件逐个列出，不折叠成目录条目；批量暂存的白名单
      // 依赖“每个未暂存条目都是精确文件路径”。
      this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'], 'Read working tree status'),
    ])
    const operation = this.operationInProgress()
    if (!statusRecord.ok) return { ok: false, error: '无法读取工作区状态。请确认仓库仍可访问后刷新。', path: this.cwd, branch: '', files: [], operation, records: [branchRecord, statusRecord] }
    return { ok: true, path: this.cwd, branch: branchRecord.stdout.trim() || 'DETACHED HEAD', files: parseStatus(statusRecord.stdout), operation, records: [branchRecord, statusRecord] }
  }

  // Reported to the UI so an in-progress merge/rebase is explained instead of
  // being mistaken for ordinary uncommitted changes.
  operationInProgress() {
    const gitDirectory = resolveGitDirectory(this.cwd)
    if (!gitDirectory) return null
    for (const [marker, kind] of IN_PROGRESS_MARKERS) {
      if (fs.existsSync(path.join(gitDirectory, marker))) return kind
    }
    return null
  }

  // 展示 Diff 与按块操作必须读到同一份原始补丁：读取参数由 patch-hunks 固定，
  // 记录里同时下发「这一次读取」的快照标识与块清单，渲染层只回传这些标识。
  // 快照与块清单都以脱敏前的原始输出为准，否则含凭据样式的行会让两者对不上。
  async diff(file) {
    if (!file || !isPath(file.path)) return this.invalid('Read diff', 'Invalid file path.')
    const area = file.area === 'staged' ? 'staged' : 'unstaged'
    // Interactive diff review keeps a larger budget than ordinary reads; the
    // record still reports outputTruncated when a file exceeds it.
    const { record, stdout } = await this.readPatch(area, file.path, 'Read file diff')
    const truncated = record.outputTruncated === true
    return {
      ...record,
      area,
      path: file.path,
      snapshot: diffSnapshot({ cwd: this.cwd, area, filePath: file.path, raw: stdout }),
      hunkSupport: truncated ? { ok: false, reason: REASON_TRUNCATED, hunks: [] } : describeHunks(stdout),
    }
  }
  stage(path) { return isPath(path) ? this.run(['add', '--', path], 'Stage file', 'user') : Promise.resolve(this.invalid('Stage file', 'Invalid file path.')) }
  async unstage(path) {
    if (!isPath(path)) return this.invalid('Unstage file', 'Invalid file path.')
    // A repository with no commit yet has no HEAD, so `git restore --staged`
    // fails with "could not resolve HEAD". Git is the authority for which form
    // works, so probe HEAD instead of guessing from repository state.
    const head = await this.run(['rev-parse', '--verify', '--quiet', 'HEAD'], 'Check HEAD for unstage')
    const argv = head.ok ? ['restore', '--staged', '--', path] : ['reset', '--', path]
    return this.run(argv, 'Unstage file', 'user')
  }
  stageAll() { return this.run(['add', '-A'], 'Stage all changes', 'user') }
  // 批量暂存：一次 git add -- 传入全部所选路径（-- 必须存在，以正确处理
  // 以连字符开头的文件名）。执行前先读取一次工作区状态，做服务端白名单校验：
  // 只允许精确匹配“当前 area === unstaged 的 path”，整批拒绝时不执行任何 Git 命令，
  // 并在命令账本留下一条“本地校验拒绝，未执行 Git 命令”的用户操作记录。
  async stageSelected(paths) {
    const normalized = normalizeStagePaths(paths)
    if (!normalized.ok) return this.rejectedStage(normalized.reason, normalized.requested)
    const state = await this.state()
    if (!state.ok) return this.rejectedStage('无法读取当前工作区状态，请刷新后重试。', paths)
    const unstagedPaths = new Set(state.files.filter((file) => file.area === 'unstaged').map((file) => file.path))
    const offenders = normalized.paths.filter((path) => !unstagedPaths.has(path))
    if (offenders.length) return this.rejectedStage(`所选文件已不在未暂存区，请刷新后重试。（${offenders.join('、')}）`, paths)
    return this.run(['add', '--', ...normalized.paths], 'Stage selected files', 'user')
  }
  rejectedStage(reason, paths) {
    return this.commands.recordRejection({ argv: ['add', '--', ...(Array.isArray(paths) ? paths : [])], intent: 'Stage selected files', source: 'user', cwd: this.cwd, stderr: reason, userMessage: reason })
  }
  // 按块暂存 / 取消暂存：请求只表达「哪一次读取、哪个文件、哪一块」。
  // 主进程重新读取同一份原始 Diff，确认快照与块标识都没变，再只把那一块
  // 正向应用进索引（暂存）或反向应用回 HEAD（取消暂存）。
  stageHunk(locator) { return this.applyHunkSelection('stage', locator) }
  unstageHunk(locator) { return this.applyHunkSelection('unstage', locator) }
  async applyHunkSelection(direction, locator) {
    const stage = direction === 'stage'
    const intent = stage ? 'Stage diff hunk' : 'Unstage diff hunk'
    const area = stage ? 'unstaged' : 'staged'
    const normalized = normalizeHunkLocator(locator)
    if (!normalized.ok) return this.rejectedHunk({ intent, area, reason: normalized.reason, path: normalized.path, hunk: normalized.hunk })
    const filePath = normalized.path
    // 服务端白名单：这个文件现在仍必须以「可整体确认范围」的状态出现在对应区域。
    const state = await this.state()
    if (!state.ok) return this.rejectedHunk({ intent, area, reason: '无法读取当前工作区状态，请刷新后重试。', path: filePath, hunk: normalized.hunk })
    const target = state.files.find((file) => file.path === filePath && file.area === area)
    if (!target) return this.rejectedHunk({ intent, area, reason: stage ? '所选文件已不在未暂存区，请刷新后重试。' : '所选文件已不在已暂存区，请刷新后重试。', path: filePath, hunk: normalized.hunk })
    if (target.status !== 'modified') return this.rejectedHunk({ intent, area, reason: '新增、删除或重命名的文件暂不支持按块操作。请使用整文件操作。', path: filePath, hunk: normalized.hunk })
    const { record, stdout } = await this.readPatch(area, filePath, 'Read hunk patch')
    if (!record.ok) return { ok: false, direction, area, path: filePath, hunk: null, execution: null, record, state: null, reason: '无法读取此文件的差异，请刷新工作区后重试；诊断信息已保留在命令账本。' }
    if (record.outputTruncated) return this.rejectedHunk({ intent, area, reason: REASON_TRUNCATED, path: filePath, hunk: normalized.hunk })
    if (diffSnapshot({ cwd: this.cwd, area, filePath, raw: stdout }) !== normalized.snapshot) {
      return this.rejectedHunk({ intent, area, reason: REASON_STALE_SNAPSHOT, path: filePath, hunk: normalized.hunk })
    }
    const parsed = parsePatchHunks(stdout)
    if (!parsed.ok) return this.rejectedHunk({ intent, area, reason: parsed.reason, path: filePath, hunk: normalized.hunk })
    const located = locateHunk(parsed, normalized.hunk)
    if (!located.ok || !located.hunk) return this.rejectedHunk({ intent, area, reason: located.reason, path: filePath, hunk: normalized.hunk })
    const locatedHunk = located.hunk
    const patch = buildHunkPatch(parsed, locatedHunk.index)
    if (!patch) return this.rejectedHunk({ intent, area, reason: '所选 Diff 块已不存在，请刷新后重试。', path: filePath, hunk: normalized.hunk })
    // 补丁是执行所需的输入，不是命令：固定 argv 只表达「把 stdin 上的补丁应用到索引」。
    // 审计字段只放目标文件与行号范围（由解析结果重新拼装，不含块头里的函数上下文），
    // 补丁正文与块头原文都不进入账本。
    const range = hunkRange(locatedHunk)
    const execution = await this.run(hunkApplyArgs(direction), intent, 'user', undefined, undefined, undefined, undefined, { input: patch, target: filePath, hunk: range })
    return {
      ok: execution.ok,
      direction,
      area,
      path: filePath,
      hunk: { index: locatedHunk.index, range, oldStart: locatedHunk.oldStart, oldLines: locatedHunk.oldLines, newStart: locatedHunk.newStart, newLines: locatedHunk.newLines },
      execution,
      record: execution,
      state: await this.state(),
      reason: execution.ok ? '' : stage ? '这个 Diff 块无法应用到索引。请刷新后重试；Git 的原始输出已保留在命令账本。' : '这个 Diff 块无法取消暂存。请刷新后重试；Git 的原始输出已保留在命令账本。',
    }
  }
  rejectedHunk({ intent, area, reason, path, hunk }) {
    // 本地校验拒绝也如实进入账本：同一条意图 + 目标文件 + 块范围，命令行标注未执行；
    // argv 与真正执行时会用的那条一致，审计时能看清「本来要跑什么」。
    const record = this.commands.recordRejection({
      argv: hunkApplyArgs(area === 'staged' ? 'unstage' : 'stage'),
      intent,
      source: 'user',
      cwd: this.cwd,
      stderr: reason,
      userMessage: reason,
      target: typeof path === 'string' ? path : '',
      hunk: typeof hunk?.range === 'string' ? hunk.range : '',
    })
    return { ok: false, direction: area === 'staged' ? 'unstage' : 'stage', area, path: typeof path === 'string' ? path : '', hunk: hunk || null, execution: null, record, state: null, reason }
  }
  unstageAll() { return this.run(['reset'], 'Unstage all changes', 'user') }
  // 提交前总览的数据来源是**实际暂存区**：文件清单来自 git status，增删行数来自
  // git diff --cached --numstat。统计是可选的：二进制、截断或解析不出的记录明确标记
  // 「不可用」，界面据此显示对应状态，而不是编一个 0。
  async stagedOverview() {
    const state = await this.state()
    const totals = { files: 0, insertions: 0, deletions: 0, binary: 0, unavailable: 0 }
    if (!state.ok) return { ok: false, files: [], totals, record: null, reason: state.error, state }
    const stagedFiles = state.files.filter((file) => file.area === 'staged')
    if (!stagedFiles.length) return { ok: true, files: [], totals, record: null, reason: '', state }
    const record = await this.run(['diff', '--cached', '--numstat', '-z'], 'Read staged overview')
    const stats = record.ok ? parseNumstat(record.stdout) : []
    const byPath = new Map(stats.map((entry) => [entry.path, entry]))
    const files = stagedFiles.map((file) => {
      const stat = byPath.get(file.path) ?? null
      const binary = Boolean(stat?.binary)
      return {
        path: file.path,
        oldPath: file.oldPath || null,
        status: file.status,
        insertions: binary ? null : stat?.insertions ?? null,
        deletions: binary ? null : stat?.deletions ?? null,
        binary,
        statUnavailable: !binary && (!stat || !record.ok || record.outputTruncated),
      }
    })
    for (const file of files) {
      totals.files += 1
      totals.insertions += file.insertions ?? 0
      totals.deletions += file.deletions ?? 0
      if (file.binary) totals.binary += 1
      if (file.statUnavailable) totals.unavailable += 1
    }
    return {
      ok: record.ok,
      files,
      totals,
      record,
      reason: record.ok ? '' : '无法读取暂存统计。文件清单仍来自实际暂存区；诊断信息已保留在命令账本。',
      state,
    }
  }
  commit(message) { return typeof message === 'string' && message.trim() && message.length <= 4096 ? this.run(['commit', '-m', message.trim()], 'Create commit', 'user') : Promise.resolve(this.invalid('Create commit', 'A commit message is required.')) }
  branches() { return this.run(['branch', '--format=%(refname:short)%00%(HEAD)%00%(objectname:short)'], 'Read local branches').then((record) => ({ record, branches: record.ok ? parseBranches(record.stdout) : [] })) }
  commits() {
    return this.run(['log', `-${HISTORY_DEFAULT_LIMIT}`, '--date=iso-strict', HISTORY_PRETTY], 'Read recent commits').then((record) => {
      // 空仓库或尚无提交的分支是正常状态，给出中文说明而不是原始 stderr。
      const emptyHistory = !record.ok && /does not have any commits|ambiguous argument|unknown revision|fatal: .*(does not have any commits)/i.test(record.stderr || '')
      return {
        record,
        commits: record.ok ? parseCommits(record.stdout) : [],
        reason: record.ok ? '' : emptyHistory ? '此仓库还没有提交记录。' : '无法读取提交历史。请刷新后重试；诊断信息已保留在命令账本。',
      }
    })
  }
  rejectHistoryQuery(reason, filters = {}) {
    const requested = [filters.keyword, filters.author, filters.branch, filters.filePath].filter((value) => typeof value === 'string' && value)
    const record = this.commands.recordRejection({ argv: ['log', ...requested], intent: 'Validate history query', source: 'background', cwd: this.cwd, stderr: reason, userMessage: reason })
    return { ok: false, commits: [], reason, filters: { keyword: '', author: '', branch: '', filePath: '' }, record }
  }
  async queryHistory(input) {
    const normalized = normalizeHistoryFilters(input)
    if (!normalized.ok) return this.rejectHistoryQuery(normalized.reason, input || {})
    const filters = normalized.filters
    if (!filters.keyword && !filters.author && !filters.branch && !filters.filePath) {
      const defaults = await this.commits()
      return { ok: defaults.record.ok, commits: defaults.commits, filters, record: defaults.record, reason: defaults.reason }
    }
    if (filters.branch) {
      const branchResult = await this.branches()
      if (!branchResult.record.ok) return { ok: false, commits: [], reason: '无法读取本地分支。请刷新后重试；诊断信息已保留在命令账本。', filters, record: branchResult.record }
      if (!branchResult.branches.some((branch) => branch.name === filters.branch)) return this.rejectHistoryQuery('所选分支已不存在，请刷新分支列表后重试。', filters)
    }
    if (filters.filePath) {
      const tracked = await this.run(['ls-files', '--error-unmatch', '--', filters.filePath], 'Verify tracked history query file')
      if (!tracked.ok) return { ok: false, commits: [], reason: '只能按当前已跟踪的文件筛选历史。请重新选择文件或清除文件条件。', filters, record: tracked }
    }
    const hasAuthor = Boolean(filters.author)
    const argv = ['log', `-${HISTORY_QUERY_LIMIT}`, '--date=iso-strict', '--regexp-ignore-case', HISTORY_PRETTY]
    // --fixed-strings also changes --author semantics. With an author filter,
    // escape both patterns for Git's basic-regexp matcher instead.
    if (!hasAuthor) argv.push('--fixed-strings')
    if (filters.keyword) argv.push(`--grep=${hasAuthor ? escapeGitRegexLiteral(filters.keyword) : filters.keyword}`)
    // git log --author is regex-based; escape every metacharacter so user text
    // remains a literal author/name fragment while argv remains fixed-structure.
    // Git's --author is regex-based, including email identities. Escape every
    // metacharacter so both names and emails remain literal Git-side filters.
    if (hasAuthor) argv.push(`--author=${escapeGitRegexLiteral(filters.author)}`)
    if (filters.branch) argv.push(`refs/heads/${filters.branch}`)
    if (filters.filePath) argv.push('--', filters.filePath)
    const record = await this.run(argv, 'Query commit history')
    const emptyHistory = !record.ok && /does not have any commits|ambiguous argument|unknown revision|fatal: .*(does not have any commits)/i.test(record.stderr || '')
    return { ok: record.ok, commits: record.ok ? parseCommits(record.stdout) : [], filters, record, reason: record.ok ? '' : emptyHistory ? '此仓库还没有提交记录。' : '无法读取提交历史。请检查筛选条件后重试；诊断信息已保留在命令账本。' }
  }

  async verifyHistoryCommit(hash) {
    if (!isCommitHash(hash)) return { ok: false, reason: '提交 SHA 无效。', record: this.invalid('Verify history commit', 'Invalid commit SHA.') }
    const record = await this.run(['rev-parse', '--verify', `${hash}^{commit}`], 'Verify history commit')
    // 提交给用户的原因始终是中文；原始 stderr 保留在账本记录里可审计。
    return record.ok ? { ok: true, hash: record.stdout.trim(), record } : { ok: false, reason: '提交不存在或不是有效提交。', detail: record.stderr || '', record }
  }

  async commitDetail(hash) {
    const verified = await this.verifyHistoryCommit(hash)
    if (!verified.ok) return { ok: false, reason: verified.reason, record: verified.record, files: [] }
    const [detail, files] = await Promise.all([
      // 结构化格式：完整提交说明（%B）与 作者/邮箱/时间 用分隔符隔开，
      // --shortstat 提供变更统计行；仍是一条真实命令，账本可审计。
      this.run(['show', '--no-ext-diff', '--format=%B%x1e%an%x1f%ae%x1f%aI', '--shortstat', '--find-renames', verified.hash], 'Read commit detail and statistics'),
      this.run(['show', '--no-ext-diff', '--format=', '--name-status', '--find-renames', verified.hash], 'Read commit changed files'),
    ])
    const changedFiles = files.ok ? files.stdout.split(/\r?\n/).filter(Boolean).map((line) => { const [status, ...paths] = line.split('\t'); return { status, path: paths.at(-1) || '', oldPath: paths.length > 1 ? paths[0] : null } }).filter((file) => file.path) : []
    const summary = detail.ok ? parseCommitDetail(detail.stdout) : null
    return {
      ok: detail.ok,
      hash: verified.hash,
      detail,
      files,
      changedFiles,
      summary,
      message: summary ? summary.message : '',
      subject: summary ? summary.subject : '',
      authorName: summary ? summary.authorName : '',
      authorEmail: summary ? summary.authorEmail : '',
      authoredAt: summary ? summary.authoredAt : '',
      filesChanged: summary ? summary.filesChanged : 0,
      insertions: summary ? summary.insertions : 0,
      deletions: summary ? summary.deletions : 0,
      reason: detail.ok ? '' : '无法读取提交详情。请返回提交历史后重试。',
    }
  }

  async commitDiff(hash) {
    const verified = await this.verifyHistoryCommit(hash)
    if (!verified.ok) return { ok: false, reason: verified.reason, record: verified.record }
    const record = await this.run(['show', '--no-ext-diff', '--format=', '--find-renames', verified.hash], 'Read commit diff', 'background', undefined, undefined, 1024 * 1024)
    // Git 对二进制文件只输出英文 "Binary files … differ"；由界面替换为中文说明。
    const binary = record.ok && /^Binary files .+ differ$/m.test(record.stdout)
    return { ok: record.ok, hash: verified.hash, record, diff: record.stdout, binary, truncated: record.outputTruncated, reason: record.ok ? '' : '无法读取提交差异。请返回提交历史后重试；诊断信息已保留在命令账本。' }
  }

  async compareCommits(baseSha, targetSha) {
    const [base, target] = await Promise.all([this.verifyHistoryCommit(baseSha), this.verifyHistoryCommit(targetSha)])
    if (!base.ok || !target.ok) return { ok: false, reason: base.reason || target.reason || '比较提交无效。', suggestion: '仓库状态刷新后选中的提交可能已失效，请回到历史列表重新选择。' }
    const record = await this.run(['diff', '--no-ext-diff', '--find-renames', base.hash, target.hash], 'Compare commits', 'background', undefined, undefined, 1024 * 1024)
    const binary = record.ok && /^Binary files .+ differ$/m.test(record.stdout)
    return { ok: record.ok, base: base.hash, target: target.hash, record, diff: record.stdout, binary, truncated: record.outputTruncated, reason: record.ok ? '' : '无法比较这两个提交。请返回提交历史后重新选择；诊断信息已保留在命令账本。' }
  }

  async fileHistory(filePath) {
    if (!isPath(filePath)) return { ok: false, reason: '文件路径无效。', entries: [] }
    const tracked = await this.run(['ls-files', '--error-unmatch', '--', filePath], 'Verify tracked history file')
    if (!tracked.ok) return { ok: false, reason: '只能查看已跟踪文件的历史。', entries: [], record: tracked }
    const record = await this.run(['log', '-50', '--follow', '--date=iso-strict', '--pretty=format:%H%x1f%h%x1f%P%x1f%s%x1f%an%x1f%aI%x1f%D', '--', filePath], 'Read file history')
    return { ok: record.ok, path: filePath, record, entries: record.ok ? parseCommits(record.stdout) : [], reason: record.ok ? '' : '无法读取文件历史。请返回提交详情后重试；诊断信息已保留在命令账本。' }
  }

  async fileCommitDiff(hash, filePath) {
    if (!isPath(filePath)) return { ok: false, reason: '文件路径无效。' }
    const verified = await this.verifyHistoryCommit(hash)
    if (!verified.ok) return { ok: false, reason: verified.reason }
    // 不再用 ls-files 校验当前 HEAD 是否跟踪该文件：删除文件的提交里，
    // 文件已从当前工作区消失，但该提交中的 Diff 仍然真实存在。
    const record = await this.run(['show', '--no-ext-diff', '--format=', verified.hash, '--', filePath], 'Read historical file diff', 'background', undefined, undefined, 1024 * 1024)
    const binary = record.ok && /^Binary files .+ differ$/m.test(record.stdout)
    return { ok: record.ok, hash: verified.hash, path: filePath, record, diff: record.stdout, binary, truncated: record.outputTruncated, reason: record.ok ? '' : '无法读取文件历史差异。请返回文件历史后重试；诊断信息已保留在命令账本。' }
  }

  async remoteOverview() {
    const state = await this.state()
    const remotesRecord = await this.run(['remote'], 'List remotes')
    const remotes = remotesRecord.ok ? remotesRecord.stdout.split(/\r?\n/).map((name) => name.trim()).filter(isRemoteName) : []
    if (!remotesRecord.ok) return { ok: false, state, remotes: [], reason: '无法读取远程仓库配置。', suggestion: '确认仓库仍可访问后刷新；诊断信息已保留在命令账本。', records: [remotesRecord] }
    if (!remotes.length) return { ok: true, state, remotes, upstream: null, remote: null, ahead: 0, behind: 0, reason: '此仓库尚未配置远程仓库。', suggestion: '添加远程仓库后即可获取远程更新；为当前分支设置上游分支后可推送和拉取。', records: [remotesRecord] }

    const upstreamRecord = await this.run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], 'Read branch upstream')
    const upstream = upstreamRecord.ok ? parseUpstream(upstreamRecord.stdout) : null
    const remoteName = upstream?.remote || remotes[0]
    const urlRecord = await this.run(['remote', 'get-url', remoteName], 'Read remote URL', 'background', undefined, redactRemoteUrl)
    const remote = { name: remoteName, url: urlRecord.ok ? urlRecord.stdout.trim() : '' }
    if (!upstream) return { ok: true, state, remotes, remote, upstream: null, ahead: 0, behind: 0, reason: '当前分支尚未配置上游分支。', suggestion: '设置上游分支后即可查看领先与落后状态，并安全推送或拉取。', records: [remotesRecord, upstreamRecord, urlRecord] }

    const countRecord = await this.run(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], 'Read ahead and behind counts')
    const counts = countRecord.ok ? parseAheadBehind(countRecord.stdout) : null
    if (!counts) return { ok: false, state, remotes, remote, upstream, ahead: 0, behind: 0, reason: '无法读取远程同步状态。', suggestion: '先获取远程更新后重试；诊断信息已保留在命令账本。', records: [remotesRecord, upstreamRecord, urlRecord, countRecord] }
    return { ok: true, state, remotes, remote, upstream, ...counts, reason: '', suggestion: '', records: [remotesRecord, upstreamRecord, urlRecord, countRecord] }
  }

  async prepareRemote(kind, operationId) {
    const overview = await this.remoteOverview()
    const remote = overview.remote?.name
    if (!overview.ok && kind !== 'fetch') return { ok: false, blocked: true, reason: overview.reason, overview, plan: null }
    if (!remote) return { ok: false, blocked: true, reason: overview.reason || '没有可用的远程仓库。', overview, plan: null }
    if (kind === 'fetch') return { ok: true, blocked: false, kind, remote, overview, plan: this.plan(['fetch', remote], 'Fetch remote', operationId) }
    if (!overview.upstream || !overview.state.branch || overview.state.branch === 'DETACHED HEAD') return { ok: false, blocked: true, reason: overview.reason || '当前分支没有可用的上游分支。', overview, plan: null }
    if (kind === 'push') {
      if (overview.ahead <= 0) return { ok: false, blocked: true, reason: '当前分支没有领先于上游分支的提交，因此没有可安全推送的内容。', overview, plan: null }
      return { ok: true, blocked: false, kind, remote, overview, plan: this.plan(['push', remote, `${overview.state.branch}:${overview.upstream.branch}`], 'Push branch safely', operationId) }
    }
    if (kind === 'pull') {
      if (overview.behind <= 0) return { ok: false, blocked: true, reason: '当前分支没有落后于上游分支的提交，因此无需拉取。', overview, plan: null }
      if (overview.state.files.length) return { ok: false, blocked: true, reason: '工作区存在未提交或未暂存的变更。GitGlass 不会自动 stash、丢弃或覆盖它们。', overview, plan: null }
      const fastForward = await this.run(['merge-base', '--is-ancestor', 'HEAD', '@{upstream}'], 'Check fast-forward safety')
      if (!fastForward.ok) return { ok: false, blocked: true, reason: '本地历史无法安全 fast-forward 到上游分支；GitGlass 不会自动合并或变基。', overview, plan: null, fastForward }
      return { ok: true, blocked: false, kind, remote, overview, plan: this.plan(['pull', '--ff-only', remote, overview.upstream.branch], 'Pull with fast-forward only', operationId) }
    }
    return { ok: false, blocked: true, reason: '不支持的远程操作。', overview, plan: null }
  }

  async executeRemote(kind, operationId) {
    const prepared = await this.prepareRemote(kind, operationId)
    if (!prepared.ok) return { execution: null, ...prepared }
    // fetch/push/pull talk to a remote: allow a longer deadline than local reads.
    const execution = await this.run(prepared.plan.argv, prepared.plan.intent, 'user', prepared.plan.operationId, null, null, NETWORK_TIMEOUT_MS)
    return { execution, ...prepared, overview: await this.remoteOverview() }
  }

  async prepareSwitch(branch, create = false, operationId) {
    if (!isBranchInput(branch)) return { ok: false, blocked: true, reason: '分支名无效。', plan: null }
    // Git is the authority for ref syntax. `--branch` consumes exactly one
    // argv entry, so the branch name remains data instead of shell text.
    const validation = await this.run(['check-ref-format', '--branch', branch], 'Validate branch name')
    if (!validation.ok) return { ok: false, blocked: true, reason: '分支名不符合 Git ref 规则。', plan: null, validation }
    const state = await this.state()
    if (!state.ok) return { ok: false, blocked: true, reason: state.error, plan: null }
    if (state.files.length) return { ok: false, blocked: true, reason: '工作区存在未提交或未暂存的变更。GitGlass 不会自动 stash、丢弃或覆盖它们。', plan: null, state }
    const argv = create ? ['switch', '-c', branch] : ['switch', branch]
    return { ok: true, blocked: false, plan: this.plan(argv, create ? 'Create and switch branch' : 'Switch branch', operationId), state }
  }
  async executeSwitch(branch, create = false, operationId) {
    const prepared = await this.prepareSwitch(branch, create, operationId)
    if (!prepared.ok) return { execution: null, ...prepared }
    // A plan stores Git arguments (not a shell command and not the executable).
    // Execute the exact reviewed argv without dropping its first argument.
    // When execution is invoked without an explicit reviewed plan (for example
    // by an internal caller), retain the operation ID generated by this plan.
    const execution = await this.run(prepared.plan.argv, prepared.plan.intent, 'user', prepared.plan.operationId)
    return { execution, ...prepared, state: await this.state() }
  }

  async prepareDiscard(path, operationId) {
    if (!isPath(path)) return { ok: false, blocked: true, reason: '文件路径无效。', plan: null }
    const state = await this.state()
    if (!state.ok) return { ok: false, blocked: true, reason: state.error, plan: null, state }
    const matching = state.files.filter((file) => file.path === path)
    if (!matching.some((file) => file.area === 'unstaged')) return { ok: false, blocked: true, reason: '只能丢弃当前未暂存的单个文件。', plan: null, state }
    if (matching.some((file) => file.area === 'staged')) return { ok: false, blocked: true, reason: '该文件包含已暂存内容，不能直接丢弃未暂存改动。', plan: null, state }
    const tracked = await this.run(['ls-files', '--error-unmatch', '--', path], 'Check tracked file for discard')
    if (!tracked.ok) return { ok: false, blocked: true, reason: '未跟踪文件不会被 GitGlass 删除或丢弃。', plan: null, state, tracked }
    const diff = await this.run(['diff', '--', path], 'Read discard diff summary')
    if (!diff.ok || !diff.stdout) return { ok: false, blocked: true, reason: '没有可丢弃的未暂存文本差异。', plan: null, state, diff }
    return { ok: true, blocked: false, kind: 'discard', path, diff: diff.stdout, state, plan: this.plan(['restore', '--worktree', '--', path], 'Discard unstaged file changes', operationId) }
  }

  async executeDiscard(path, operationId) {
    const prepared = await this.prepareDiscard(path, operationId)
    if (!prepared.ok) return { execution: null, ...prepared }
    const execution = await this.run(prepared.plan.argv, prepared.plan.intent, 'user', prepared.plan.operationId)
    return { execution, ...prepared, state: await this.state() }
  }

  async prepareDeleteMergedBranch(branch, operationId) {
    if (!isBranchInput(branch)) return { ok: false, blocked: true, reason: '分支名无效。', plan: null }
    const validation = await this.run(['check-ref-format', '--branch', branch], 'Validate branch name for deletion')
    if (!validation.ok) return { ok: false, blocked: true, reason: '分支名不符合 Git ref 规则。', plan: null, validation }
    const state = await this.state()
    if (!state.ok) return { ok: false, blocked: true, reason: state.error, plan: null, state }
    if (state.branch === branch) return { ok: false, blocked: true, reason: '不能删除当前分支。', plan: null, state }
    const exists = await this.run(['branch', '--list', '--format=%(refname:short)', branch], 'Check local branch exists')
    if (!exists.ok || !exists.stdout.split(/\r?\n/).map((name) => name.trim()).includes(branch)) return { ok: false, blocked: true, reason: '本地分支不存在。', plan: null, state, exists }
    const merged = await this.run(['merge-base', '--is-ancestor', branch, 'HEAD'], 'Check branch merged into current HEAD')
    if (!merged.ok) return { ok: false, blocked: true, reason: '该分支尚未合并。GitGlass 不会使用 -D 强制删除。', plan: null, state, merged }
    return { ok: true, blocked: false, kind: 'delete-merged-branch', branch, state, plan: this.plan(['branch', '-d', branch], 'Delete merged local branch', operationId) }
  }

  async executeDeleteMergedBranch(branch, operationId) {
    const prepared = await this.prepareDeleteMergedBranch(branch, operationId)
    if (!prepared.ok) return { execution: null, ...prepared }
    const execution = await this.run(prepared.plan.argv, prepared.plan.intent, 'user', prepared.plan.operationId)
    return { execution, ...prepared, state: await this.state() }
  }

  reflog() {
    return this.run(['reflog', '-20', '--date=iso', '--pretty=format:%H%x1f%h%x1f%gd%x1f%gs'], 'Read recovery reflog').then((record) => ({ record, entries: record.ok ? parseReflog(record.stdout) : [], reason: record.ok ? '' : '无法读取恢复记录。请刷新后重试；诊断信息已保留在命令账本。' }))
  }

  async prepareRescueBranch(hash, suggestedBranch, operationId) {
    if (!isCommitHash(hash)) return { ok: false, blocked: true, reason: '目标提交 SHA 无效。', plan: null }
    const branch = typeof suggestedBranch === 'string' && suggestedBranch ? suggestedBranch : rescueBranchName(new Date().toISOString(), hash.slice(0, 7))
    if (!isBranchInput(branch)) return { ok: false, blocked: true, reason: '救援分支名无效。', plan: null }
    const validation = await this.run(['check-ref-format', '--branch', branch], 'Validate rescue branch name')
    if (!validation.ok) return { ok: false, blocked: true, reason: '救援分支名不符合 Git ref 规则。', plan: null, validation }
    const commit = await this.run(['rev-parse', '--verify', `${hash}^{commit}`], 'Verify rescue commit')
    if (!commit.ok) return { ok: false, blocked: true, reason: '目标提交不存在或不是可保存的提交。', plan: null, commit }
    const exists = await this.run(['branch', '--list', '--format=%(refname:short)', branch], 'Check rescue branch does not exist')
    if (!exists.ok || exists.stdout.split(/\r?\n/).map((name) => name.trim()).includes(branch)) return { ok: false, blocked: true, reason: '目标救援分支已存在；GitGlass 不会覆盖已有分支。', plan: null, exists }
    return { ok: true, blocked: false, kind: 'rescue-branch', hash: commit.stdout.trim(), branch, plan: this.plan(['branch', branch, commit.stdout.trim()], 'Create reflog rescue branch', operationId) }
  }

  async executeRescueBranch(hash, branch, operationId) {
    const prepared = await this.prepareRescueBranch(hash, branch, operationId)
    if (!prepared.ok) return { execution: null, ...prepared }
    const execution = await this.run(prepared.plan.argv, prepared.plan.intent, 'user', prepared.plan.operationId)
    return { execution, ...prepared, state: await this.state() }
  }

  invalid(intent, stderr) { return { id: null, operationId: null, intent, source: 'user', argv: ['git'], displayCommand: 'git', command: 'git', cwd: this.cwd || '', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), stdout: '', stderr, exitCode: -1, ok: false } }
}
module.exports = { RepositoryService, resolveGitDirectory, isBranchInput, isPath, isRemoteName, isCommitHash, rescueBranchName, redactRemoteUrl, parseAheadBehind, normalizeHistoryFilters, isRepositoryRelativePath, normalizeHunkLocator, HISTORY_QUERY_LIMIT, escapeGitRegexLiteral }
