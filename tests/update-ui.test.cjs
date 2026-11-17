const { execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

function runProbe(name) {
  const root = path.join(__dirname, '..')
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-update-probe-'))
  try {
    return execFileSync(require('electron'), [path.join(__dirname, 'support', name)], {
      cwd: root, encoding: 'utf8', timeout: 90_000, windowsHide: true,
      env: { ...process.env, GITGLASS_UPDATE_TEST_DIRECTORY: temporary },
    })
  } finally {
    // The child has exited, so Chromium no longer holds the profile files open.
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

describe('update panel in an isolated Electron window', () => {
  it('restores the draft, shows progress and ready status, contains keyboard actions and permits installation retry', () => {
    const root = path.join(__dirname, '..')
    // Always render current source, rather than a stale ignored local dist/.
    execFileSync(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], { cwd: root, env: { ...process.env, NODE_ENV: 'production' }, windowsHide: true, timeout: 90_000 })
    const output = runProbe('update-ui.cjs')
    expect(output).toContain('[UPDATE-UI] ')
  }, 120_000)

  it('launches the real isolated main/preload pair and keeps unsupported installation disabled', () => {
    const output = runProbe('update-main.cjs')
    expect(output).toContain('[UPDATE-MAIN] ')
  }, 90_000)

  it('downloads with the actual updater, restores the verified package offline and hands off only on request', () => {
    const output = runProbe('update-download.cjs')
    expect(output).toContain('[UPDATE-DOWNLOAD] ')
  }, 90_000)
})
