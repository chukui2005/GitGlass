const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const electronPath = require('electron')
const probe = path.join(__dirname, 'support', 'history-row-layout.cjs')
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.jsx'), 'utf8')
const styles = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')

let layout

function readLayout() {
  if (layout) return layout
  const stdout = execFileSync(electronPath, [probe], { encoding: 'utf8', timeout: 90_000, windowsHide: true })
  const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith('[LAYOUT] '))
  expect(line).toBeTruthy()
  layout = JSON.parse(line.slice('[LAYOUT] '.length))
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
    expect(source).toContain('<div className={`history-row ${selected ? "selected" : ""}`}>')
    expect(source).toContain('className="compare-pin"')
    // 选中态覆盖整行，而不是只覆盖左侧按钮。
    expect(styles).toContain('.history-row.selected{background:var(--blue-soft);box-shadow:inset 3px 0 var(--blue)}')
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
        // 单行高度（约 44px），换行会让行高翻倍。
        expect(row.row.height, label).toBeGreaterThanOrEqual(40)
        expect(row.row.height, label).toBeLessThanOrEqual(56)
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
