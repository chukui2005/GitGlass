const fs = require('node:fs')
const path = require('node:path')

const { runProbe } = require(path.join(__dirname, '..', 'support', 'probe-runner.cjs'))
const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main.jsx'), 'utf8')
const panels = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'workbench-ui.jsx'), 'utf8')
const styles = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'styles.css'), 'utf8')

let layout

function readLayout() {
  if (layout) return layout
  layout = JSON.parse(runProbe('batch-stage-layout.cjs', '[LAYOUT] '))
  return layout
}

describe('工作台布局（真实 Electron：1024 / 1280 / 1440）', () => {
  it('renders checkboxes only in the unstaged section in the source structure', () => {
    // 已暂存区不允许出现复选框：结构断言守卫。
    const stagedBlock = source.split('title="已暂存改动"')[1] || ''
    expect(stagedBlock.slice(0, stagedBlock.indexOf('/>'))).not.toContain('stage-check')
    expect(styles).toContain('.stage-check{flex:none')
    expect(styles).toContain('.batch-toolbar{display:grid')
  })

  it('keeps the batch toolbar inside two rows without horizontal overflow at 1024, 1280 and 1440', () => {
    const data = readLayout()
    expect(data.map((entry) => entry.width)).toEqual([1024, 1280, 1440])
    for (const entry of data) {
      const label = (name) => `${entry.width}px / ${name}`
      expect(entry.toolbar.scrollWidth, label('toolbar')).toBeLessThanOrEqual(entry.toolbar.clientWidth + 1)
      expect(entry.toolsRow.scrollWidth, label('toolsRow')).toBeLessThanOrEqual(entry.toolsRow.clientWidth + 1)
      expect(entry.stageRow.scrollWidth, label('stageRow')).toBeLessThanOrEqual(entry.stageRow.clientWidth + 1)
      // 「全选」与「暂存所选」并排在同一行，后者不被压成竖排文字。
      expect(entry.stage.left, label('stage')).toBeGreaterThanOrEqual(entry.selectAll.right - 0.5)
      expect(entry.stage.right, label('stage')).toBeLessThanOrEqual(entry.toolsRow.box.right + 0.5)
      expect(entry.stage.whiteSpace, label('stage')).toBe('nowrap')
      expect(entry.stage.width, label('stage')).toBeGreaterThan(48)
      // 计数与「清除」在第二行，不与操作行重叠。
      expect(entry.count.top, label('count')).toBeGreaterThanOrEqual(entry.toolsRow.box.bottom - 0.5)
      expect(entry.clear.right, label('clear')).toBeLessThanOrEqual(entry.stageRow.box.right + 0.5)
      // 两行以内：工具栏高度不超过「操作行 + 计数行 + 间距」。
      expect(entry.toolbar.box.height, label('toolbar height')).toBeLessThanOrEqual(
        entry.toolsRow.box.height + entry.stageRow.box.height + 12,
      )
    }
  })

  it('keeps file rows single-line with basename, status slot and actions inside the row', () => {
    const data = readLayout()
    for (const entry of data) {
      // 交接稿：文件行 28px。
      expect(Math.round(entry.firstRow.height), `${entry.width}px / row height`).toBe(28)
      for (const row of entry.rows) {
        const rowLabel = `${entry.width}px / ${row.rowName}`
        expect(row.scrollWidth, rowLabel).toBeLessThanOrEqual(row.clientWidth + 1)
        // 主标签是 basename：单行省略，不换行错位。
        expect(row.name.whiteSpace, rowLabel).toBe('nowrap')
        expect(row.name.overflow, rowLabel).toBe('ellipsis')
        // 状态符号固定在行尾（文件按钮内右侧），行操作按钮紧随其后且不越界。
        expect(row.status, rowLabel).not.toBeNull()
        expect(row.status.right, rowLabel).toBeLessThanOrEqual(row.select.right + 0.5)
        expect(row.status.left, rowLabel).toBeGreaterThanOrEqual(row.name.left - 0.5)
        expect(row.action.right, rowLabel).toBeLessThanOrEqual(row.row.right + 0.5)
        expect(row.action.left, rowLabel).toBeGreaterThanOrEqual(row.select.right - 0.5)
        if (row.rowName === 'staged-no-checkbox') {
          // 已暂存区没有复选框，文件选择按钮从行首开始。
          expect(row.check, rowLabel).toBeNull()
          expect(row.select.left, rowLabel).toBeGreaterThanOrEqual(row.row.left - 0.5)
          continue
        }
        // 复选框在文件按钮左侧，互不重叠。
        expect(row.check, rowLabel).not.toBeNull()
        expect(row.check.right, rowLabel).toBeLessThanOrEqual(row.select.left + 0.5)
        expect(row.check.width, rowLabel).toBeGreaterThan(8)
      }
    }
  })

  it('keeps one 56px diff title with the path on the left and the status on the right', () => {
    const data = readLayout()
    for (const entry of data) {
      const title = entry.title
      const label = `${entry.width}px / diff title`
      // 中央单文件标题条约 56px，且不出现横向滚动。
      expect(Math.round(title.box.height), label).toBeGreaterThanOrEqual(54)
      expect(Math.round(title.box.height), label).toBeLessThanOrEqual(58)
      expect(title.scrollWidth, label).toBeLessThanOrEqual(title.clientWidth + 1)
      // 路径先省略前面的目录，文件名保持单行。
      expect(title.breadcrumbOverflowX, label).toBeLessThanOrEqual(0)
      expect(title.nameWhiteSpace, label).toBe('nowrap')
      // 右侧状态组与路径不重叠，且不越出标题条。
      expect(title.meta.left, label).toBeGreaterThanOrEqual(title.breadcrumb.right - 0.5)
      expect(title.metaRight, label).toBeLessThanOrEqual(title.titleRight + 0.5)
    }
  })

  it('stacks the current-file section above the commit section inside the right panel', () => {
    const data = readLayout()
    for (const entry of data) {
      const label = `${entry.width}px / right panel`
      expect(entry.context.scrollWidth, label).toBeLessThanOrEqual(entry.context.clientWidth + 1)
      expect(entry.context.currentFile.height, label).toBeGreaterThan(0)
      expect(entry.context.commitPanel.height, label).toBeGreaterThan(0)
      // 两段之间只有一条细线：提交段整体在当前文件段下方。
      expect(entry.context.divider, label).toBeGreaterThanOrEqual(0)
    }
  })

  it('keeps the toolbar and right-panel copy free of duplicated path lines in the markup', () => {
    // 中央不再有第二行完整路径：「文件差异」标题由可访问的 h2 承载。
    expect(source).toContain('className="main-toolbar diff-title"')
    expect(source).toContain('<h2 className="visually-hidden">文件差异</h2>')
    expect(source).not.toContain('className="diff-meta"')
    // 右栏两段共用同一个细线分隔规则，而不是各自画边框。
    expect(panels).toContain('className="inspector-flow commit-panel"')
    expect(panels).toContain('className="inspector-flow current-file"')
    expect(styles).toContain('.commit-panel{margin-top:18px;padding-top:16px;border-top:1px solid var(--line)}')
  })
})
