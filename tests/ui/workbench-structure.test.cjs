const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main.jsx'), 'utf8')
const styles = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'styles.css'), 'utf8')
const { declarations } = require(path.join(__dirname, '..', 'support', 'css-inspect.cjs'))

describe('Workbench layout structure', () => {
  it('keeps selected-file diff content inside a two-row diff view', () => {
    expect(source).toContain('className="diff-view"')
    expect(source).toContain('className="diff-meta"')
    expect(source).toContain('className="diff-content"')
    expect(source).toContain('presentDiff(diff).map(')
    expect(source).toContain('className="diff-line-number"')
    expect(source).toContain('原文件第 ${row.oldLine} 行')
    expect(source).toContain('新文件第 ${row.newLine} 行')
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
    // 收起态不出现任何原始命令或 argv；argv 只在默认折叠的技术详情里。
    expect(source).not.toContain('<code>{latestRecord')
    expect(source).toContain('<details className="tech-details">')
    // 输出区只在有内容时渲染；空 stderr 不显示诊断信息。
    expect(source).toContain('{(record.stdout || record.stderr) && (')
    expect(source).toContain('{record.stderr && (')
    expect(styles).toContain('.ledger-glance{container-type:inline-size;display:flex')
    expect(styles).toContain('.ledger-glance-text{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}')
    // When the glance cannot fit, the time hides first, then the status chip.
    expect(styles).toContain('@container (max-width:260px){.ledger-glance time{display:none}}')
    expect(styles).toContain('@container (max-width:180px){.ledger-glance-status{display:none}}')
  })

  it('turns the top bar into the drag region and reserves the overlay safe area', () => {
    // The bar itself drags the window; interactive controls opt out.
    expect(styles).toContain('.topbar{display:flex;align-items:center;gap:16px;padding:0 16px;background:var(--surface);border-bottom:1px solid var(--line);-webkit-app-region:drag')
    expect(styles).toContain('.topbar button,.topbar input,.top-state{-webkit-app-region:no-drag}')
    // The system window controls sit in the overlay safe area, not a fixed width.
    expect(styles).toContain('padding-right:calc(100vw - env(titlebar-area-x,0px) - env(titlebar-area-width,100vw) + 16px)')
    // macOS keeps native traffic lights on the left of the same bar.
    expect(styles).toContain('.platform-darwin .topbar{padding-left:78px}')
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

  it('gives each expanded ledger record two lines: intent plus command, then result metadata', () => {
    // 第一行：意图 + 等宽命令；命令单行省略，全文放在 title 里。
    expect(source).toContain('className="ledger-entry-main"')
    expect(source).toContain('className="ledger-entry-line"')
    expect(source).toContain('className="ledger-command" title={command}')
    expect(source).toContain('<span className="ledger-intent">{intentLabel(record)}</span>')
    // 第二行：结果 · 退出码 · 耗时/时间 · 来源。
    expect(source).toContain('className="ledger-entry-meta"')
    expect(source).toContain('{recordStatusLabel(record)}')
    expect(source).toContain('<span>退出码 {record.exitCode ?? "—"}</span>')
    expect(source).toContain('{duration && (')
    expect(source).toContain('const duration = recordDurationLabel(record)')
    expect(source).toContain('{recordTypeLabel(record.source)}')
    expect(source).toContain('<time dateTime={record.startedAt || undefined}>')
    // 展开按钮仍保留 aria-expanded，供键盘与读屏使用。
    expect(source).toContain('aria-expanded={expanded}')

    // 语义断言：两行布局用 grid，命令用省略号而不是换行，列表不出现横向滚动条。
    expect(declarations(styles, '.ledger-summary')).toMatchObject({
      display: 'grid',
      'grid-template-columns': '15px minmax(0,1fr) 14px',
    })
    expect(declarations(styles, '.ledger-command')).toMatchObject({
      overflow: 'hidden',
      'text-overflow': 'ellipsis',
      'white-space': 'nowrap',
    })
    expect(declarations(styles, '.ledger-entry-meta')['white-space']).toBe('nowrap')
    expect(declarations(styles, '.ledger-list')['overflow-x']).toBe('hidden')
    // 第一行 13px 正文，第二行 11px 辅助信息：两档字号必须真的不同。
    expect(declarations(styles, '.ledger-intent')['font-size']).toBe('var(--font-body)')
    expect(declarations(styles, '.ledger-entry-meta')['font-size']).toBe('var(--font-aux)')
  })
})
