// Real Electron preload for the v0.6.10 integration acceptance.
//
// It deliberately reuses the production RepositoryService / GitCommandService /
// repository-cloner modules instead of reimplementing Git semantics. Only the
// transport is test-local: the renderer sees the same window.gitglass shape,
// while this preload keeps a mutable repository path so the clone flow can start
// from an empty workbench.
const { contextBridge } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { GitCommandService } = require('../../electron/git-command-service.cjs')
const { RepositoryService } = require('../../electron/repository-service.cjs')
const { prepareClone, executeClone } = require('../../electron/repository-cloner.cjs')

const root = process.env.GITGLASS_INTEGRATION_ROOT || ''
const cloneParent = path.join(root, 'clones')
let repository = ''
const commands = new GitCommandService({
  // In a renderer preload the timer globals are window-bound; passing them as
  // unbound method values would throw "Illegal invocation".
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (timer) => clearTimeout(timer),
})
const service = new RepositoryService(commands, () => repository)
const changedListeners = new Set()

function stateOrEmpty() {
  if (!repository) return { ok: false, path: '', branch: '', files: [], operation: null, records: [] }
  return service.state()
}

function notifyChanged(reason = 'refs') {
  for (const listener of changedListeners) {
    try {
      listener({ reason })
    } catch {}
  }
}

async function executeOperation(action, payload = {}) {
  let execution
  if (action === 'stage') execution = await service.stage(payload.path)
  else if (action === 'unstage') execution = await service.unstage(payload.path)
  else if (action === 'stageAll') execution = await service.stageAll()
  else if (action === 'stageSelected') execution = await service.stageSelected(payload.paths)
  else if (action === 'unstageAll') execution = await service.unstageAll()
  else if (action === 'commit') execution = await service.commit(payload.message)
  else execution = service.invalid('Unknown operation', 'Invalid Git operation or input.')
  return { execution, state: await stateOrEmpty() }
}

const idleUpdate = {
  supported: false,
  currentVersion: '0.6.10-probe',
  channel: 'beta',
  automatic: false,
  phase: 'idle',
  latestVersion: null,
  error: '',
  notes: '',
}

contextBridge.exposeInMainWorld('gitglass', {
  getUpdateState: async () => idleUpdate,
  checkForUpdates: async () => idleUpdate,
  downloadUpdate: async () => idleUpdate,
  setAutomaticUpdates: async () => idleUpdate,
  installUpdate: async () => ({ ok: false }),
  getUpdateResume: async () => null,
  consumeUpdateResume: async () => {},
  onUpdateState: () => () => {},

  onRepositoryChanged: (callback) => {
    if (typeof callback !== 'function') return () => {}
    changedListeners.add(callback)
    return () => changedListeners.delete(callback)
  },
  getWatcherState: async () => ({ active: true }),
  onWatcherChanged: () => () => {},

  getState: async () => stateOrEmpty(),
  getStagedOverview: async () => repository ? service.stagedOverview() : { ok: false, files: [], totals: null, reason: '没有打开的仓库。' },
  getDiff: async (file) => service.diff(file),
  applyDiffHunk: async (direction, locator) => direction === 'stage' ? service.stageHunk(locator) : service.unstageHunk(locator),
  getLedger: async () => commands.history(),
  operate: executeOperation,

  getBranches: async () => repository ? service.branches() : { branches: [] },
  getCommits: async () => repository ? service.commits() : { commits: [], reason: '没有打开的仓库。' },
  queryHistory: async (filters) => repository ? service.queryHistory(filters) : { ok: false, commits: [], reason: '没有打开的仓库。' },
  getRefs: async () => repository ? service.refs() : { ok: false, refs: [], head: null, reason: '没有打开的仓库。' },
  getCommit: async (sha) => service.commitBySha(sha),
  getCommitDetail: async (sha) => service.commitDetail(sha),
  getCommitDiff: async (sha) => service.commitDiff(sha),
  compareCommits: async (base, target) => service.compareCommits(base, target),
  getFileHistory: async (filePath) => service.fileHistory(filePath),
  getFileHistoryDiff: async (sha, filePath) => service.fileCommitDiff(sha, filePath),

  prepareBranch: async (branch, create) => service.prepareSwitch(branch, Boolean(create)),
  executeBranch: async (branch, create, operationId) => service.executeSwitch(branch, Boolean(create), operationId),
  getRemoteOverview: async () => repository ? service.remoteOverview() : { ok: false, remotes: [], details: [], remote: null, upstream: null, ahead: 0, behind: 0 },
  getRemoteBranches: async () => repository ? service.remoteBranches() : { branches: [] },
  prepareRemote: async (kind) => service.prepareRemote(kind),
  executeRemote: async (kind, operationId) => service.executeRemote(kind, operationId),
  prepareRemoteConfig: async (kind, request) => service.prepareRemoteConfig(kind, request),
  executeRemoteConfig: async (kind, request, operationId) => service.executeRemoteConfig(kind, request, operationId),
  prepareRemoteBranch: async (kind, remoteBranch, localName) =>
    kind === 'set-upstream'
      ? service.prepareSetUpstream(remoteBranch)
      : service.prepareCheckoutRemote(remoteBranch, localName),
  executeRemoteBranch: async (kind, remoteBranch, localName, operationId) =>
    kind === 'set-upstream'
      ? service.executeSetUpstream(remoteBranch, operationId)
      : service.executeCheckoutRemote(remoteBranch, localName, operationId),
  prepareFirstPush: async (request) => service.prepareFirstPush(request),
  executeFirstPush: async (request, operationId) => service.executeFirstPush(request, operationId),

  prepareDiscard: async (filePath) => service.prepareDiscard(filePath),
  executeDiscard: async (filePath, operationId) => service.executeDiscard(filePath, operationId),
  prepareDeleteMergedBranch: async (branch) => service.prepareDeleteMergedBranch(branch),
  executeDeleteMergedBranch: async (branch, operationId) => service.executeDeleteMergedBranch(branch, operationId),
  getReflog: async () => service.reflog(),
  prepareRescueBranch: async (hash, branch) => service.prepareRescueBranch(hash, branch),
  executeRescueBranch: async (hash, branch, operationId) => service.executeRescueBranch(hash, branch, operationId),

  chooseRepository: async () => ({ canceled: true }),
  openRepository: async () => ({ ok: false, message: '联调探针固定在克隆流程打开的仓库上。' }),
  getRecentRepositories: async () => [],
  forgetRecentRepository: async () => [],

  chooseCloneTarget: async () => {
    fs.mkdirSync(cloneParent, { recursive: true })
    return { canceled: false, path: cloneParent }
  },
  prepareClone: async (request) => prepareClone({ source: request?.source, parent: request?.parent, name: request?.name, commandService: commands }),
  executeClone: async (request) => {
    try {
      const result = await executeClone({
        source: request?.source,
        parent: request?.parent,
        name: request?.name,
        operationId: request?.operationId,
        commandService: commands,
      })
      if (!result.ok) return result
      repository = result.target
      return { ...result, path: repository, state: await service.state(), openExecution: result.execution }
    } catch (error) {
      return { ok: false, reason: `克隆执行异常：${error?.stack || error?.message || error}`, target: null, plan: null, execution: null }
    }
  },

  // Test-only signal so the probe can tell the renderer about a file written by
  // the harness, exactly like the production watcher would.
  __notifyRepositoryChanged: async (reason) => {
    notifyChanged(reason)
    return { ok: true }
  },
})
