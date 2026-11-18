const { contextBridge } = require('electron')

// The recent-repositories probe passes its fixture list through additionalArguments,
// because a preload module reloads (and loses mutable state) on every navigation.
function readRecentRepositoriesProbe() {
  const prefix = '--recent-repositories-probe='
  const argument = (process.argv || []).find((value) => value.startsWith(prefix))
  if (!argument) return []
  try {
    const parsed = JSON.parse(decodeURIComponent(argument.slice(prefix.length)))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

let state = { supported: true, currentVersion: '0.5.6-beta.1', channel: 'beta', automatic: true, phase: 'idle', latestVersion: null, error: '', notes: '' }
let listener
let installedSession = null
let operations = 0
let consumed = false
let recentRepositories = readRecentRepositoriesProbe()
let openedRepository = null
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
  chooseRepository: async () => ({ canceled: true }),
  openRepository: async (repositoryPath) => {
    openedRepository = repositoryPath
    return { ok: true, path: repositoryPath, state: { ok: true, path: repositoryPath, branch: 'main', files: [], records: [] } }
  },
  getRecentRepositories: async () => recentRepositories,
  forgetRecentRepository: async (repositoryPath) => {
    recentRepositories = recentRepositories.filter((entry) => entry.path !== repositoryPath)
    return recentRepositories
  },
  getLedger: async () => [],
  getBranches: async () => ({ branches: [] }),
  getCommits: async () => ({ commits: [] }),
  getRemoteOverview: async () => ({ remotes: [] }),
  operate: async () => { operations++; return { execution: { ok: true }, state: { files: [] } } },
})
contextBridge.exposeInMainWorld('gitglassUpdateTest', {
  publish,
  result: () => ({ installedSession, operations, consumed, openedRepository }),
})
