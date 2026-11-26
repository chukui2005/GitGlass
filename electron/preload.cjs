const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('gitglass', {
  getUpdateState: () => ipcRenderer.invoke('update:state'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  setAutomaticUpdates: (value) => ipcRenderer.invoke('update:automatic', value),
  installUpdate: (session) => ipcRenderer.invoke('update:install', session),
  getUpdateResume: () => ipcRenderer.invoke('update:resume'),
  consumeUpdateResume: () => ipcRenderer.invoke('update:resume-consumed'),
  onUpdateState: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('update:changed', listener)
    return () => ipcRenderer.removeListener('update:changed', listener)
  },
  // The main process watches the repository's .git directory. The renderer only
  // ever receives { reason } (a short Git-side label), never a path or handle.
  onRepositoryChanged: (callback) => {
    const listener = (_event, payload) => {
      if (typeof callback !== 'function') return
      callback({ reason: typeof payload?.reason === 'string' ? payload.reason : '' })
    }
    ipcRenderer.on('repo:changed', listener)
    return () => ipcRenderer.removeListener('repo:changed', listener)
  },
  // fs.watch can fail silently (network drives, restricted filesystems); the
  // renderer only ever receives { active }, never a path or handle.
  getWatcherState: () => ipcRenderer.invoke('watcher:state'),
  onWatcherChanged: (callback) => {
    const listener = (_event, payload) => {
      if (typeof callback !== 'function') return
      callback({ active: payload?.active === true })
    }
    ipcRenderer.on('watcher:changed', listener)
    return () => ipcRenderer.removeListener('watcher:changed', listener)
  },
  chooseRepository: () => ipcRenderer.invoke('repo:choose'),
  openRepository: (repositoryPath) => ipcRenderer.invoke('repo:open', repositoryPath),
  getRecentRepositories: () => ipcRenderer.invoke('repo:recent'),
  forgetRecentRepository: (repositoryPath) => ipcRenderer.invoke('repo:recent:forget', repositoryPath),
  // 克隆只表达「地址、父目录、文件夹名」：协议、最终目录与 argv 都由主进程决定，
  // 先拿计划（尚未运行）再回传同一个 operationId 执行。
  chooseCloneTarget: () => ipcRenderer.invoke('repo:clone:choose-target'),
  prepareClone: (request) => ipcRenderer.invoke('repo:clone:prepare', request),
  executeClone: (request) => ipcRenderer.invoke('repo:clone:execute', request),
  getState: () => ipcRenderer.invoke('repo:state'),
  getStagedOverview: () => ipcRenderer.invoke('repo:staged-overview'),
  getDiff: (file) => ipcRenderer.invoke('repo:diff', file),
  operate: (action, payload) => ipcRenderer.invoke('git:operate', action, payload),
  // 只表达「哪个方向、哪个块」：文件路径、快照与块标识来自 getDiff 的返回，
  // 补丁与命令由主进程构造，渲染层无法指定。
  applyDiffHunk: (direction, locator) => ipcRenderer.invoke('hunk:apply', direction, locator),
  getLedger: () => ipcRenderer.invoke('repo:ledger'),
  getBranches: () => ipcRenderer.invoke('repo:branches'),
  getCommits: () => ipcRenderer.invoke('repo:commits'),
  queryHistory: (filters) => ipcRenderer.invoke('history:query', filters),
  // References carry the full ref name and full commit id; the renderer only
  // sends the commit id back when it needs a commit outside the current list.
  getRefs: () => ipcRenderer.invoke('history:refs'),
  getCommit: (sha) => ipcRenderer.invoke('history:commit', sha),
  getCommitDetail: (sha) => ipcRenderer.invoke('history:detail', sha),
  getCommitDiff: (sha) => ipcRenderer.invoke('history:diff', sha),
  compareCommits: (baseSha, targetSha) => ipcRenderer.invoke('history:compare', baseSha, targetSha),
  getFileHistory: (filePath) => ipcRenderer.invoke('history:file', filePath),
  getFileHistoryDiff: (sha, filePath) => ipcRenderer.invoke('history:file-diff', sha, filePath),
  prepareBranch: (branch, create) => ipcRenderer.invoke('branch:prepare', branch, create),
  executeBranch: (branch, create, operationId) => ipcRenderer.invoke('branch:execute', branch, create, operationId),
  getRemoteOverview: () => ipcRenderer.invoke('remote:overview'),
  prepareRemote: (kind) => ipcRenderer.invoke('remote:prepare', kind),
  executeRemote: (kind, operationId) => ipcRenderer.invoke('remote:execute', kind, operationId),
  prepareDiscard: (filePath) => ipcRenderer.invoke('safety:discard:prepare', filePath),
  executeDiscard: (filePath, operationId) => ipcRenderer.invoke('safety:discard:execute', filePath, operationId),
  prepareDeleteMergedBranch: (branch) => ipcRenderer.invoke('safety:branch-delete:prepare', branch),
  executeDeleteMergedBranch: (branch, operationId) => ipcRenderer.invoke('safety:branch-delete:execute', branch, operationId),
  getReflog: () => ipcRenderer.invoke('recovery:reflog'),
  prepareRescueBranch: (hash, branch) => ipcRenderer.invoke('recovery:rescue:prepare', hash, branch),
  executeRescueBranch: (hash, branch, operationId) => ipcRenderer.invoke('recovery:rescue:execute', hash, branch, operationId),
})
