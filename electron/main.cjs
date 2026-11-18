const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { GitCommandService } = require('./git-command-service.cjs')
const { RepositoryService, isPath, resolveGitDirectory } = require('./repository-service.cjs')
const { RepositoryWatcher } = require('./repository-watcher.cjs')
const { OperationGate } = require('./operation-gate.cjs')
const { UpdateStore } = require('./update-store.cjs')
const { UpdateService } = require('./update-service.cjs')
const { createWindowsUpdater } = require('./windows-updater.cjs')
const { RecentRepositories, describeRecent } = require('./recent-repositories.cjs')
const { openRepositoryPath, MAX_REPOSITORY_PATH } = require('./repository-opener.cjs')
// 启动探针（scripts/report-startup.mjs 用）：GITGLASS_STARTUP_PROBE 未设置时是空函数，
// 下面的 startupProbe() 调用在正常运行与打包产物里都不产生任何副作用。
const { createStartupProbe } = require('./startup-probe.cjs')
const startupProbe = createStartupProbe()

// Git commands that write the repository get a silent window in the watcher so
// GitGlass does not report its own writes back to the renderer as an external
// change.
const WATCH_SILENCE_MS = 1500
const REPOSITORY_WRITE_CHANNELS = new Set([
  'git:operate',
  'remote:execute',
  'branch:execute',
  'safety:discard:execute',
  'safety:branch-delete:execute',
  'recovery:rescue:execute',
])

let mainWindow
let repoPath = null
let recentRepositories = null
let watcher = null
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()
app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})
const commandService = new GitCommandService()
const repository = new RepositoryService(commandService, () => repoPath)
const operationGate = new OperationGate()
let updates
let updateStore

function assertMainFrame(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('无效的应用请求。')
  }
}

function stopWatching() {
  watcher?.close()
  watcher = null
}

// Started whenever repoPath changes (startup restore and every openRepository()
// success) and stopped on window close, quit and repository switch, so a watcher
// never outlives the repository it points at.
function startWatching(repositoryPath) {
  stopWatching()
  if (!repositoryPath) return
  const gitDirectory = resolveGitDirectory(repositoryPath)
  if (!gitDirectory) return
  watcher = new RepositoryWatcher()
  watcher.watch(gitDirectory, ({ reason }) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('repo:changed', { reason })
  })
}

function handleRepository(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    assertMainFrame(event)
    if (!REPOSITORY_WRITE_CHANNELS.has(channel)) return operationGate.run(() => handler(event, ...args))
    // Silent before and after: the command may take seconds (network) and the
    // watcher must not report the files it writes as an external change.
    watcher?.notifyIgnored(WATCH_SILENCE_MS)
    return operationGate.run(() => handler(event, ...args)).finally(() => watcher?.notifyIgnored(WATCH_SILENCE_MS))
  })
}

function handleUpdate(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    assertMainFrame(event)
    return handler(...args)
  })
}

handleUpdate('update:state', () => updates.getState())
handleUpdate('update:check', () => updates.check())
handleUpdate('update:download', () => updates.download())
handleUpdate('update:automatic', (value) => updates.setAutomatic(value))
handleUpdate('update:install', (session) => updates.install(session))
handleUpdate('update:resume', () => {
  const resume = updateStore.value.resume
  return resume && typeof resume.commitMessage === 'string'
    ? { commitMessage: resume.commitMessage.slice(0, 65536), historyMode: resume.historyMode === true }
    : null
})
handleUpdate('update:resume-consumed', () => { updateStore.save({ resume: null }); return { ok: true } })

async function openRepository(candidate) {
  const result = await openRepositoryPath({
    candidate,
    commandService,
    repository,
    remember: (root) => recentRepositories?.remember(root),
    setRepositoryPath: (root) => { repoPath = root },
  })
  // Every way of opening a repository (dialog, recent-repository switcher,
  // renderer request) goes through here, so the watcher always follows the
  // repository that is actually open. startWatching() closes the previous one.
  if (result?.ok && result.path) startWatching(result.path)
  return result
}

