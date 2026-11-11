const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.jsx'), 'utf8')
const styles = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')

describe('Workbench layout structure', () => {
  it('keeps selected-file diff content inside a two-row diff view', () => {
    expect(source).toContain('<div className="diff-view"><div className="diff-meta">')
    expect(source).toContain('<div className="diff-content">{diff.split')
    expect(styles).toContain('.diff-view{display:grid;grid-template-rows:auto minmax(0,1fr);min-height:0}')
    expect(styles).toContain('.diff-content{min-height:0;overflow:auto')
  })

  it('keeps the ledger bar outside of the only scrolling ledger list', () => {
    expect(source).toContain('<div className="ledger-bar">')
    expect(source).toContain('<div className="ledger-list">')
    expect(styles).toContain('.command-ledger{display:grid;grid-template-rows:auto minmax(0,1fr);min-height:0;overflow:hidden')
    expect(styles).toContain('.ledger-list{display:grid;align-content:start;gap:4px;min-height:0;overflow:auto')
  })
})
