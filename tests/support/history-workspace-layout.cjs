const { app, BrowserWindow } = require('electron')
const path = require('node:path')

const widths = [1024, 1280]
const fixture = path.join(__dirname, 'history-workspace-layout-fixture.html')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const results = []
  const win = new BrowserWindow({ show: false, width: widths[0], height: 820, useContentSize: true, paintWhenInitiallyHidden: true })
  try {
    await win.loadFile(fixture)
    for (const width of widths) {
      win.setContentSize(width, 820)
      await delay(120)
      results.push(await win.webContents.executeJavaScript(`(() => {
        const root = document.documentElement
        const shell = document.querySelector('.app-shell')
        const topbar = document.querySelector('.topbar')
        const right = document.querySelector('.context-panel').getBoundingClientRect()
        return { viewport: root.clientWidth, documentWidth: root.scrollWidth, shellWidth: shell.scrollWidth, shellClientWidth: shell.clientWidth, topbarWidth: topbar.scrollWidth, topbarClientWidth: topbar.clientWidth, rightEdge: right.right }
      })()`))
    }
    console.log('[LAYOUT] ' + JSON.stringify(results))
  } catch (error) {
    console.log('[LAYOUT-ERROR] ' + (error && error.message))
  } finally {
    win.destroy()
  }
  app.exit(0)
})
