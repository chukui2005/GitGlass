const { app, BrowserWindow, dialog, ipcMain, Menu, screen } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { GitCommandService } = require('./git-command-service.cjs')
const { RepositoryService, isPath, resolveGitDirectory } = require('./repository-service.cjs')
const { RepositoryWatcher } = require('./repository-watcher.cjs')
const { OperationGate } = require('./operation-gate.cjs')
const { UpdateStore } = require('./update-store.cjs')
const { UpdateService, pendingUpdateState } = require('./update-service.cjs')
const { createWindowsUpdater } = require('./windows-updater.cjs')
const { RecentRepositories, describeRecent } = require('./recent-repositories.cjs')
const { openRepositoryPath, MAX_REPOSITORY_PATH } = require('./repository-opener.cjs')
const { normalizeCloneRequest, prepareClone, executeClone } = require('./repository-cloner.cjs')
const { WindowStateStore, resolveLaunchBounds, trackWindowBounds } = require('./window-state.cjs')
// 启动探针（scripts/report-startup.mjs 用）：GITGLASS_STARTUP_PROBE 未设置时是空函数，
// 下面的 startupProbe() 调用在正常运行与打包产物里都不产生任何副作用。
const { createStartupProbe } = require('./startup-probe.cjs')
const startupProbe = createStartupProbe()

// Git commands that write the repository get a silent window in the watcher so
// GitGlass does not report its own writes back to the renderer as an external
// change.
const WATCH_SILENCE_MS = 1500
// Reads such as `repo:state` run `git status`, which may rewrite .git/index. The
// index events of our own command are never an external change, but HEAD/ref
// events still are, so reads silence only `index` instead of everything.
const WATCH_INDEX_SILENCE_MS = 1000
const REPOSITORY_WRITE_CHANNELS = new Set([
  'git:operate',
  'hunk:apply',
  'remote:execute',
  'branch:execute',
  'safety:discard:execute',
  'safety:branch-delete:execute',
  'recovery:rescue:execute',
  // 远程与上游：写 git 配置、创建本地分支、首次推送都会改仓库（推送还改远端）。
  'remote:config:execute',
  'remote:branch:execute',
  'remote:first-push:execute',
  // Clone writes a new folder next to (never inside) the open repository. It is
  // still a user write: silence the watcher so a target inside the open worktree
  // cannot report the clone back as an external change.
  'repo:clone:execute',
])

let mainWindow
let repoPath = null
let recentRepositories = null
let watcher = null
// Whether fs.watch actually watches the open repository. It fails silently on
// network drives and restricted filesystems, and the renderer needs to know
// because then automatic refresh never happens (issue #21).
let watcherActive = false
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
// Update service state. Constructing it needs `require('electron-updater')` plus an
// NsisUpdater instance (~35-48 ms measured), so it happens only after the window has
// started loading instead of before `new BrowserWindow()`: window creation no longer
// waits for update plumbing (measured 34-38 ms earlier; first paint is unchanged, see
// docs/size-and-performance.md 3.1). Requests that arrive earlier queue on
// `updatesReady`, and `update:state` answers with pendingUpdateState() until then.
let updates
/** @type {Promise<any> | null} */
let updatesReady = null
let quitting = false
let updateStore
const UPDATES_NOT_STARTED = '更新服务正在准备，请稍候。'

function assertMainFrame(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('无效的应用请求。')
  }
}

function stopWatching() {
  watcher?.close()
  watcher = null
}

function setWatcherStatus(active) {
  if (watcherActive === active) return
  watcherActive = active
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('watcher:changed', { active })
}

// Started whenever repoPath changes (startup restore and every openRepository()
// success) and stopped on window close, quit and repository switch, so a watcher
// never outlives the repository it points at.
function startWatching(repositoryPath) {
  stopWatching()
  if (!repositoryPath) return
  const gitDirectory = resolveGitDirectory(repositoryPath)
  if (!gitDirectory) return
  watcher = new RepositoryWatcher({ onError: () => setWatcherStatus(false) })
  // watch() returns false when no directory could be watched at all (sync
  // failure); async handle deaths arrive through onError above.
  const started = watcher.watch(gitDirectory, ({ reason }) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('repo:changed', { reason })
  })
  setWatcherStatus(started)
}

