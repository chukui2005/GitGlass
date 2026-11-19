const fs = require('node:fs')
const path = require('node:path')

const { runProbe } = require(path.join(__dirname, '..', 'support', 'probe-runner.cjs'))
// 0.6.5 拆完 main.jsx 之后，提交行组件住在 workbench-ui.jsx；断言跟着代码走。
const panels = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'workbench-ui.jsx'), 'utf8')
const styles = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'styles.css'), 'utf8')
const { declarations } = require(path.join(__dirname, '..', 'support', 'css-inspect.cjs'))

let layout

function readLayout() {
  if (layout) return layout
  layout = JSON.parse(runProbe('history-row-layout.cjs', '[LAYOUT] '))
  return layout
}

describe('V0.5.2 commit row layout', () => {
  it('declares an explicit two-column grid for history rows', () => {
    // 静态守卫：任何一个含 grid-template-columns 的 .history-row 规则都必须显式 display:grid，
    // 否则“比较”按钮会掉到下一行（V0.5.2 回归点的根因）。
    const rules = [...styles.matchAll(/\.history-row\{([^}]*)\}/g)].map((match) => match[1])
    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) {
      expect(rule).toContain('display:grid')
      expect(rule).toContain('grid-template-columns:minmax(0,1fr) auto')
    }
    // 行内只有两列：提交按钮 + 比较按钮，顺序固定。
    expect(panels).toContain('<div className={`history-row ${selected ? "selected" : ""}`}>')
    expect(panels).toContain('className="compare-pin"')
    // 选中态覆盖整行，而不是只覆盖左侧按钮：整行浅底 + 左侧 2px 强调条。
    const selected = declarations(styles, '.history-row.selected')
    expect(selected).toMatchObject({ 'box-shadow': 'inset 2px 0 var(--blue)' })
    expect(selected.background).toContain('color-mix')
    // 密度对齐 dbx：单行高度由 .commit-select 的 min-height 决定。
    expect(declarations(styles, '.commit-select')['min-height']).toBe('38px')
    // 两行字号：标题 13px 正文、元信息 11px 辅助。
    expect(declarations(styles, '.commit-title')['font-size']).toBe('var(--font-body)')
    expect(declarations(styles, '.commit-meta')['font-size']).toBe('var(--font-aux)')
  })

  it('computes a grid row with the compare button inside the row at 1024, 1280 and 1440', () => {
    const data = readLayout()
    expect(data.map((entry) => entry.width)).toEqual([1024, 1280, 1440])
    for (const entry of data) {
      expect(entry.rows.length).toBe(2)
      for (const row of entry.rows) {
        const label = `${entry.width}px / ${row.name}`
        expect(row.display, label).toBe('grid')
        expect(row.align, label).toBe('center')
        expect(row.columnCount, label).toBe(2)
        expect(row.pin, label).not.toBeNull()
        expect(row.pin.whiteSpace, label).toBe('nowrap')
        // 比较按钮右边界不得超出所属行右边界。
        expect(row.pin.right, label).toBeLessThanOrEqual(row.row.right + 0.5)
        // 按钮必须与提交按钮同一行且垂直居中，不能换行到下一行。
        expect(row.pin.top, label).toBeGreaterThanOrEqual(row.row.top - 0.5)
        expect(row.pin.bottom, label).toBeLessThanOrEqual(row.row.bottom + 0.5)
        expect(row.pin.left, label).toBeGreaterThanOrEqual(row.select.right - 0.5)
        // 单行高度 38px（dbx 密度）；换行会让行高翻倍，所以上下界都要卡住。
        expect(row.row.height, label).toBeGreaterThanOrEqual(36)
        expect(row.row.height, label).toBeLessThanOrEqual(40)
        // 两行信息结构保持：标题、元信息各自单行且占可用宽度。
        expect(row.title.height, label).toBeLessThanOrEqual(22)
        expect(row.meta.height, label).toBeLessThanOrEqual(20)
        expect(row.title.width, label).toBeGreaterThan(120)
        // 不出现横向溢出（溢出会把按钮挤出可视区）。
        expect(row.scrollWidth, label).toBeLessThanOrEqual(row.clientWidth + 1)
        // 比较按钮宽度正常，排除被压成竖排文字。
        expect(row.pin.width, label).toBeGreaterThanOrEqual(24)
        expect(row.pin.width, label).toBeLessThanOrEqual(72)
      }
    }
  }, 90_000)
})
