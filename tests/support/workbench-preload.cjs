// 工作台验收探针的 preload：用**真实 git 命令**实现 window.gitglass 的同一份形状，
// 让真实窗口加载 dist/ 时可以对着一个临时仓库完整走「选文件 → 看差异 → 暂存 → 提交」。
//
// 只用于 tests/support 的探针窗口，不进入产品构建；产品 preload 仍然只走 IPC。
const { contextBridge } = require('electron')
const { execFileSync } = require('node:child_process')
const { parseStatus, parseBranches, parseCommits, parseCommitDetail, parseReflog, parseNumstat } = require('../../electron/git-parsers.cjs')
const { hunkDiffArgs, hunkApplyArgs, hunkRange, diffSnapshot, parsePatchHunks, buildHunkPatch, locateHunk } = require('../../electron/patch-hunks.cjs')

const repository = process.env.GITGLASS_WORKBENCH_REPO || ''
const records = []
let sequence = 0

function runGit(args, input) {
  const startedAt = new Date().toISOString()
  let outcome
  try {
    const stdout = execFileSync('git', ['-C', repository, ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      input,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '1' },
    })
    outcome = { ok: true, exitCode: 0, stdout, stderr: '' }
  } catch (error) {
    outcome = {
      ok: false,
      exitCode: typeof error.status === 'number' ? error.status : 1,
      stdout: String(error.stdout || ''),
      stderr: String(error.stderr || error.message || ''),
    }
  }
  return { ...outcome, startedAt, endedAt: new Date().toISOString() }
}

// 每次调用都留一条账本记录：探针里的「用户操作 / 系统读取」都是真的跑过的命令。
function execute(args, intent, source = 'background', input) {
  sequence += 1
  const result = runGit(args, input)
  const record = {
    id: `probe-${sequence}`,
    source,
    intent,
    displayCommand: `git ${args.join(' ')}`,
    command: `git ${args.join(' ')}`,
    argv: args,
    cwd: repository,
    ok: result.ok,
    exitCode: result.exitCode,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    stdout: result.stdout,
    stderr: result.stderr,
    operationId: source === 'user' ? `op-${sequence}` : null,
  }
  records.unshift(record)
  if (records.length > 300) records.pop()
  return { result, record, execution: { ok: result.ok, argv: ['git', ...args], exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, operationId: record.operationId } }
}

function repositoryState() {
  const branch = execute(['branch', '--show-current'], 'Read current branch')
  const status = execute(['status', '--porcelain=v1', '-z', '--untracked-files=all'], 'Read working tree status')
  return {
    ok: true,
    path: repository,
    branch: branch.result.stdout.trim() || 'main',
    files: parseStatus(status.result.stdout),
    operation: null,
  }
}

const fileDiff = (file) => {
  const area = file.area === 'staged' ? 'staged' : 'unstaged'
  const { result } = execute(hunkDiffArgs(area, file.path), 'Read file diff')
  const snapshot = diffSnapshot({ cwd: repository, area, filePath: file.path, raw: result.stdout })
  const parsed = parsePatchHunks(result.stdout)
  return {
    ...result,
    area,
    path: file.path,
    snapshot,
    hunkSupport: parsed.ok
      ? { ok: true, reason: '', hunks: parsed.hunks.map((hunk) => ({ index: hunk.index, range: hunkRange(hunk), oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines, contentHash: hunk.contentHash })) }
      : { ok: false, reason: parsed.reason, hunks: [] },
  }
}

// 与产品同一条路径：重读同一区域 → 校验快照与块标识 → 只把这一块写入索引。
function applyHunkLocator(direction, locator) {
  const area = direction === 'unstage' ? 'staged' : 'unstaged'
  const intent = direction === 'unstage' ? 'Unstage diff hunk' : 'Stage diff hunk'
  const reject = (reason) => ({ ok: false, direction, area, path: locator?.path || '', hunk: locator?.hunk || null, execution: null, record: null, state: repositoryState(), reason })
  const read = execute(hunkDiffArgs(area, locator?.path || ''), 'Read hunk patch')
  if (!read.result.ok) return reject('无法读取此文件的差异，请刷新工作区后重试；诊断信息已保留在命令账本。')
  if (diffSnapshot({ cwd: repository, area, filePath: locator.path, raw: read.result.stdout }) !== locator.snapshot) return reject('Diff 已过期：读取之后工作区或仓库发生了变化，请刷新后重试。')
  const parsed = parsePatchHunks(read.result.stdout)
  if (!parsed.ok) return reject(parsed.reason)
  const located = locateHunk(parsed, locator.hunk)
  if (!located.ok || !located.hunk) return reject(located.reason)
  const patch = buildHunkPatch(parsed, located.hunk.index)
  if (!patch) return reject('所选 Diff 块已不存在，请刷新后重试。')
  const applied = execute(hunkApplyArgs(direction), intent, 'user', patch)
  const range = hunkRange(located.hunk)
  return {
    ok: applied.result.ok,
    direction,
    area,
    path: locator.path,
    hunk: { index: located.hunk.index, range, oldStart: located.hunk.oldStart, oldLines: located.hunk.oldLines, newStart: located.hunk.newStart, newLines: located.hunk.newLines },
    execution: { ...applied.execution, target: locator.path, hunk: range },
    record: { ...applied.record, target: locator.path, hunk: range },
    state: repositoryState(),
    reason: applied.result.ok ? '' : direction === 'unstage' ? '这个 Diff 块无法取消暂存。请刷新后重试。' : '这个 Diff 块无法应用到索引。请刷新后重试。',
  }
}

