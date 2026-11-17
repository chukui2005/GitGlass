const { contextBridge } = require('electron')

let state = { supported: true, currentVersion: '0.5.6-beta.1', channel: 'beta', automatic: true, phase: 'idle', latestVersion: null, error: '', notes: '' }
let listener
let installedSession = null
let operations = 0
let consumed = false
const publish = (patch) => { state = { ...state, ...patch }; listener?.(state) }

contextBridge.exposeInMainWorld('gitglass', {
  getUpdateState: async () => state,
  onUpdateState: (fn) => { listener = fn; return () => { listener = null } },
  getUpdateResume: async () => ({ commitMessage: '更新前尚未提交的说明', historyMode: false }),
  consumeUpdateResume: async () => { consumed = true },
  checkForUpdates: async () => { publish({ phase: 'checking' }); return state },
  downloadUpdate: async () => { publish({ phase: 'downloading', progress: 42 }); return state },
  setAutomaticUpdates: async (value) => { publish({ automatic: value }); return state },
  installUpdate: async (session) => {
    installedSession = session
    publish({ phase: 'ready', error: '测试安装器启动失败，可以重试。' })
    return { ok: false }
  },
  getState: async () => ({ ok: true, path: 'C:/test/repository', branch: 'main', files: [] }),
  getLedger: async () => [],
  getBranches: async () => ({ branches: [] }),
  getCommits: async () => ({ commits: [] }),
  getRemoteOverview: async () => ({ remotes: [] }),
  operate: async () => { operations++; return { execution: { ok: true }, state: { files: [] } } },
})
contextBridge.exposeInMainWorld('gitglassUpdateTest', {
  publish,
  result: () => ({ installedSession, operations, consumed }),
})
