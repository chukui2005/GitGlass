const { execFileSync } = require('node:child_process')
const path = require('node:path')

// 探针在真实 Electron 窗口里加载构建产物：账本两行结构、顶栏三档按钮、空状态主按钮都必须
// 在真实布局下成立（字号取自 computed style，横向溢出来自 scrollWidth）。
function runProbe() {
  const root = path.join(__dirname, '..', '..')
  const environment = { ...process.env }
  // ELECTRON_RUN_AS_NODE 会让 electron 以纯 Node 启动，探针拿不到 app/BrowserWindow。
  delete environment.ELECTRON_RUN_AS_NODE

  // 始终用当前源码构建，避免读到本机过期的被忽略 dist/。
  execFileSync(
    process.execPath,
    [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'],
    { cwd: root, env: { ...environment, NODE_ENV: 'production' }, windowsHide: true, timeout: 90_000 },
  )
  return execFileSync(require('electron'), [path.join(__dirname, '..', 'support', 'ledger-rows.cjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
    env: environment,
  })
}

describe('PR5 字号层级与按钮体系（真实窗口）', () => {
  it('renders two-line ledger rows, a ranked toolbar and exactly one primary button', () => {
    const output = runProbe()
    expect(output).toContain('[LEDGER-ROWS] ')
    const summary = JSON.parse(output.split('[LEDGER-ROWS] ')[1].split(/\r?\n/)[0])
    expect(summary.rows.map((row) => row.intentFont)).toEqual(['13px', '13px', '13px'])
    expect(summary.rows.map((row) => row.commandFont)).toEqual(['12px', '12px', '12px'])
    expect(summary.rows.map((row) => row.metaFont)).toEqual(['11px', '11px', '11px'])
    expect(summary.topbar).toEqual({ toolbar: 4, secondary: 2, primary: 0 })
    expect(summary.emptyPrimary).toBe('打开仓库')
    // 密度对齐 dbx：侧栏列表行 26px、分组标题 28px、账本单行 32px、Diff 行 20–21px，
    // 且侧栏不出现横向滚动（长路径靠省略号，而不是撑宽）。
    expect(summary.density.fileRow).toBe(26)
    expect(summary.density.branchRow).toBe(26)
    expect(summary.density.sectionLabel).toBe(28)
    expect(summary.density.ledgerRow).toBe(32)
    expect(summary.density.diffLine).toBeGreaterThanOrEqual(19)
    expect(summary.density.diffLine).toBeLessThanOrEqual(22)
    expect(summary.density.sidebarOverflowX).toBeLessThanOrEqual(0)
  }, 180_000)
})
