const { contextBridge } = require('electron')

// 探针通过 additionalArguments 切换场景：repo（有仓库的工作区）或 empty（无仓库的空状态）。
// preload 在每次导航时都会重新加载，所以场景参数只能走 argv，不能靠可变状态。
const readMode = () => {
  const prefix = '--ledger-rows-probe='
  const argument = (process.argv || []).find((value) => value.startsWith(prefix))
  return argument ? argument.slice(prefix.length) : 'repo'
}

const mode = readMode()
const updateState = {
  supported: true,
  currentVersion: '0.6.2',
  channel: 'beta',
  automatic: true,
  phase: 'idle',
  latestVersion: null,
  error: '',
  notes: '',
}

const repositoryState = {
  ok: true,
  path: 'C:/test/repository',
  branch: 'main',
  files: [
    { path: 'src/main.jsx', area: 'unstaged', status: 'modified' },
    { path: 'docs/design.md', area: 'staged', status: 'modified' },
  ],
}

// 一条超长命令用于验证省略号与 title：它必须单行截断，而不是撑出横向滚动条。
const records = [
  {
    id: 'user-1',
    operationId: 'stage-main',
    source: 'user',
    intent: 'Stage file',
    displayCommand: 'git add -- src/main.jsx',
    argv: ['add', '--', 'src/main.jsx'],
    cwd: 'C:/test/repository',
    startedAt: '2026-11-18T02:00:00.000Z',
    endedAt: '2026-11-18T02:00:00.320Z',
    stdout: '',
    stderr: '',
    exitCode: 0,
    ok: true,
  },
  {
    id: 'bg-1',
    source: 'background',
    intent: 'Read working tree status',
    displayCommand:
      'git status --porcelain=v1 -z --untracked-files=all --ignore-submodules=none -- src/main.jsx docs/design.md electron/main.cjs',
    argv: ['status', '--porcelain=v1', '-z'],
    cwd: 'C:/test/repository',
    startedAt: '2026-11-18T02:00:01.000Z',
    endedAt: '2026-11-18T02:00:01.045Z',
    stdout: ' M src/main.jsx',
    stderr: '',
    exitCode: 0,
    ok: true,
  },
  {
    id: 'bg-2',
    source: 'background',
    intent: 'Read current branch',
    displayCommand: 'git branch --show-current',
    argv: ['branch', '--show-current'],
    cwd: 'C:/test/repository',
    startedAt: '2026-11-18T02:00:01.100Z',
    endedAt: '2026-11-18T02:00:01.118Z',
    stdout: 'main',
    stderr: '',
    exitCode: 0,
    ok: true,
  },
]

contextBridge.exposeInMainWorld('gitglass', {
  getUpdateState: async () => updateState,
  onUpdateState: () => () => {},
  getUpdateResume: async () => null,
  consumeUpdateResume: async () => {},
  checkForUpdates: async () => updateState,
  downloadUpdate: async () => updateState,
  setAutomaticUpdates: async () => updateState,
  installUpdate: async () => ({ ok: false }),
  getState: async () =>
    mode === 'empty'
      ? { ok: false, path: '', error: '还没有打开仓库。' }
      : repositoryState,
  getLedger: async () => (mode === 'empty' ? [] : records),
  getBranches: async () => ({ branches: [{ name: 'main', current: true, hash: 'abc1234' }] }),
  getCommits: async () => ({ commits: [], reason: '' }),
  queryHistory: async () => ({ commits: [], reason: '' }),
  getRemoteOverview: async () => ({ remotes: [], remote: '', upstream: '', ahead: 0, behind: 0 }),
  getRecentRepositories: async () => [],
  forgetRecentRepository: async () => [],
  chooseRepository: async () => ({ canceled: true }),
  openRepository: async () => ({ ok: false, canceled: true }),
  getDiff: async () => ({ stdout: '+hello\n', stderr: '', exitCode: 0, ok: true, argv: ['diff'] }),
  getCommitDetail: async () => ({ ok: false }),
  getCommitDiff: async () => ({ ok: false }),
  getFileHistory: async () => ({ ok: false }),
  getFileHistoryDiff: async () => ({ ok: false }),
  compareCommits: async () => ({ ok: false }),
  getReflog: async () => ({ ok: false, entries: [] }),
  prepareBranch: async () => ({ ok: false, reason: '探针不执行计划。' }),
  prepareRemote: async () => ({ ok: false, reason: '探针不执行计划。' }),
  prepareDiscard: async () => ({ ok: false, reason: '探针不执行计划。' }),
  prepareDeleteMergedBranch: async () => ({ ok: false, reason: '探针不执行计划。' }),
  prepareRescueBranch: async () => ({ ok: false, reason: '探针不执行计划。' }),
  executeBranch: async () => ({ ok: false }),
  executeRemote: async () => ({ ok: false }),
  executeDiscard: async () => ({ ok: false }),
  executeDeleteMergedBranch: async () => ({ ok: false }),
  executeRescueBranch: async () => ({ ok: false }),
  operate: async () => ({ ok: false }),
})
