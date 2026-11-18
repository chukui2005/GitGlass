const fs = require('node:fs')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main.jsx'), 'utf8')
const styles = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'styles.css'), 'utf8')

describe('V0.4 workbench and V0.5 history integration', () => {
  it('keeps V0.4 entry points alongside the history mode entry', () => {
    for (const label of ['工作区', '历史审查', '恢复', '获取…', '命令账本', '未暂存改动', '已暂存改动']) expect(source).toContain(label)
  })
  it('makes the remote entry point announce that it only opens a plan', () => {
    expect(source).toContain('这一步不会执行任何命令')
    expect(source).toContain('获取远程更新（先查看计划）')
    expect(source).not.toContain('同步远程状态')
  })
  it('places history notice and view within main-content', () => {
    expect(source).toContain('<div className="main-content"><div className="history-notice"')
    expect(source).toContain('<div className="history-view">')
    expect(styles).toContain('.main-content{display:grid;grid-template-rows:auto minmax(0,1fr);min-height:0}')
    expect(styles).toContain('.history-view{min-height:0;overflow:auto}')
  })
})
