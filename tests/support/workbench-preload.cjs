// 工作台验收探针的 preload：用**真实 git 命令**实现 window.gitglass 的同一份形状，
// 让真实窗口加载 dist/ 时可以对着一个临时仓库完整走「选文件 → 看差异 → 暂存 → 提交」。
//
// 只用于 tests/support 的探针窗口，不进入产品构建；产品 preload 仍然只走 IPC。
const { contextBridge } = require('electron')
const { execFileSync } = require('node:child_process')
const { parseStatus, parseBranches, parseCommits, parseCommitDetail, parseReflog } = require('../../electron/git-parsers.cjs')

const repository = process.env.GITGLASS_WORKBENCH_REPO || ''
const records = []
let sequence = 0

function runGit(args) {
  const startedAt = new Date().toISOString()
  let outcome
  try {
    const stdout = execFileSync('git', ['-C', repository, ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
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
function execute(args, intent, source = 'background') {
  sequence += 1
  const result = runGit(args)
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

const fileDiff = (file) => execute(
  file.area === 'staged' ? ['diff', '--cached', '--', file.path] : ['diff', '--', file.path],
  'Read file diff',
)

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
  getDiff: async (file) => {
    const { result } = fileDiff(file)
    return { ok: result.ok, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, argv: ['git', 'diff'], outputTruncated: false }
  },

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
    const { result } = fileDiff({ path, area: 'unstaged' })
    return {
      ok: true,
      blocked: false,
      kind: 'discard',
      path,
      diff: result.stdout,
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
