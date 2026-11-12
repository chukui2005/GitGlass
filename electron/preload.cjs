const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('gitglass', {
  chooseRepository: () => ipcRenderer.invoke('repo:choose'),
  getState: () => ipcRenderer.invoke('repo:state'),
  getDiff: (file) => ipcRenderer.invoke('repo:diff', file),
  operate: (action, payload) => ipcRenderer.invoke('git:operate', action, payload),
  getLedger: () => ipcRenderer.invoke('repo:ledger'),
  getBranches: () => ipcRenderer.invoke('repo:branches'),
  getCommits: () => ipcRenderer.invoke('repo:commits'),
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
