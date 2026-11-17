const { app } = require('electron')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { NsisUpdater } = require('electron-updater')
const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor')
const { createWindowsUpdater } = require('../../electron/windows-updater.cjs')
const { UpdateService } = require('../../electron/update-service.cjs')
const { UpdateStore } = require('../../electron/update-store.cjs')
const { OperationGate } = require('../../electron/operation-gate.cjs')

const root = process.env.GITGLASS_UPDATE_TEST_DIRECTORY || fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-update-download-'))
app.setPath('userData', root)
app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  let server, service
  try {
    const version = '0.5.7-beta.1'
    const name = `GitGlass-Setup-${version}-x64.exe`
    // A dummy signed-feed payload is downloaded and hashed, never executed.
    const payload = Buffer.from('MZ' + 'test-installer-not-executable'.repeat(8192))
    const digest = createHash('sha512').update(payload).digest('base64')
    const manifest = `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${digest}\n    size: ${payload.length}\npath: ${name}\nsha512: ${digest}\n`
    const requests = []
    server = http.createServer((request, response) => {
      requests.push(request.url)
      const body = request.url.split('?')[0].endsWith('.yml') ? Buffer.from(manifest) : payload
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length })
      response.end(body)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const config = path.join(root, 'app-update.yml')
    fs.writeFileSync(config, 'updaterCacheDirName: update-test\n')
    const appAdapter = { version: '0.5.6-beta.1', name: 'GitGlass', baseCachePath: root, userDataPath: root, appUpdateConfigPath: config, isPackaged: true, whenReady: () => app.whenReady() }
    class TestNsisUpdater extends NsisUpdater {
      constructor() { super(null, appAdapter); this.httpExecutor = new ElectronHttpExecutor() }
    }
    let quits = 0, spawns = 0
    const makeUpdater = () => {
      const updater = createWindowsUpdater({ NsisUpdater: TestNsisUpdater, app: { quit: () => { quits++ } }, executable: path.join(root, 'GitGlass.exe') })
      updater.logger = { info() {}, warn() {}, error() {}, debug() {} }
      updater.disableDifferentialDownload = true
      updater.spawnLog = async () => { spawns++; return true }
      return updater
    }
    const updater = makeUpdater()
    updater.setFeedURL({ provider: 'generic', url: `http://127.0.0.1:${server.address().port}` })
    const storeFile = path.join(root, 'updates.json')
    const createService = (client, store) => new UpdateService({ updater: client, store, supported: true, version: appAdapter.version, gate: new OperationGate(), saveSession: (resume) => store.save({ resume }), clearSession: () => store.save({ resume: null }) })
    service = createService(updater, new UpdateStore(storeFile))
    const downloaded = await service.check()
    assert.equal(downloaded.phase, 'ready', downloaded.error)
    assert.ok(requests.some((request) => request.includes('.yml')))
    assert.ok(requests.some((request) => request.includes(name)))
    assert.equal(spawns, 0)
    assert.equal(quits, 0)
    service.dispose()
    await new Promise((resolve) => server.close(resolve))
    server = null
    const count = requests.length
    const restoredStore = new UpdateStore(storeFile)
    service = createService(makeUpdater(), restoredStore)
    await service.initialize()
    assert.equal(service.getState().phase, 'ready')
    const session = { commitMessage: '离线更新草稿', historyMode: false }
    assert.equal((await service.install(session)).ok, true)
    assert.deepEqual(new UpdateStore(storeFile).value.resume, session)
    assert.equal(requests.length, count)
    assert.equal(spawns, 1)
    assert.equal(quits, 1)
    console.log('[UPDATE-DOWNLOAD] ' + JSON.stringify({ realDownload: true, verifiedCache: true, offlineInstallHandoff: true }))
    service.dispose()
    app.exit(0)
  } catch (error) {
    console.error('[UPDATE-DOWNLOAD-ERROR] ' + error.stack)
    service?.dispose()
    server?.close()
    app.exit(1)
  }
})
