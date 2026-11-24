// 在真实 Chromium 中测量批量暂存工具栏、文件行与右栏两段的计算布局，
// 供 tests/ui/batch-stage-layout.test.cjs 断言。
// 以 Electron 主进程方式运行：npx electron tests/support/batch-stage-layout.cjs
// 窗口不显示，只加载 tests/support/batch-stage-fixture.html + 正式 CSS。
// 复用同一个窗口、只调整尺寸，避免反复导航导致 file:// 加载被取消。
const { app, BrowserWindow } = require('electron')
const path = require('node:path')

const widths = [1024, 1280, 1440]
const fixture = path.join(__dirname, 'batch-stage-fixture.html')

const measure = `(() => {
  const box = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
  }
  const readRow = (row) => {
    const check = row.querySelector('.stage-check')
    const select = row.querySelector('.file-select')
    const action = row.querySelector('.row-action')
    const name = row.querySelector('.file-name')
    const dir = row.querySelector('.file-dir')
    const status = row.querySelector('.status')
    return {
      rowName: row.dataset.row,
      row: box(row),
      check: box(check),
      select: box(select),
      action: box(action),
      name: name ? { ...box(name), whiteSpace: getComputedStyle(name).whiteSpace, overflow: getComputedStyle(name).textOverflow } : null,
      dir: dir ? { ...box(dir), whiteSpace: getComputedStyle(dir).whiteSpace } : null,
      status: status ? { ...box(status), text: status.textContent } : null,
      scrollWidth: row.scrollWidth,
      clientWidth: row.clientWidth,
      borderLeft: getComputedStyle(row).boxShadow,
      background: getComputedStyle(row).backgroundColor,
    }
  }
  const toolbar = document.querySelector('.batch-toolbar')
  const toolsRow = document.querySelector('.batch-tools-row')
  const stageRow = document.querySelector('.batch-stage-row')
  const selectAll = document.querySelector('.batch-tool')
  const stage = document.querySelector('.batch-stage')
  const count = document.querySelector('.batch-count')
  const clear = document.querySelector('.batch-clear')
  const title = document.querySelector('.diff-title')
  const breadcrumb = document.querySelector('.path-breadcrumb')
  const titleMeta = document.querySelector('.diff-title-meta')
  const contextPanel = document.querySelector('.context-panel')
  const currentFile = document.querySelector('.current-file')
  const commitPanel = document.querySelector('.commit-panel')
  const selectedRow = document.querySelector('.file-row')
  return {
    viewport: document.documentElement.clientWidth,
    sidebar: box(document.querySelector('.status-panel')),
    toolbar: { box: box(toolbar), scrollWidth: toolbar.scrollWidth, clientWidth: toolbar.clientWidth },
    toolsRow: { box: box(toolsRow), scrollWidth: toolsRow.scrollWidth, clientWidth: toolsRow.clientWidth },
    stageRow: { box: box(stageRow), scrollWidth: stageRow.scrollWidth, clientWidth: stageRow.clientWidth },
    selectAll: box(selectAll),
    count: box(count),
    clear: box(clear),
    stage: { ...box(stage), whiteSpace: getComputedStyle(stage).whiteSpace },
    rows: [...document.querySelectorAll('.file-row')].map(readRow),
    firstRow: selectedRow ? { height: selectedRow.getBoundingClientRect().height } : null,
    title: {
      box: box(title),
      scrollWidth: title.scrollWidth,
      clientWidth: title.clientWidth,
      breadcrumb: box(breadcrumb),
      breadcrumbOverflowX: breadcrumb.scrollWidth - breadcrumb.clientWidth,
      meta: box(titleMeta),
      metaRight: titleMeta.getBoundingClientRect().right,
      titleRight: title.getBoundingClientRect().right,
      nameWhiteSpace: document.querySelector('.path-name') ? getComputedStyle(document.querySelector('.path-name')).whiteSpace : '',
    },
    context: {
      box: box(contextPanel),
      scrollWidth: contextPanel.scrollWidth,
      clientWidth: contextPanel.clientWidth,
      currentFile: box(currentFile),
      commitPanel: box(commitPanel),
      divider: commitPanel.getBoundingClientRect().top - currentFile.getBoundingClientRect().bottom,
    },
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