async function chooseRepository() {
  const choice = await dialog.showOpenDialog(mainWindow, { title: '打开本地 Git 仓库', properties: ['openDirectory'] })
  if (choice.canceled || !choice.filePaths[0]) return { canceled: true }
  return openRepository(choice.filePaths[0])
}

handleRepository('repo:choose', chooseRepository)
handleRepository('repo:open', (_event, candidate) => openRepository(candidate))
// Listing and forgetting must work with no repository open, so these two do not
// take the operation gate.
handleUpdate('repo:recent', () => describeRecent(recentRepositories?.list() ?? []))
handleUpdate('repo:recent:forget', (candidate) => {
  if (typeof candidate !== 'string' || candidate.trim().length === 0 || candidate.length > MAX_REPOSITORY_PATH || candidate.includes('\0')) {
    throw new Error('仓库路径无效，无法从最近仓库移除。')
  }
  return describeRecent(recentRepositories?.forget(candidate) ?? [])
})
handleRepository('repo:state', () => repository.state())
handleRepository('repo:diff', (_event, file) => repository.diff(file))
handleRepository('repo:ledger', () => commandService.history())
handleRepository('repo:branches', () => repository.branches())
handleRepository('repo:commits', () => repository.commits())
handleRepository('history:query', (_event, filters) => repository.queryHistory(filters))
handleRepository('history:detail', (_event, sha) => repository.commitDetail(sha))
handleRepository('history:diff', (_event, sha) => repository.commitDiff(sha))
handleRepository('history:compare', (_event, baseSha, targetSha) => repository.compareCommits(baseSha, targetSha))
handleRepository('history:file', (_event, filePath) => repository.fileHistory(filePath))
handleRepository('history:file-diff', (_event, sha, filePath) => repository.fileCommitDiff(sha, filePath))
handleRepository('branch:prepare', (_event, branch, create) => repository.prepareSwitch(branch, Boolean(create)))
handleRepository('branch:execute', (_event, branch, create, operationId) => repository.executeSwitch(branch, Boolean(create), operationId))
handleRepository('remote:overview', () => repository.remoteOverview())
handleRepository('remote:prepare', (_event, kind) => repository.prepareRemote(kind))
handleRepository('remote:execute', (_event, kind, operationId) => repository.executeRemote(kind, operationId))
handleRepository('safety:discard:prepare', (_event, filePath) => repository.prepareDiscard(filePath))
handleRepository('safety:discard:execute', (_event, filePath, operationId) => repository.executeDiscard(filePath, operationId))
handleRepository('safety:branch-delete:prepare', (_event, branch) => repository.prepareDeleteMergedBranch(branch))
handleRepository('safety:branch-delete:execute', (_event, branch, operationId) => repository.executeDeleteMergedBranch(branch, operationId))
handleRepository('recovery:reflog', () => repository.reflog())
handleRepository('recovery:rescue:prepare', (_event, hash, branch) => repository.prepareRescueBranch(hash, branch))
handleRepository('recovery:rescue:execute', (_event, hash, branch, operationId) => repository.executeRescueBranch(hash, branch, operationId))
handleRepository('git:operate', async (_event, action, payload = {}) => {
  let execution
  if (action === 'stage') execution = await repository.stage(payload.path)
  else if (action === 'unstage') execution = await repository.unstage(payload.path)
  else if (action === 'stageAll') execution = await repository.stageAll()
  else if (action === 'stageSelected') execution = await repository.stageSelected(payload.paths)
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

if (primaryInstance) app.whenReady().then(async () => {
  startupProbe('whenReady')
  // Windows gives every window a native menu bar (File/Edit/View/Window) by
  // default. GitGlass ships its own UI, so remove it only there and keep the
  // native window controls intact.
  if (process.platform === 'win32') Menu.setApplicationMenu(null)
  if (process.env.GITGLASS_REPOSITORY && fs.existsSync(process.env.GITGLASS_REPOSITORY)) repoPath = path.resolve(process.env.GITGLASS_REPOSITORY)
  recentRepositories = new RecentRepositories(path.join(app.getPath('userData'), 'recent-repos.json'))
  updateStore = new UpdateStore(path.join(app.getPath('userData'), 'updates.json'))
  const resume = updateStore.value.resume
  // An update restart draft names the repository it belongs to, so it wins.
  if (!repoPath && typeof resume?.repoPath === 'string' && fs.existsSync(resume.repoPath)) repoPath = resume.repoPath
  // Otherwise fall back to the most recent repository that still exists on disk.
  if (!repoPath) repoPath = recentRepositories.list().find((candidate) => fs.existsSync(candidate)) ?? null
  startWatching(repoPath)
  const supported = app.isPackaged && process.platform === 'win32' && process.arch === 'x64' && fs.existsSync(path.join(process.resourcesPath, 'gitglass-installed'))
  updates = new UpdateService({
    updater: supported ? createWindowsUpdater({ NsisUpdater: require('electron-updater').NsisUpdater, app }) : null,
    store: updateStore,
    version: app.getVersion(),
    supported,
    reason: supported ? '' : !app.isPackaged ? '开发模式不检查更新。请使用 Windows 安装版体验应用内更新。' : '此版本暂不支持原地更新，请安装 Windows x64 安装版以启用应用内更新。',
    gate: operationGate,
    saveSession: (session) => {
      if (!session || typeof session.commitMessage !== 'string' || session.commitMessage.length > 65536 || typeof session.historyMode !== 'boolean') throw new Error('无法保存当前草稿，更新未开始。')
      updateStore.save({ resume: { repoPath, commitMessage: session.commitMessage, historyMode: session.historyMode } })
    },
    clearSession: () => updateStore.save({ resume: null }),
  })
  updates.on('state', (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:changed', state)
  })
  await updates.initialize()
  startupProbe('updates-ready')
  // Windows: the 48px renderer top bar doubles as the title bar while the
  // system keeps drawing native minimize/maximize/close through the Window
  // Controls Overlay (Snap Layouts included). macOS keeps its traffic lights.
  const titleBarOptions = process.platform === 'win32'
    ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#FFFFFF', symbolColor: '#344054', height: 48 } }
    : { titleBarStyle: 'hiddenInset' }
  const iconFile = process.platform === 'win32' ? 'icon.ico' : 'icon-256.png'
  mainWindow = new BrowserWindow({ width: 1500, height: 940, minWidth: 1024, minHeight: 680, backgroundColor: '#f7f8fa', icon: path.join(__dirname, '..', 'public', iconFile), ...titleBarOptions, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  startupProbe('window-created')
  // ready-to-show 是 BrowserWindow 的事件（不是 webContents 的）；did-finish-load 更稳定，
  // 两者都记，脚本优先用 ready-to-show，缺失时退到 did-finish-load。
  if (process.env.GITGLASS_STARTUP_PROBE) {
    const markRendered = (mark) => () => startupProbe(mark, { memory: app.getAppMetrics().map((metric) => ({ type: metric.type, workingSetKb: metric.memory.workingSetSize })) })
    mainWindow.once('ready-to-show', markRendered('ready-to-show'))
    mainWindow.webContents.once('did-finish-load', markRendered('did-finish-load'))
  }
  mainWindow.on('closed', () => stopWatching())
  const devUrl = process.env.VITE_DEV_SERVER_URL
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  if (devUrl) mainWindow.loadURL(devUrl)
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) mainWindow.show() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('will-quit', () => { updates?.dispose(); stopWatching() })

module.exports = { commandService, repository, isPath }
