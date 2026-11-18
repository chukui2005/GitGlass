const { execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

function runProbe(name) {
  const root = path.join(__dirname, '..', '..')
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-recent-probe-'))
  try {
    return execFileSync(require('electron'), [path.join(__dirname, '..', 'support', name)], {
      cwd: root, encoding: 'utf8', timeout: 90_000, windowsHide: true,
      env: { ...process.env, GITGLASS_RECENT_UI_DIRECTORY: temporary },
    })
  } finally {
    // The child has exited, so Chromium no longer holds the profile files open.
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

describe('recent repositories switcher in an isolated Electron window', () => {
  it('renders the remembered repositories, marks the current and missing ones and keeps keyboard and removal working', () => {
    const root = path.join(__dirname, '..', '..')
    // Always render current source, rather than a stale ignored local dist/.
    execFileSync(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], { cwd: root, env: { ...process.env, NODE_ENV: 'production' }, windowsHide: true, timeout: 90_000 })
    const output = runProbe('recent-repositories-ui.cjs')
    expect(output).toContain('[RECENT-UI] ')
  }, 120_000)
})
