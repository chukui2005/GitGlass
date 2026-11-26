// 克隆真实窗口验收探针的 preload：用**真实 Git 与产品主进程模块**实现 window.gitglass，
// 让真实窗口从「没有仓库」开始走一次克隆并打开。
//
// 与 workbench-preload.cjs 的区别：那个固定在 GITGLASS_WORKBENCH_REPO 上，这个从空工作台
// 起步，克隆成功后才把当前仓库切到克隆出来的目录。只用于 tests/support 的探针窗口。
const { contextBridge } = require('electron')
const { GitCommandService } = require('../../electron/git-command-service.cjs')
const { RepositoryService } = require('../../electron/repository-service.cjs')
const { openRepositoryPath } = require('../../electron/repository-opener.cjs')
const { normalizeCloneRequest, prepareClone, executeClone } = require('../../electron/repository-cloner.cjs')

// 探针跑在渲染进程的 preload 里：这里的 setTimeout 是 DOM 的（要求 this === window），
// 直接把它当 GitCommandService 的 setTimer 传进去会抛 Illegal invocation。
const commands = new GitCommandService({
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (handle) => clearTimeout(handle),
})
let root = ''
const repository = new RepositoryService(commands, () => root || null)
const remembered = []

function remember(candidate) {
  root = candidate
  if (candidate && !remembered.includes(candidate)) remembered.unshift(candidate)
}

async function openCandidate(candidate) {
  return openRepositoryPath({
    candidate,
    commandService: commands,
    repository,
    remember,
    setRepositoryPath: (next) => { root = next },
  })
}

const emptyState = () => ({ ok: false, path: '', branch: '', files: [], operation: null })
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
const notCovered = (reason) => async () => ({ ok: false, blocked: true, reason, plan: null })

contextBridge.exposeInMainWorld('gitglass', {
  getUpdateState: async () => updateState,
  onUpdateState: () => () => {},
  getUpdateResume: async () => null,
  consumeUpdateResume: async () => {},
  checkForUpdates: async () => updateState,
  downloadUpdate: async () => updateState,
  setAutomaticUpdates: async () => updateState,
  installUpdate: async () => ({ ok: false }),

  getState: async () => (root ? repository.state() : emptyState()),
  getLedger: async () => commands.history(),
  onRepositoryChanged: () => () => {},
  getWatcherState: async () => ({ active: true }),
  onWatcherChanged: () => () => {},

  getRecentRepositories: async () => remembered.map((entry) => ({ path: entry, name: entry.split(/[\\/]/).pop(), exists: true })),
  forgetRecentRepository: async () => remembered.map((entry) => ({ path: entry, name: entry.split(/[\\/]/).pop(), exists: true })),
  chooseRepository: async () => ({ canceled: true }),
  openRepository: openCandidate,

  // 目录选择器是原生对话框，探针改为直接往「目标位置」输入框里填路径。
  chooseCloneTarget: async () => ({ canceled: true }),
  prepareClone: async (request) => {
    const normalized = normalizeCloneRequest(request)
    if (!normalized.ok) return { ok: false, blocked: true, reason: normalized.reason, plan: null, target: null }
    return prepareClone({ source: normalized.source, parent: normalized.parent, name: normalized.name, commandService: commands })
  },
  executeClone: async (request) => {
    try {
      const normalized = normalizeCloneRequest(request, { allowOperationId: true })
      if (!normalized.ok) return { ok: false, blocked: true, reason: normalized.reason, plan: null, target: null, execution: null }
      const cloned = await executeClone({
        source: normalized.source,
        parent: normalized.parent,
        name: normalized.name,
        commandService: commands,
        operationId: normalized.operationId,
      })
      if (!cloned.ok) return cloned
      const opened = await openCandidate(cloned.target)
      if (!opened.ok) return { ...cloned, ok: false, message: opened.message, reason: opened.message || '克隆已完成，但无法打开该仓库。' }
      return { ...opened, target: cloned.target, plan: cloned.plan, execution: cloned.execution }
    } catch (error) {
      return { ok: false, reason: '探针执行失败：' + String((error && error.stack) || error), plan: null, target: null, execution: null }
    }
  },

  getBranches: async () => (root ? repository.branches() : { branches: [] }),
  getRemoteBranches: async () => (root ? repository.remoteBranches() : { branches: [] }),
  prepareRemoteConfig: notCovered('探针只覆盖克隆流程。'),
  executeRemoteConfig: async () => ({ execution: null }),
  prepareRemoteBranch: notCovered('探针只覆盖克隆流程。'),
  executeRemoteBranch: async () => ({ execution: null }),
  prepareFirstPush: notCovered('探针只覆盖克隆流程。'),
  executeFirstPush: async () => ({ execution: null }),
  getCommits: async () => (root ? repository.commits() : { commits: [], reason: '' }),
  queryHistory: async (filters) => (root ? repository.queryHistory(filters) : { commits: [], reason: '' }),
  getRemoteOverview: async () =>
    root
      ? repository.remoteOverview()
      : { ok: true, remotes: [], remote: null, upstream: null, ahead: 0, behind: 0, reason: '此仓库尚未配置远程仓库。' },
  getDiff: async (file) => (root ? repository.diff(file) : { ok: false, reason: '尚未打开仓库。' }),
  getStagedOverview: async () =>
    root ? repository.stagedOverview() : { ok: true, files: [], totals: { files: 0, insertions: 0, deletions: 0, binary: 0, unavailable: 0 }, reason: '' },
  getCommitDetail: async () => ({ ok: false }),
  getCommitDiff: async () => ({ ok: false, diff: '' }),
  compareCommits: async () => ({ ok: false, diff: '' }),
  getFileHistory: async () => ({ ok: true, entries: [] }),
  getFileHistoryDiff: async () => ({ ok: true, diff: '' }),
  getReflog: async () => ({ ok: true, entries: [] }),
  applyDiffHunk: async () => ({ ok: false, reason: '探针只覆盖克隆流程。' }),
  operate: async () => ({ execution: { ok: false, stderr: '探针只覆盖克隆流程。' }, state: root ? await repository.state() : emptyState() }),
  prepareBranch: notCovered('探针只覆盖克隆流程。'),
  executeBranch: async () => ({ execution: null }),
  prepareRemote: notCovered('探针只覆盖克隆流程。'),
  executeRemote: async () => ({ execution: null }),
  prepareDiscard: notCovered('探针只覆盖克隆流程。'),
  executeDiscard: async () => ({ execution: null }),
  prepareDeleteMergedBranch: notCovered('探针只覆盖克隆流程。'),
  executeDeleteMergedBranch: async () => ({ execution: null }),
  prepareRescueBranch: notCovered('探针只覆盖克隆流程。'),
  executeRescueBranch: async () => ({ execution: null }),
})
