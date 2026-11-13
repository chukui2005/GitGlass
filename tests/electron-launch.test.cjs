const fs = require('node:fs')
const path = require('node:path')

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')

describe('Electron launch configuration', () => {
  it('removes the default application menu on Windows only', () => {
    expect(main).toContain("const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron')")
    expect(main).toContain("if (process.platform === 'win32') Menu.setApplicationMenu(null)")
  })

  it('keeps the native window controls and the minimum window size', () => {
    // Hiding the menu must not come from a frameless or CSS-covered window.
    expect(main).not.toContain('frame: false')
    expect(main).toMatch(/minWidth:\s*1024/)
    expect(main).toMatch(/minHeight:\s*680/)
  })

  it('classifies repository location as a read-only system record', () => {
    expect(main).toContain("argv: ['rev-parse', '--show-toplevel'], intent: 'Resolve repository root', source: 'background'")
  })

  it('brands the window with the GitGlass icon', () => {
    expect(main).toMatch(/icon:\s*path\.join\(__dirname,\s*'\.\.',\s*'public',\s*'icon-256\.png'\)/)
  })
})
