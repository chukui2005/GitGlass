const path = require('node:path')

// 探针在真实 Electron 窗口里加载构建产物：账本两行结构、顶栏三档按钮、空状态主按钮都必须
// 在真实布局下成立（字号取自 computed style，横向溢出来自 scrollWidth）。
const { buildApplication, runElectronProbe } = require(path.join(__dirname, '..', 'support', 'probe-runner.cjs'))

function runProbe() {
  buildApplication()
  return runElectronProbe('ledger-rows.cjs', { marker: '[LEDGER-ROWS] ' })
}

describe('PR5 字号层级与按钮体系（真实窗口）', () => {
  it('renders two-line ledger rows, a ranked toolbar and exactly one primary button', () => {
    const output = runProbe()
    expect(output).toContain('[LEDGER-ROWS] ')
    const summary = JSON.parse(output.split('[LEDGER-ROWS] ')[1].split(/\r?\n/)[0])
    expect(summary.rows.map((row) => row.intentFont)).toEqual(['13px', '13px', '13px'])
    expect(summary.rows.map((row) => row.commandFont)).toEqual(['12px', '12px', '12px'])
    expect(summary.rows.map((row) => row.metaFont)).toEqual(['11px', '11px', '11px'])
    expect(summary.topbar).toEqual({ toolbar: 4, secondary: 2, icons: 1, primary: 0 })
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
