const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { NsisUpdater } = require('electron-updater')
const { HttpError } = require('electron-updater/node_modules/builder-util-runtime')
const { createWindowsUpdater, sha512, legacyReleaseVersion } = require('../../electron/windows-updater.cjs')
const { UpdateStore } = require('../../electron/update-store.cjs')

const directories = []
function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-updater-'))
  directories.push(directory)
  return directory
}
afterEach(() => { while (directories.length) fs.rmSync(directories.pop(), { force: true, recursive: true }) })

async function fixture() {
  const root = temporaryDirectory()
  const configFile = path.join(root, 'app-update.yml')
  fs.writeFileSync(configFile, 'updaterCacheDirName: gitglass-test\n')
  const adapter = { version: '0.5.6-beta.1', name: 'GitGlass', baseCachePath: root, userDataPath: root, appUpdateConfigPath: configFile, isPackaged: true, whenReady: async () => {} }
  class TestNsisUpdater extends NsisUpdater { constructor() { super(null, adapter) } }
  const app = { quit: vi.fn() }
  const updater = createWindowsUpdater({ NsisUpdater: TestNsisUpdater, app, executable: path.join(root, 'GitGlass.exe'), resourcesPath: path.join(root, 'resources') })
  updater.logger = { info() {}, warn() {}, error() {} }
  const pending = path.join(root, 'gitglass-test', 'pending')
  fs.mkdirSync(pending, { recursive: true })
  const fileName = 'GitGlass-Setup-0.5.7-beta.1-x64.exe'
  const file = path.join(pending, fileName)
  fs.writeFileSync(file, 'MZ test package — never executed')
  const fileInfo = { url: fileName, sha512: await sha512(file) }
  const snapshot = { fileName, fileInfo, updateInfo: { version: '0.5.7-beta.1', files: [fileInfo], releaseNotes: '测试更新' } }
  updater.spawnLog = vi.fn(async () => true)
  return { root, updater, app, snapshot, file }
}

describe('pinned electron-updater integration', () => {
  async function githubWithoutManifest(version) {
    const result = await fixture()
    result.updater.autoDownload = false
    result.updater.allowPrerelease = true
    result.updater.httpExecutor = { request: vi.fn(async (options) => {
      if (options.path === '/chukui2005/GitGlass/releases.atom') {
        return `<feed><entry><title>Release</title><link href="https://github.com/chukui2005/GitGlass/releases/tag/v${version}"/><content>Release notes</content></entry></feed>`
      }
      throw new HttpError(404, 'Not Found')
    }) }
    result.updater.setFeedURL({ provider: 'github', owner: 'chukui2005', repo: 'GitGlass', private: false })
    return result
  }

  it('recognizes an equal legacy release without a manifest using the real GitHub provider', async () => {
    const { updater } = await githubWithoutManifest('0.5.6-beta.1')
    const result = await updater.checkForUpdates()
    expect(result).toMatchObject({ isUpdateAvailable: false, updateInfo: { version: '0.5.6-beta.1' } })
    expect(updater.httpExecutor.request).toHaveBeenCalledTimes(3)
  })

  it('recognizes an older legacy release without fabricating downloadable metadata', async () => {
    const { updater } = await githubWithoutManifest('0.5.5')
    expect(await updater.checkForUpdates()).toMatchObject({ isUpdateAvailable: false, updateInfo: { files: [] } })
  })

  it('keeps a missing-manifest error for a genuinely newer release', async () => {
    const { updater } = await githubWithoutManifest('0.5.7-beta.1')
    await expect(updater.checkForUpdates()).rejects.toMatchObject({ code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' })
  })

  it('never uses another repository, malformed version or a transport error as proof of no updates', () => {
    const missing = (url) => ({ code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', message: `Cannot find latest.yml (${url}): not found` })
    expect(legacyReleaseVersion(missing('https://github.com/other/repo/releases/download/v0.5.6-beta.1/latest.yml'))).toBeNull()
    expect(legacyReleaseVersion(missing('https://github.com/chukui2005/GitGlass/releases/download/not-a-version/latest.yml'))).toBeNull()
    expect(legacyReleaseVersion({ code: 'ETIMEDOUT', message: 'https://github.com/chukui2005/GitGlass/releases/download/v0.5.6-beta.1/latest.yml' })).toBeNull()
  })

  it('restores and snapshots a verified offline installer using the real cache implementation', async () => {
    const { updater, snapshot } = await fixture()
    await updater.restore(snapshot)
    expect(await updater.snapshot()).toEqual(snapshot)
  })

  it('rechecks integrity and refuses path traversal or a different publisher', async () => {
    const { updater, snapshot, file } = await fixture()
    fs.appendFileSync(file, 'corrupted')
    await expect(updater.restore(snapshot)).rejects.toThrow('校验失败')
    await expect(updater.restore({ ...snapshot, fileName: '../../outside.exe' })).rejects.toThrow('文件名无效')
    snapshot.fileInfo.sha512 = await sha512(file)
    updater.verifySignature = async () => 'wrong publisher'
    await expect(updater.restore(snapshot)).rejects.toThrow('签名校验失败')
  })

  it('waits for installer process creation, preserves the installation directory and then quits', async () => {
    const { updater, snapshot, app, root, file } = await fixture()
    await updater.restore(snapshot)
    let finish
    updater.spawnLog.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const install = updater.installPreparedUpdate()
    await new Promise((resolve) => setImmediate(resolve))
    expect(app.quit).not.toHaveBeenCalled()
    expect(updater.spawnLog).toHaveBeenCalledWith(file, ['--updated', '/S', '--force-run', `/D=${root}`])
    finish(true); await install
    expect(app.quit).toHaveBeenCalledOnce()
  })

  it('does not quit the app when the installer cannot be started', async () => {
    const { updater, snapshot, app } = await fixture()
    await updater.restore(snapshot)
    updater.spawnLog.mockRejectedValue(Object.assign(new Error('cannot start'), { code: 'ENOENT' }))
    await expect(updater.installPreparedUpdate()).rejects.toThrow('cannot start')
    expect(app.quit).not.toHaveBeenCalled()
  })
})

describe('update preferences and restart state', () => {
  it('persists preferences, package metadata and drafts together and tolerates corrupted JSON', () => {
    const file = path.join(temporaryDirectory(), 'updates.json')
    const store = new UpdateStore(file)
    store.save({ automatic: false, resume: { repoPath: '/test/repo', commitMessage: '草稿', historyMode: true } })
    expect(new UpdateStore(file).value).toEqual(store.value)
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
    fs.writeFileSync(file, 'not json')
    expect(new UpdateStore(file).value).toEqual({ automatic: true, pending: null, resume: null })
  })
})
