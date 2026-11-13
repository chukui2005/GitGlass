const fs = require('node:fs')
const path = require('node:path')

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')

describe('Electron launch configuration', () => {
  it('removes the default application menu on Windows only', () => {
    expect(main).toContain("const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron')")
    expect(main).toContain("if (process.platform === 'win32') Menu.setApplicationMenu(null)")
  })

  it('uses the Windows Window Controls Overlay with a 48px custom title bar', () => {
    expect(main).toContain("titleBarStyle: 'hidden', titleBarOverlay: { color: '#F7F8FA', symbolColor: '#344054', height: 48 }")
  })

  it('keeps the native traffic lights on macOS and never goes frameless', () => {
    expect(main).toContain("titleBarStyle: 'hiddenInset'")
    // Native minimize/maximize/close stay owned by the system (Snap Layouts included).
    expect(main).not.toContain('frame: false')
  })

  it('keeps the minimum window size and brands the window with the platform icon', () => {
    expect(main).toMatch(/minWidth:\s*1024/)
    expect(main).toMatch(/minHeight:\s*680/)
    expect(main).toContain("const iconFile = process.platform === 'win32' ? 'icon.ico' : 'icon-256.png'")
  })

  it('classifies repository location as a read-only system record', () => {
    expect(main).toContain("argv: ['rev-parse', '--show-toplevel'], intent: 'Resolve repository root', source: 'background'")
  })
})
