const { parseStatus, parseBranches, parseCommits } = require('./git-parsers.cjs')

function isPath(value) { return typeof value === 'string' && value.length > 0 && !value.includes('\0') }
function isBranchInput(value) { return typeof value === 'string' && value.length > 0 && value.length <= 255 && !value.includes('\0') }
function isRemoteName(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) }

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
  run(argv, intent, source = 'background', operationId, redactOutput) { return this.commands.run({ argv, intent, source, cwd: this.cwd, operationId, redactOutput }) }
  plan(argv, intent, operationId) { return this.commands.plan({ argv, intent, cwd: this.cwd, operationId }) }

  async state() {
    const [branchRecord, statusRecord] = await Promise.all([
      this.run(['branch', '--show-current'], 'Read current branch'),
      this.run(['status', '--porcelain=v1', '-z'], 'Read working tree status'),
    ])
    if (!statusRecord.ok) return { ok: false, error: statusRecord.stderr || statusRecord.stdout, path: this.cwd, branch: '', files: [], records: [branchRecord, statusRecord] }
    return { ok: true, path: this.cwd, branch: branchRecord.stdout.trim() || 'DETACHED HEAD', files: parseStatus(statusRecord.stdout), records: [branchRecord, statusRecord] }
  }

  diff(file) {
    if (!file || !isPath(file.path)) return Promise.resolve(this.invalid('Read diff', 'Invalid file path.'))
    return this.run(file.area === 'staged' ? ['diff', '--cached', '--', file.path] : ['diff', '--', file.path], 'Read file diff')
  }
  stage(path) { return isPath(path) ? this.run(['add', '--', path], 'Stage file', 'user') : Promise.resolve(this.invalid('Stage file', 'Invalid file path.')) }
  unstage(path) { return isPath(path) ? this.run(['restore', '--staged', '--', path], 'Unstage file', 'user') : Promise.resolve(this.invalid('Unstage file', 'Invalid file path.')) }
  stageAll() { return this.run(['add', '-A'], 'Stage all changes', 'user') }
  unstageAll() { return this.run(['reset'], 'Unstage all changes', 'user') }
  commit(message) { return typeof message === 'string' && message.trim() && message.length <= 4096 ? this.run(['commit', '-m', message.trim()], 'Create commit', 'user') : Promise.resolve(this.invalid('Create commit', 'A commit message is required.')) }
  branches() { return this.run(['branch', '--format=%(refname:short)%00%(HEAD)%00%(objectname:short)'], 'Read local branches').then((record) => ({ record, branches: record.ok ? parseBranches(record.stdout) : [] })) }
  commits() { return this.run(['log', '-30', '--pretty=format:%h%x1f%p%x1f%s%x1f%an%x1f%aI'], 'Read recent commits').then((record) => ({ record, commits: record.ok ? parseCommits(record.stdout) : [] })) }

  async remoteOverview() {
    const state = await this.state()
    const remotesRecord = await this.run(['remote'], 'List remotes')
    const remotes = remotesRecord.ok ? remotesRecord.stdout.split(/\r?\n/).map((name) => name.trim()).filter(isRemoteName) : []
    if (!remotesRecord.ok) return { ok: false, state, remotes: [], reason: remotesRecord.stderr || remotesRecord.stdout || '无法读取远程仓库。', suggestion: '确认当前目录是有效的 Git 仓库。', records: [remotesRecord] }
    if (!remotes.length) return { ok: true, state, remotes, upstream: null, remote: null, ahead: 0, behind: 0, reason: '此仓库尚未配置远程仓库。', suggestion: '添加 remote 后即可 Fetch，并为当前分支设置 upstream 以使用 Push 和 Pull。', records: [remotesRecord] }

    const upstreamRecord = await this.run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], 'Read branch upstream')
    const upstream = upstreamRecord.ok ? parseUpstream(upstreamRecord.stdout) : null
    const remoteName = upstream?.remote || remotes[0]
    const urlRecord = await this.run(['remote', 'get-url', remoteName], 'Read remote URL', 'background', undefined, redactRemoteUrl)
    const remote = { name: remoteName, url: urlRecord.ok ? urlRecord.stdout.trim() : '' }
    if (!upstream) return { ok: true, state, remotes, remote, upstream: null, ahead: 0, behind: 0, reason: '当前分支尚未配置 upstream。', suggestion: '设置 upstream 后即可看到 Ahead / Behind，并安全使用 Push 和 Pull。', records: [remotesRecord, upstreamRecord, urlRecord] }

    const countRecord = await this.run(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], 'Read ahead and behind counts')
    const counts = countRecord.ok ? parseAheadBehind(countRecord.stdout) : null
    if (!counts) return { ok: false, state, remotes, remote, upstream, ahead: 0, behind: 0, reason: countRecord.stderr || countRecord.stdout || '无法读取 Ahead / Behind。', suggestion: '先 Fetch 远程仓库，然后重试。', records: [remotesRecord, upstreamRecord, urlRecord, countRecord] }
    return { ok: true, state, remotes, remote, upstream, ...counts, reason: '', suggestion: '', records: [remotesRecord, upstreamRecord, urlRecord, countRecord] }
  }

  async prepareRemote(kind, operationId) {
    const overview = await this.remoteOverview()
    const remote = overview.remote?.name
    if (!overview.ok && kind !== 'fetch') return { ok: false, blocked: true, reason: overview.reason, overview, plan: null }
    if (!remote) return { ok: false, blocked: true, reason: overview.reason || '没有可用的远程仓库。', overview, plan: null }
    if (kind === 'fetch') return { ok: true, blocked: false, kind, remote, overview, plan: this.plan(['fetch', remote], 'Fetch remote', operationId) }
    if (!overview.upstream || !overview.state.branch || overview.state.branch === 'DETACHED HEAD') return { ok: false, blocked: true, reason: overview.reason || '当前分支没有可用的 upstream。', overview, plan: null }
    if (kind === 'push') {
      if (overview.ahead <= 0) return { ok: false, blocked: true, reason: '当前分支没有领先于 upstream 的提交，因此没有可安全推送的内容。', overview, plan: null }
      return { ok: true, blocked: false, kind, remote, overview, plan: this.plan(['push', remote, `${overview.state.branch}:${overview.upstream.branch}`], 'Push branch safely', operationId) }
    }
    if (kind === 'pull') {
      if (overview.behind <= 0) return { ok: false, blocked: true, reason: '当前分支没有落后于 upstream 的提交，因此不需要 Pull。', overview, plan: null }
      if (overview.state.files.length) return { ok: false, blocked: true, reason: '工作区存在未提交或未暂存的变更。GitGlass 不会自动 stash、丢弃或覆盖它们。', overview, plan: null }
      const fastForward = await this.run(['merge-base', '--is-ancestor', 'HEAD', '@{upstream}'], 'Check fast-forward safety')
      if (!fastForward.ok) return { ok: false, blocked: true, reason: '本地历史无法安全 fast-forward 到 upstream；GitGlass 不会自动 merge 或 rebase。', overview, plan: null, fastForward }
      return { ok: true, blocked: false, kind, remote, overview, plan: this.plan(['pull', '--ff-only', remote, overview.upstream.branch], 'Pull with fast-forward only', operationId) }
    }
    return { ok: false, blocked: true, reason: '不支持的远程操作。', overview, plan: null }
  }

  async executeRemote(kind, operationId) {
    const prepared = await this.prepareRemote(kind, operationId)
    if (!prepared.ok) return { execution: null, ...prepared }
    const execution = await this.run(prepared.plan.argv, prepared.plan.intent, 'user', prepared.plan.operationId)
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
  invalid(intent, stderr) { return { id: null, operationId: null, intent, source: 'user', argv: ['git'], displayCommand: 'git', command: 'git', cwd: this.cwd || '', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), stdout: '', stderr, exitCode: -1, ok: false } }
}
module.exports = { RepositoryService, isBranchInput, isPath, isRemoteName, redactRemoteUrl, parseAheadBehind }
