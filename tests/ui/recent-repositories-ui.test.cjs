const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { buildApplication, runElectronProbe } = require(path.join(__dirname, '..', 'support', 'probe-runner.cjs'))

function runProbe(name, marker) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-recent-probe-'))
  try {
    return runElectronProbe(name, { marker, env: { GITGLASS_RECENT_UI_DIRECTORY: temporary } })
  } finally {
    // The child has exited, so Chromium no longer holds the profile files open.
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

describe('recent repositories switcher in an isolated Electron window', () => {
  it('renders the remembered repositories, marks the current and missing ones and keeps keyboard and removal working', () => {
    // Always render current source, rather than a stale ignored local dist/.
    buildApplication()
    const output = runProbe('recent-repositories-ui.cjs', '[RECENT-UI] ')
    expect(output).toContain('[RECENT-UI] ')
  }, 120_000)
})