const stagedOverview = () => {
  const status = execute(['status', '--porcelain=v1', '-z', '--untracked-files=all'], 'Read working tree status')
  const stagedFiles = parseStatus(status.result.stdout).filter((file) => file.area === 'staged')
  const totals = { files: 0, insertions: 0, deletions: 0, binary: 0, unavailable: 0 }
  if (!stagedFiles.length) return { ok: true, files: [], totals, reason: '' }
  const stats = execute(['diff', '--cached', '--numstat', '-z'], 'Read staged overview')
  const byPath = new Map(parseNumstat(stats.result.stdout).map((entry) => [entry.path, entry]))
  const files = stagedFiles.map((file) => {
    const stat = byPath.get(file.path) || null
    const binary = Boolean(stat?.binary)
    return {
      path: file.path,
      oldPath: file.oldPath || null,
      status: file.status,
      insertions: binary ? null : stat?.insertions ?? null,
      deletions: binary ? null : stat?.deletions ?? null,
      binary,
      statUnavailable: !binary && (!stat || !stats.result.ok),
    }
  })
  for (const file of files) {
    totals.files += 1
    totals.insertions += file.insertions ?? 0
    totals.deletions += file.deletions ?? 0
    if (file.binary) totals.binary += 1
    if (file.statUnavailable) totals.unavailable += 1
  }
  return { ok: stats.result.ok, files, totals, reason: stats.result.ok ? '' : '无法读取暂存统计。文件清单仍来自实际暂存区。' }
}

const updateState = {
  supported: false,
  currentVersion: '0.7.0-probe',
  channel: 'beta',
  automatic: true,
  phase: 'idle',
  latestVersion: null,
  error: '',
  notes: '',
}

