const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { buildApplication, runElectronProbe } = require(path.join(__dirname, '..', 'support', 'probe-runner.cjs'))

function runProbe(name, marker) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-update-probe-'))
  try {
    return runElectronProbe(name, { marker, env: { GITGLASS_UPDATE_TEST_DIRECTORY: temporary } })
  } finally {
    // The child has exited, so Chromium no longer holds the profile files open.
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

describe('update panel in an isolated Electron window', () => {
  it('restores the draft, shows progress and ready status, contains keyboard actions and permits installation retry', () => {
    // Always render current source, rather than a stale ignored local dist/.
    buildApplication()
    const output = runProbe('update-ui.cjs', '[UPDATE-UI] ')
    expect(output).toContain('[UPDATE-UI] ')
  }, 120_000)

  it('launches the real isolated main/preload pair and keeps unsupported installation disabled', () => {
    const output = runProbe('update-main.cjs', '[UPDATE-MAIN] ')
    expect(output).toContain('[UPDATE-MAIN] ')
  }, 90_000)

  it('downloads with the actual updater, restores the verified package offline and hands off only on request', () => {
    const output = runProbe('update-download.cjs', '[UPDATE-DOWNLOAD] ')
    expect(output).toContain('[UPDATE-DOWNLOAD] ')
  }, 90_000)
})
