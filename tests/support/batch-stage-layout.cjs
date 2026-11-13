// 在真实 Chromium 中测量批量暂存工具栏与文件行的计算布局，
// 供 tests/batch-stage-layout.test.cjs 断言。
// 以 Electron 主进程方式运行：npx electron tests/support/batch-stage-layout.cjs
// 窗口不显示，只加载 tests/support/batch-stage-fixture.html + 正式 CSS。
// 复用同一个窗口、只调整尺寸，避免反复导航导致 file:// 加载被取消。
const { app, BrowserWindow } = require('electron')
const path = require('node:path')

const widths = [1024, 1280, 1440]
const fixture = path.join(__dirname, 'batch-stage-fixture.html')

const measure = `(() => {
  const box = (el) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
  }
  const readRow = (row) => {
    const check = row.querySelector('.stage-check')
    const select = row.querySelector('.file-select')
    const action = row.querySelector('.row-action')
    const path = row.querySelector('.file-path')
    return {
      name: row.dataset.row,
      row: box(row),
      check: check ? box(check) : null,
      select: box(select),
      action: action ? box(action) : null,
      path: path ? { ...box(path), whiteSpace: getComputedStyle(path).whiteSpace } : null,
      scrollWidth: row.scrollWidth,
      clientWidth: row.clientWidth,
    }
  }
  const toolbar = document.querySelector('.batch-toolbar')
  const toolsRow = document.querySelector('.batch-tools-row')
  const stageRow = document.querySelector('.batch-stage-row')
  const count = document.querySelector('.batch-count')
  const stage = document.querySelector('.batch-stage')
  return {
    viewport: document.documentElement.clientWidth,
    sidebar: box(document.querySelector('.status-panel')),
    toolbar: { box: box(toolbar), scrollWidth: toolbar.scrollWidth, clientWidth: toolbar.clientWidth },
    toolsRow: { box: box(toolsRow), scrollWidth: toolsRow.scrollWidth, clientWidth: toolsRow.clientWidth },
    stageRow: { box: box(stageRow), scrollWidth: stageRow.scrollWidth, clientWidth: stageRow.clientWidth },
    count: box(count),
    stage: { ...box(stage), whiteSpace: getComputedStyle(stage).whiteSpace },
    rows: [...document.querySelectorAll('.file-row')].map(readRow),
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