contextBridge.exposeInMainWorld('gitglass', {
  getUpdateState: async () => updateState,
  onUpdateState: () => () => {},
  getUpdateResume: async () => null,
  consumeUpdateResume: async () => {},
  checkForUpdates: async () => updateState,
  downloadUpdate: async () => updateState,
  setAutomaticUpdates: async () => updateState,
  installUpdate: async () => ({ ok: false }),

  getState: async () => repositoryState(),
  getLedger: async () => records.slice(),
  onRepositoryChanged: () => () => {},
  getWatcherState: async () => ({ active: true }),
  onWatcherChanged: () => () => {},

  getRecentRepositories: async () => [],
  forgetRecentRepository: async () => [],
  chooseRepository: async () => ({ canceled: true }),
  openRepository: async () => ({ ok: false, message: '探针固定在一个临时仓库上。' }),

  getBranches: async () => {
    const branches = execute(['for-each-ref', '--format=%(refname:short)%00%(HEAD)%00%(objectname:short)', 'refs/heads'], 'Read local branches')
    return { branches: parseBranches(branches.result.stdout) }
  },
  getRemoteBranches: async () => {
    const branches = execute(['branch', '--remotes', '--format=%(refname)%00%(refname:short)%00%(objectname:short)'], 'Read remote-tracking branches')
    const list = branches.result.ok
      ? branches.result.stdout
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => {
            const [full, short, hash] = line.split('\0')
            const slash = String(short || '').indexOf('/')
            return { full, short, hash, remote: slash === -1 ? '' : short.slice(0, slash), branch: slash === -1 ? '' : short.slice(slash + 1) }
          })
          .filter((entry) => entry.full && entry.branch && entry.branch !== 'HEAD')
      : []
    return { branches: list, reason: '' }
  },
  prepareRemoteConfig: async () => ({ ok: false, blocked: true, reason: '探针未配置远程配置。', plan: null }),
  executeRemoteConfig: async () => ({ execution: null }),
  prepareRemoteBranch: async () => ({ ok: false, blocked: true, reason: '探针未配置远程分支操作。', plan: null }),
  executeRemoteBranch: async () => ({ execution: null }),
  prepareFirstPush: async () => ({ ok: false, blocked: true, reason: '探针未配置首次推送。', plan: null }),
  executeFirstPush: async () => ({ execution: null }),
  getDiff: async (file) => {
    const detail = fileDiff(file)
    return { ...detail, outputTruncated: false }
  },
  getStagedOverview: async () => stagedOverview(),
  applyDiffHunk: async (direction, locator) => applyHunkLocator(direction, locator),

  getCommits: async () => ({ commits: commits(), reason: '' }),
  queryHistory: async () => ({ commits: commits(), reason: '' }),
  getCommitDetail: async (hash) => {
    const detail = execute(['show', '--no-ext-diff', '--format=%B%x1e%an%x1f%ae%x1f%aI', '--shortstat', hash], 'Read commit detail and statistics')
    if (!detail.result.ok) return { ok: false }
    const changed = execute(['show', '--no-ext-diff', '--format=', '--name-status', hash], 'Read commit changed files')
    return {
      ok: true,
      hash,
      ...parseCommitDetail(detail.result.stdout),
      changedFiles: changed.result.stdout.split('\n').filter(Boolean).map((line) => {
        const [status, ...rest] = line.split('\t')
        return { status, path: rest.join('\t') }
      }),
    }
  },
  getCommitDiff: async (hash) => {
    const { result } = execute(['show', '--no-ext-diff', '--format=', hash], 'Read commit diff')
    return { ok: result.ok, hash, diff: result.stdout, binary: false, truncated: false, reason: '' }
  },
  compareCommits: async (base, target) => {
    const { result } = execute(['diff', '--no-ext-diff', '--find-renames', base, target], 'Compare commits')
    return { ok: result.ok, base, target, diff: result.stdout, binary: false, truncated: false, reason: '' }
  },
  getFileHistory: async (filePath) => ({ ok: true, path: filePath, entries: [] }),
  getFileHistoryDiff: async (hash) => ({ ok: true, hash, diff: '', binary: false, truncated: false, reason: '' }),

  getRemoteOverview: async () => {
    const remotes = execute(['remote'], 'List remotes')
    return {
      ok: true,
      remotes: remotes.result.stdout.split('\n').filter(Boolean),
      remote: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      reason: '此仓库尚未配置远程仓库。',
      suggestion: '添加远程仓库后即可获取远程更新；为当前分支设置上游分支后可推送和拉取。',
    }
  },
  getReflog: async () => {
    const { result } = execute(['reflog', '--format=%H%x1f%h%x1f%gd%x1f%gs', '-n', '20'], 'Read recovery reflog')
    return { ok: result.ok, entries: parseReflog(result.stdout) }
  },

  operate: async (action, payload = {}) => {
    if (action === 'stage') return operation(execute(['add', '--', payload.path], 'Stage file', 'user'))
    if (action === 'unstage') return operation(execute(['restore', '--staged', '--', payload.path], 'Unstage file', 'user'))
    if (action === 'stageSelected') return operation(execute(['add', '--', ...(payload.paths || [])], 'Stage selected files', 'user'))
    if (action === 'stageAll') return operation(execute(['add', '-A'], 'Stage all changes', 'user'))
    if (action === 'unstageAll') return operation(execute(['restore', '--staged', '--', '.'], 'Unstage all changes', 'user'))
    if (action === 'commit') return operation(execute(['commit', '-m', payload.message], 'Create commit', 'user'))
    return { execution: { ok: false, stderr: `探针不支持 ${action}` } }
  },
  prepareDiscard: async (path) => {
    const detail = fileDiff({ path, area: 'unstaged' })
    return {
      ok: true,
      blocked: false,
      kind: 'discard',
      path,
      diff: detail.stdout,
      state: repositoryState(),
      plan: { operationId: 'op-discard', displayCommand: `git restore --worktree -- ${path}` },
    }
  },
  executeDiscard: async (path) => operation(execute(['restore', '--worktree', '--', path], 'Discard unstaged file changes', 'user')),
  prepareBranch: async (name, create) => ({
    ok: true,
    blocked: false,
    plan: { operationId: 'op-branch', displayCommand: create ? `git switch -c ${name}` : `git switch ${name}` },
  }),
  executeBranch: async (name, create) => operation(execute(create ? ['switch', '-c', name] : ['switch', name], create ? 'Create and switch branch' : 'Switch branch', 'user')),
  prepareRemote: async () => ({ ok: false, blocked: true, reason: '此仓库尚未配置远程仓库。', plan: null }),
  executeRemote: async () => ({ execution: { ok: false } }),
  prepareDeleteMergedBranch: async (branch) => ({
    ok: true,
    blocked: false,
    plan: { operationId: 'op-branch-delete', displayCommand: `git branch -d ${branch}` },
  }),
  executeDeleteMergedBranch: async (branch) => operation(execute(['branch', '-d', branch], 'Delete merged local branch', 'user')),
  prepareRescueBranch: async (hash, branch) => ({
    ok: true,
    blocked: false,
    plan: { operationId: 'op-rescue', displayCommand: `git branch ${branch} ${hash}` },
  }),
  executeRescueBranch: async (hash, branch) => operation(execute(['branch', branch, hash], 'Create reflog rescue branch', 'user')),
})

function commits() {
  const { result } = execute(['log', '-n', '40', '--date=iso-strict', '--format=%H%x1f%h%x1f%P%x1f%s%x1f%an%x1f%ae%x1f%aI%x1f%D'], 'Read recent commits')
  return result.ok ? parseCommits(result.stdout) : []
}

function operation(run) {
  return { execution: run.execution, state: repositoryState() }
}
