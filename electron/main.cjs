const { app, BrowserWindow, dialog, ipcMain } = require('electron')
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
  const root = await commandService.run({ argv: ['rev-parse', '--show-toplevel'], intent: 'Resolve repository root', source: 'user', cwd: candidate })
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
ipcMain.handle('branch:prepare', (_event, branch, create) => repository.prepareSwitch(branch, Boolean(create)))
ipcMain.handle('branch:execute', (_event, branch, create, operationId) => repository.executeSwitch(branch, Boolean(create), operationId))
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
  if (process.env.GITGLASS_REPOSITORY && fs.existsSync(process.env.GITGLASS_REPOSITORY)) repoPath = path.resolve(process.env.GITGLASS_REPOSITORY)
  mainWindow = new BrowserWindow({ width: 1500, height: 940, minWidth: 1040, minHeight: 680, backgroundColor: '#101722', titleBarStyle: 'hiddenInset', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) mainWindow.loadURL(devUrl)
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) mainWindow.show() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

module.exports = { commandService, repository, isPath }
