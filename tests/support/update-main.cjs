const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')

const temporary = process.env.GITGLASS_UPDATE_TEST_DIRECTORY || fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-update-main-'))
app.setPath('userData', temporary)
app.disableHardwareAcceleration()
delete process.env.GITGLASS_REPOSITORY
delete process.env.VITE_DEV_SERVER_URL
require('../../electron/main.cjs')

app.whenReady().then(async () => {
  try {
    let window
    for (let attempt = 0; attempt < 100; attempt++) {
      window = BrowserWindow.getAllWindows()[0]
      if (window && !window.webContents.isLoading()) break
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    assert.ok(window)
    assert.equal(app.hasSingleInstanceLock(), true)
    const result = await window.webContents.executeJavaScript(`(async () => {
      const state = await window.gitglass.getUpdateState();
      const repository = await window.gitglass.getState();
      await window.gitglass.setAutomaticUpdates(false);
      const settings = await window.gitglass.getUpdateState();
      const installation = await window.gitglass.installUpdate({ commitMessage: '草稿', historyMode: false });
      return { state, settings, repository, installation, resume: await window.gitglass.getUpdateResume() };
    })()`)
    assert.equal(result.state.supported, false)
    assert.equal(result.state.phase, 'unsupported')
    assert.equal(result.settings.automatic, false)
    assert.equal(result.installation.ok, false)
    assert.equal(result.resume, null)
    assert.equal(typeof result.repository.ok, 'boolean')
    const url = window.webContents.getURL()
    await window.webContents.executeJavaScript(`location.href = 'https://example.invalid/'; undefined`)
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(window.webContents.getURL(), url)
    console.log('[UPDATE-MAIN] ' + JSON.stringify({ ipc: true, unsupported: true, settings: true, navigationBlocked: true }))
    app.exit(0)
  } catch (error) {
    console.error('[UPDATE-MAIN-ERROR] ' + error.stack)
    app.exit(1)
  }
}).finally(() => { try { fs.rmSync(temporary, { recursive: true, force: true }) } catch {} })
