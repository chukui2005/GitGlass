// 在真实 Chromium 中测量提交行的计算布局，供 tests/history-row-layout.test.cjs 断言。
// 以 Electron 主进程方式运行：npx electron tests/support/history-row-layout.cjs
// 窗口不显示，不加载仓库数据，只加载 tests/support/layout-fixture.html + 正式 CSS。
// 复用同一个窗口、只调整尺寸，避免反复导航导致 file:// 加载被取消。
const { app, BrowserWindow } = require('electron')
const path = require('node:path')

const widths = [1024, 1280, 1440]
const fixture = path.join(__dirname, 'layout-fixture.html')

const measure = `(() => {
  const box = (el) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
  }
  const read = (row) => {
    const pin = row.querySelector('.compare-pin')
    const select = row.querySelector('.commit-select')
    const style = getComputedStyle(row)
    return {
      name: row.dataset.row,
      display: style.display,
      align: style.alignItems,
      columnCount: style.gridTemplateColumns.split(' ').filter(Boolean).length,
      scrollWidth: row.scrollWidth,
      clientWidth: row.clientWidth,
      row: box(row),
      pin: pin ? { ...box(pin), whiteSpace: getComputedStyle(pin).whiteSpace } : null,
      select: box(select),
      title: box(row.querySelector('.commit-title')),
      meta: box(row.querySelector('.commit-meta')),
    }
  }
  return {
    viewport: document.documentElement.clientWidth,
    rows: [...document.querySelectorAll('.history-row')].map(read),
  }
})()`

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const results = []
  const win = new BrowserWindow({ show: false, width: widths[0], height: 820, useContentSize: true, paintWhenInitiallyHidden: true })
  try {
    await win.loadFile(fixture)
    for (const width of widths) {
      win.setContentSize(width, 820)
      // 让媒体查询与布局稳定下来，再读取计算值。
      await delay(120)
      await win.webContents.executeJavaScript('document.body.offsetHeight')
      const data = await win.webContents.executeJavaScript(measure)
      results.push({ width, ...data })
    }
    console.log('[LAYOUT] ' + JSON.stringify(results))
  } catch (error) {
    console.log('[LAYOUT-ERROR] ' + (error && error.message))
  } finally {
    win.destroy()
  }
  app.exit(0)
})
