const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const electronPath = require('electron')
const probe = path.join(__dirname, 'support', 'batch-stage-layout.cjs')
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

describe('V0.5.3 batch stage layout (real Electron)', () => {
  it('renders checkboxes only in the unstaged section in the source structure', () => {
    // 已暂存区不允许出现复选框：结构断言守卫。
    const stagedBlock = source.split('title="已暂存改动"')[1] || ''
    expect(stagedBlock.slice(0, stagedBlock.indexOf('/>'))).not.toContain('stage-check')
    expect(styles).toContain('.stage-check{flex:none')
    expect(styles).toContain('.batch-toolbar{display:grid')
  })

  it('keeps checkboxes, file paths, row actions, and batch buttons from overlapping at 1024, 1280 and 1440', () => {
    const data = readLayout()
    expect(data.map((entry) => entry.width)).toEqual([1024, 1280, 1440])
    for (const entry of data) {
      const label = (name) => `${entry.width}px / ${name}`
      // 工具栏与按钮都在侧栏内，且没有横向溢出。
      expect(entry.toolbar.scrollWidth, label('toolbar')).toBeLessThanOrEqual(entry.toolbar.clientWidth + 1)
      expect(entry.toolsRow.scrollWidth, label('toolsRow')).toBeLessThanOrEqual(entry.toolsRow.clientWidth + 1)
      expect(entry.stageRow.scrollWidth, label('stageRow')).toBeLessThanOrEqual(entry.stageRow.clientWidth + 1)
      expect(entry.stage.right, label('stage')).toBeLessThanOrEqual(entry.toolbar.box.right + 0.5)
      expect(entry.stage.left, label('stage')).toBeGreaterThanOrEqual(entry.count.right + 3.5)
      expect(entry.stage.whiteSpace, label('stage')).toBe('nowrap')
      // “暂存所选 N 个”主按钮有正常宽度，没有被压成竖排文字。
      expect(entry.stage.width, label('stage')).toBeGreaterThan(48)

      for (const row of entry.rows) {
        const rowLabel = label(row.name)
        expect(row.scrollWidth, rowLabel).toBeLessThanOrEqual(row.clientWidth + 1)
        if (row.name === 'staged-no-checkbox') {
          // 已暂存区没有复选框，文件选择按钮从行首开始。
          expect(row.check, rowLabel).toBeNull()
          expect(row.select.left, rowLabel).toBeGreaterThanOrEqual(row.row.left - 0.5)
          continue
        }
        // 复选框在文件按钮左侧，互不重叠；行高保持单行。
        expect(row.check, rowLabel).not.toBeNull()
        expect(row.check.right, rowLabel).toBeLessThanOrEqual(row.select.left + 0.5)
        expect(row.check.width, rowLabel).toBeGreaterThan(8)
        expect(row.action.right, rowLabel).toBeLessThanOrEqual(row.row.right + 0.5)
        expect(row.action.left, rowLabel).toBeGreaterThanOrEqual(row.select.right - 0.5)
        expect(row.row.height, rowLabel).toBeGreaterThanOrEqual(20)
        expect(row.row.height, rowLabel).toBeLessThanOrEqual(44)
        // 长路径保持省略：文本单行，不换行错位。
        expect(row.path.whiteSpace, rowLabel).toBe('nowrap')
      }
    }
  }, 90_000)
})