function handleRepository(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    assertMainFrame(event)
    const silenceOwnIndexWrites = () => watcher?.notifyIgnored(WATCH_INDEX_SILENCE_MS, { reasons: ['index'] })
    silenceOwnIndexWrites()
    if (!REPOSITORY_WRITE_CHANNELS.has(channel)) return operationGate.run(() => handler(event, ...args)).finally(silenceOwnIndexWrites)
    // Silent before and after: the command may take seconds (network) and the
    // watcher must not report the files it writes as an external change.
    watcher?.notifyIgnored(WATCH_SILENCE_MS)
    return operationGate.run(() => handler(event, ...args)).finally(() => {
      watcher?.notifyIgnored(WATCH_SILENCE_MS)
      silenceOwnIndexWrites()
    })
  })
}

function handleUpdate(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    assertMainFrame(event)
    return handler(...args)
  })
}

// Update requests must not touch the service before it exists. `update:state` answers
// with the placeholder so the renderer always gets a complete state; every other action
// queues on `updatesReady` (or fails fast when the service was never started).
function runUpdate(action) {
  return async (...args) => {
    if (!updatesReady) throw new Error(UPDATES_NOT_STARTED)
    const service = await updatesReady
    return action(service, ...args)
  }
}

function broadcastUpdateState(state) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const next = state ?? updates?.getState()
  if (next) mainWindow.webContents.send('update:changed', next)
}

handleUpdate('update:state', () => (updates ? updates.getState() : pendingUpdateState(app.getVersion())))
handleUpdate('update:check', runUpdate((service) => service.check()))
handleUpdate('update:download', runUpdate((service) => service.download()))
handleUpdate('update:automatic', runUpdate((service, value) => service.setAutomatic(value)))
handleUpdate('update:install', runUpdate((service, session) => service.install(session)))
handleUpdate('update:resume', () => {
  const resume = updateStore.value.resume
  return resume && typeof resume.commitMessage === 'string'
    ? { commitMessage: resume.commitMessage.slice(0, 65536), historyMode: resume.historyMode === true }
    : null
})
handleUpdate('update:resume-consumed', () => { updateStore.save({ resume: null }); return { ok: true } })

