const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.jsx'), 'utf8')
const styles = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')

describe('Workbench layout structure', () => {
  it('keeps selected-file diff content inside a two-row diff view', () => {
    expect(source).toContain('className="diff-view"')
    expect(source).toContain('className="diff-meta"')
    expect(source).toContain('className="diff-content"')
    expect(source).toContain('diff.split("\\n").map(')
    expect(styles).toContain('.diff-view{display:grid;grid-template-rows:auto minmax(0,1fr);min-height:0}')
    expect(styles).toContain('.diff-content{min-height:0;overflow:auto')
  })

  it('keeps the ledger bar outside of the only scrolling ledger list', () => {
    expect(source).toContain('<div className="ledger-bar">')
    expect(source).toContain('<div className="ledger-list">')
    expect(styles).toContain('.command-ledger{display:grid;grid-template-rows:auto minmax(0,1fr);min-height:0;overflow:hidden')
    expect(styles).toContain('.ledger-list{display:grid;align-content:start;gap:4px;min-height:0;overflow:auto')
  })

  it('keeps the collapsed ledger glance on one stable nowrap line', () => {
    expect(source).toContain('className="ledger-glance"')
    expect(source).toContain('className="ledger-glance-text"')
    expect(source).toContain('最近：{intentLabel(latestRecord)}')
    expect(source).not.toContain('<code>{latestRecord.displayCommand}')
    expect(styles).toContain('.ledger-glance{container-type:inline-size;display:flex')
    expect(styles).toContain('.ledger-glance-text{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}')
    // When the glance cannot fit, the time hides first, then the status chip.
    expect(styles).toContain('@container (max-width:260px){.ledger-glance time{display:none}}')
    expect(styles).toContain('@container (max-width:180px){.ledger-glance-status{display:none}}')
  })

  it('shows a Chinese information hierarchy and hides raw protocol fields in tech details', () => {
    expect(source).toContain('<dt>操作</dt>')
    expect(source).toContain('<dt>类型</dt>')
    expect(source).toContain('<dt>工作目录</dt>')
    expect(source).toContain('<dt>状态</dt>')
    expect(source).toContain('<span>实际执行命令</span>')
    expect(source).toContain('title="命令结果"')
    expect(source).toContain('title="诊断信息"')
    expect(source).toContain('<details className="tech-details">')
    expect(source).toContain('<summary>技术详情</summary>')
    expect(source).not.toContain('（无输出）')
    expect(source).not.toContain('title="stdout"')
    expect(source).not.toContain('title="stderr"')
  })
})
