const { contextBridge } = require('electron')

// Minimal renderer API for the panel-splitter probe: enough for the workspace to
// render, with no repository, no ledger and no update UI in the way.
const updateState = { supported: false, currentVersion: '0.6.4', channel: 'stable', automatic: false, phase: 'idle', latestVersion: null, error: '', notes: '' }
// Enough changed files to give the left sidebar its own scrollbar, which the
// splitter hit area must not swallow.
const files = Array.from({ length: 40 }, (_, index) => ({ path: `src/fixture-file-${String(index).padStart(2, '0')}.js`, area: 'unstaged' }))
const emptyRecord = { ok: true, stdout: '', stderr: '', argv: ['git', 'diff'], displayCommand: 'git diff', exitCode: 0 }

contextBridge.exposeInMainWorld('gitglass', {
  getUpdateState: async () => updateState,
  onUpdateState: () => () => {},
  getUpdateResume: async () => null,
  consumeUpdateResume: async () => ({ ok: true }),
  checkForUpdates: async () => updateState,
  downloadUpdate: async () => updateState,
  setAutomaticUpdates: async () => updateState,
  installUpdate: async () => ({ ok: false }),
  getState: async () => ({ ok: true, path: 'C:/fixture/repository', branch: 'main', files, records: [] }),
  getDiff: async () => emptyRecord,
  getLedger: async () => [],
  getBranches: async () => ({ branches: [] }),
  getCommits: async () => ({ commits: [] }),
  getRemoteOverview: async () => ({ remotes: [] }),
  getRecentRepositories: async () => [],
  chooseRepository: async () => ({ canceled: true }),
  openRepository: async () => ({ ok: false, message: 'fixture' }),
  forgetRecentRepository: async () => [],
  operate: async () => ({ execution: { ok: true }, state: { files: [] } }),
})
