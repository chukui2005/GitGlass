const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { GitCommandService } = require('./git-command-service.cjs')
const { RepositoryService, isPath } = require('./repository-service.cjs')

let mainWindow
let repoPath = null
const commandService = new GitCommandService()
const repository = new RepositoryService(commandService, () => repoPath)

async function chooseRepository() {
  const choice = await dialog.showOpenDialog(mainWindow, { title: 'Open local Git repository', properties: ['openDirectory'] })
  if (choice.canceled || !choice.filePaths[0]) return { canceled: true }
  const candidate = path.resolve(choice.filePaths[0])
  const root = await commandService.run({ argv: ['rev-parse', '--show-toplevel'], intent: 'Resolve repository root', source: 'background', cwd: candidate })
  if (!root.ok) return { ok: false, error: root.stderr || 'This folder is not a Git repository.', execution: root }
  repoPath = root.stdout.trim()
  return { ok: true, path: repoPath, state: await repository.state(), execution: root }
}

ipcMain.handle('repo:choose', chooseRepository)
ipcMain.handle('repo:state', () => repository.state())
ipcMain.handle('repo:diff', (_event, file) => repository.diff(file))
ipcMain.handle('repo:ledger', () => commandService.history())
ipcMain.handle('repo:branches', () => repository.branches())
ipcMain.handle('repo:commits', () => repository.commits())
ipcMain.handle('history:detail', (_event, sha) => repository.commitDetail(sha))
ipcMain.handle('history:diff', (_event, sha) => repository.commitDiff(sha))
ipcMain.handle('history:compare', (_event, baseSha, targetSha) => repository.compareCommits(baseSha, targetSha))
ipcMain.handle('history:file', (_event, filePath) => repository.fileHistory(filePath))
ipcMain.handle('history:file-diff', (_event, sha, filePath) => repository.fileCommitDiff(sha, filePath))
ipcMain.handle('branch:prepare', (_event, branch, create) => repository.prepareSwitch(branch, Boolean(create)))
ipcMain.handle('branch:execute', (_event, branch, create, operationId) => repository.executeSwitch(branch, Boolean(create), operationId))
ipcMain.handle('remote:overview', () => repository.remoteOverview())
ipcMain.handle('remote:prepare', (_event, kind) => repository.prepareRemote(kind))
ipcMain.handle('remote:execute', (_event, kind, operationId) => repository.executeRemote(kind, operationId))
ipcMain.handle('safety:discard:prepare', (_event, filePath) => repository.prepareDiscard(filePath))
ipcMain.handle('safety:discard:execute', (_event, filePath, operationId) => repository.executeDiscard(filePath, operationId))
ipcMain.handle('safety:branch-delete:prepare', (_event, branch) => repository.prepareDeleteMergedBranch(branch))
ipcMain.handle('safety:branch-delete:execute', (_event, branch, operationId) => repository.executeDeleteMergedBranch(branch, operationId))
ipcMain.handle('recovery:reflog', () => repository.reflog())
ipcMain.handle('recovery:rescue:prepare', (_event, hash, branch) => repository.prepareRescueBranch(hash, branch))
ipcMain.handle('recovery:rescue:execute', (_event, hash, branch, operationId) => repository.executeRescueBranch(hash, branch, operationId))
ipcMain.handle('git:operate', async (_event, action, payload = {}) => {
  let execution
  if (action === 'stage') execution = await repository.stage(payload.path)
  else if (action === 'unstage') execution = await repository.unstage(payload.path)
  else if (action === 'stageAll') execution = await repository.stageAll()
  else if (action === 'unstageAll') execution = await repository.unstageAll()
  else if (action === 'commit') execution = await repository.commit(payload.message)
  else execution = repository.invalid('Unknown operation', 'Invalid Git operation or input.')
  let commit = null
  if (action === 'commit' && execution.ok) {
    const hash = await repository.run(['rev-parse', '--short', 'HEAD'], 'Read created commit hash')
    if (hash.ok) commit = hash.stdout.trim()
  }
  return { execution, state: await repository.state(), commit }
})

app.whenReady().then(() => {
  // Windows gives every window a native menu bar (File/Edit/View/Window) by
  // default. GitGlass ships its own UI, so remove it only there and keep the
  // native window controls intact.
  if (process.platform === 'win32') Menu.setApplicationMenu(null)
  if (process.env.GITGLASS_REPOSITORY && fs.existsSync(process.env.GITGLASS_REPOSITORY)) repoPath = path.resolve(process.env.GITGLASS_REPOSITORY)
  mainWindow = new BrowserWindow({ width: 1500, height: 940, minWidth: 1024, minHeight: 680, backgroundColor: '#f7f8fa', icon: path.join(__dirname, '..', 'public', 'icon-256.png'), titleBarStyle: 'hiddenInset', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) mainWindow.loadURL(devUrl)
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) mainWindow.show() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

module.exports = { commandService, repository, isPath }