// Started only once the window has begun loading. `require('electron-updater')` plus the
// NsisUpdater instance costs 35-48 ms, and that used to sit between app.whenReady() and
// `new BrowserWindow()`, pushing window creation back by the same amount. initialize() is
// deliberately not awaited: `updatesReady` is what every update:* request queues on.
function startUpdateService() {
  if (updates || quitting || !updateStore) return
  const supported = app.isPackaged && process.platform === 'win32' && process.arch === 'x64' && fs.existsSync(path.join(process.resourcesPath, 'gitglass-installed'))
  const service = new UpdateService({
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
  updates = service
  // Registered before start(): initialize() can emit a 'ready' state while restoring a
  // cached download, and the renderer has to see it.
  service.on('state', broadcastUpdateState)
  // start() never rejects (it degrades to an unavailable state), so updatesReady cannot
  // leave an unhandled rejection behind; the catch is only a belt-and-braces guard.
  updatesReady = service.start()
    .catch(() => {})
    .then(() => {
      startupProbe('updates-ready')
      // initialize() only emits when it restores a cached download; otherwise the renderer
      // is still on pendingUpdateState(), so push the settled state once.
      broadcastUpdateState()
      return service
    })
}

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
// 克隆在两种状态下都可用，所以它的三个入口不依赖当前仓库：目录选择器只回传用户
// 选的父目录，计划和执行都由主进程校验后自己构造 argv、自己决定工作目录。
handleRepository('repo:clone:choose-target', async () => {
  const choice = await dialog.showOpenDialog(mainWindow, {
    title: '选择克隆的目标位置',
    buttonLabel: '选择此文件夹',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (choice.canceled || !choice.filePaths[0]) return { canceled: true }
  return { canceled: false, path: choice.filePaths[0] }
})
handleRepository('repo:clone:prepare', (_event, input) => {
  const request = normalizeCloneRequest(input)
  if (!request.ok) return { ok: false, blocked: true, reason: request.reason, plan: null, target: null }
  return prepareClone({ source: request.source, parent: request.parent, name: request.name, commandService })
})
handleRepository('repo:clone:execute', async (_event, input) => {
  const request = normalizeCloneRequest(input, { allowOperationId: true })
  if (!request.ok) return { ok: false, blocked: true, reason: request.reason, plan: null, target: null, execution: null }
  const cloned = await executeClone({
    source: request.source,
    parent: request.parent,
    name: request.name,
    commandService,
    operationId: request.operationId,
  })
  if (!cloned.ok) return cloned
  // 克隆成功只说明目录里有了一个仓库：仍然走既有的打开流程（rev-parse 校验真实根目录、
  // 写入最近仓库）并让 watcher 跟着切换。
  const opened = await openRepository(cloned.target)
  if (!opened.ok) {
    return { ...cloned, ok: false, message: opened.message, reason: opened.message || '克隆已完成，但无法打开该仓库。' }
  }
  return { ...opened, target: cloned.target, plan: cloned.plan, execution: cloned.execution, openExecution: opened.execution }
})
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
handleRepository('repo:staged-overview', () => repository.stagedOverview())
// Cheap local read (no gate): the renderer polls this once on mount and then
// follows the watcher:changed pushes to know whether automatic refresh lives.
handleUpdate('watcher:state', () => ({ active: watcherActive }))
handleRepository('repo:diff', (_event, file) => repository.diff(file))
handleRepository('repo:ledger', () => commandService.history())
handleRepository('repo:branches', () => repository.branches())
handleRepository('repo:commits', () => repository.commits())
handleRepository('history:query', (_event, filters) => repository.queryHistory(filters))
handleRepository('history:refs', () => repository.refs())
handleRepository('history:commit', (_event, sha) => repository.commitBySha(sha))
handleRepository('history:detail', (_event, sha) => repository.commitDetail(sha))
handleRepository('history:diff', (_event, sha) => repository.commitDiff(sha))
handleRepository('history:compare', (_event, baseSha, targetSha) => repository.compareCommits(baseSha, targetSha))
handleRepository('history:file', (_event, filePath) => repository.fileHistory(filePath))
handleRepository('history:file-diff', (_event, sha, filePath) => repository.fileCommitDiff(sha, filePath))
handleRepository('branch:prepare', (_event, branch, create) => repository.prepareSwitch(branch, Boolean(create)))
handleRepository('branch:execute', (_event, branch, create, operationId) => repository.executeSwitch(branch, Boolean(create), operationId))
handleRepository('remote:overview', () => repository.remoteOverview())
handleRepository('remote:branches', () => repository.remoteBranches())
// 远程配置、远程跟踪分支的检出/上游、首次推送：一条 prepare 一条 execute，
// 每个 kind 只对应一条固定命令，argv 全部由主进程构造。
handleRepository('remote:config:prepare', (_event, kind, request) => repository.prepareRemoteConfig(kind, request))
handleRepository('remote:config:execute', (_event, kind, request, operationId) => repository.executeRemoteConfig(kind, request, operationId))
handleRepository('remote:branch:prepare', (_event, kind, remoteBranch, localName) =>
  kind === 'set-upstream' ? repository.prepareSetUpstream(remoteBranch) : repository.prepareCheckoutRemote(remoteBranch, localName))
handleRepository('remote:branch:execute', (_event, kind, remoteBranch, localName, operationId) =>
  kind === 'set-upstream' ? repository.executeSetUpstream(remoteBranch, operationId) : repository.executeCheckoutRemote(remoteBranch, localName, operationId))
handleRepository('remote:first-push:prepare', (_event, request) => repository.prepareFirstPush(request))
handleRepository('remote:first-push:execute', (_event, request, operationId) => repository.executeFirstPush(request, operationId))
handleRepository('remote:prepare', (_event, kind) => repository.prepareRemote(kind))
handleRepository('remote:execute', (_event, kind, operationId) => repository.executeRemote(kind, operationId))
handleRepository('safety:discard:prepare', (_event, filePath) => repository.prepareDiscard(filePath))
handleRepository('safety:discard:execute', (_event, filePath, operationId) => repository.executeDiscard(filePath, operationId))
handleRepository('safety:branch-delete:prepare', (_event, branch) => repository.prepareDeleteMergedBranch(branch))
handleRepository('safety:branch-delete:execute', (_event, branch, operationId) => repository.executeDeleteMergedBranch(branch, operationId))
handleRepository('recovery:reflog', () => repository.reflog())
handleRepository('recovery:rescue:prepare', (_event, hash, branch) => repository.prepareRescueBranch(hash, branch))
handleRepository('recovery:rescue:execute', (_event, hash, branch, operationId) => repository.executeRescueBranch(hash, branch, operationId))
// 按块操作只有一个入口：方向 + 界面读取时下发的块标识。渲染层不能提供
// 命令、补丁或仓库路径；主进程重新读取真实 Diff 后自行构造补丁。
handleRepository('hunk:apply', (_event, direction, locator) => {
  if (direction === 'stage') return repository.stageHunk(locator)
  if (direction === 'unstage') return repository.unstageHunk(locator)
  return Promise.resolve({ ok: false, direction: '', area: '', path: '', hunk: null, execution: null, record: null, state: null, reason: '不支持的 Diff 块操作。' })
})
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
  // Window bounds live next to the other userData stores; `screen` is safe
  // here because the whole block runs inside app.whenReady().
  const windowState = new WindowStateStore(path.join(app.getPath('userData'), 'window-state.json'))
  const resume = updateStore.value.resume
  // An update restart draft names the repository it belongs to, so it wins.
  if (!repoPath && typeof resume?.repoPath === 'string' && fs.existsSync(resume.repoPath)) repoPath = resume.repoPath
  // Otherwise fall back to the most recent repository that still exists on disk.
  if (!repoPath) repoPath = recentRepositories.list().find((candidate) => fs.existsSync(candidate)) ?? null
  startWatching(repoPath)
  // Windows: the 48px renderer top bar doubles as the title bar while the
  // system keeps drawing native minimize/maximize/close through the Window
  // Controls Overlay (Snap Layouts included). macOS keeps its traffic lights.
  /** @type {import('electron').BrowserWindowConstructorOptions} */
  const titleBarOptions = process.platform === 'win32'
    ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#FFFFFF', symbolColor: '#344054', height: 48 } }
    : { titleBarStyle: 'hiddenInset' }
  const iconFile = process.platform === 'win32' ? 'icon.ico' : 'icon-256.png'
  // Launch bounds come from userData/window-state.json when they still fit a
  // display; otherwise the window falls back to a work-area-relative default
  // size, centered (issue #19: the old fixed 1500×940 overflowed 1366×768
  // laptops and user resizes were forgotten on every launch).
  const launchBounds = resolveLaunchBounds(windowState.value, {
    primaryWorkArea: screen.getPrimaryDisplay().workArea,
    workAreas: screen.getAllDisplays().map((display) => display.workArea),
    minWidth: 1024,
    minHeight: 680,
  })
  mainWindow = new BrowserWindow({ ...launchBounds, minWidth: 1024, minHeight: 680, backgroundColor: '#f7f8fa', icon: path.join(__dirname, '..', 'public', iconFile), ...titleBarOptions, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  trackWindowBounds(mainWindow, windowState)
  startupProbe('window-created')
  // ready-to-show 是 BrowserWindow 的事件（不是 webContents 的）；did-finish-load 更稳定，
  // 两者都记，脚本优先用 ready-to-show，缺失时退到 did-finish-load。
  if (process.env.GITGLASS_STARTUP_PROBE) {
    const markRendered = (mark) => () => startupProbe(mark, { memory: app.getAppMetrics().map((metric) => ({ type: metric.type, workingSetKb: metric.memory.workingSetSize })) })
    mainWindow.once('ready-to-show', markRendered('ready-to-show'))
    mainWindow.webContents.once('did-finish-load', async () => {
      markRendered('did-finish-load')()
      // 外壳冒烟测试（tests/ui/electron-shell.test.cjs）需要只能在真实打包产物上验证的
      // 事实：exe 名（不是 electron.exe）、打包版本、无原生菜单、自绘标题栏，以及渲染层
      // 自己确认的 Window Controls Overlay 可见性。任何失败都写进探针文件——静默吞掉
      // 会让冒烟测试只留下一个 60s 超时（第一次实现就踩过：getTitleBarStyle 不存在）。
      try {
        const overlayVisible = await mainWindow.webContents.executeJavaScript('navigator.windowControlsOverlay ? navigator.windowControlsOverlay.visible : null')
        startupProbe('shell-facts', {
          shell: {
            version: app.getVersion(),
            isPackaged: app.isPackaged,
            exeName: path.basename(app.getPath('exe')),
            hasApplicationMenu: Menu.getApplicationMenu() !== null,
            titleBarStyle: titleBarOptions.titleBarStyle,
            overlayVisible,
          },
        })
      } catch (error) {
        startupProbe('shell-facts-error', { error: String((error && error.message) || error) })
      }
    })
  }
  mainWindow.on('closed', () => stopWatching())
  const devUrl = process.env.VITE_DEV_SERVER_URL
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  // The update service starts after the page has begun loading (loadFile resolves at
  // did-finish-load, rejects on did-fail-load): either way nothing may leave update:*
  // requests queued forever.
  const pageLoaded = devUrl ? mainWindow.loadURL(devUrl) : mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  pageLoaded.then(startUpdateService, startUpdateService)
  // 兜底：万一页面既不成功也不失败地卡住，10 秒后照样把更新服务拉起来，
  // 否则 update:* 请求会一直停在「正在准备更新服务」。
  setTimeout(startUpdateService, 10_000).unref()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) mainWindow.show() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('will-quit', () => { quitting = true; updates?.dispose(); stopWatching() })

module.exports = { commandService, repository, isPath }
