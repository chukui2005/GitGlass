const fs = require('node:fs')
const path = require('node:path')

// 样式契约（不是组件行为）。
//
// 这些断言只能靠读 `src/styles.css`：它们守的是“布局必须这样排”才能成立的规则
// （哪一格滚动、哪一列自适应、窄到什么程度隐藏哪一段）。组件本身的行为断言在
// 同目录的 *.test.mjs 里真渲染验证，两边不重复。
const styles = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'styles.css'), 'utf8')
const { declarations } = require(path.join(__dirname, '..', 'support', 'css-inspect.cjs'))

describe('workbench style contracts', () => {
  it('keeps the diff body as the only scrolling cell and the ledger body the only scrolling list', () => {
    // 中央只剩一条 56px 标题 + 一个滚动单元格（原先还有第二行 diff-meta）。
    expect(declarations(styles, '.diff-view')).toMatchObject({
      display: 'grid',
      'grid-template-rows': 'minmax(0,1fr)',
      'min-height': '0',
    })
    expect(declarations(styles, '.diff-title')).toMatchObject({
      'min-height': '56px',
      'padding': '0 20px',
    })
    expect(declarations(styles, '.diff-content')).toMatchObject({ 'min-height': '0', overflow: 'auto' })
    expect(declarations(styles, '.command-ledger')).toMatchObject({
      display: 'grid',
      'grid-template-rows': 'auto minmax(0,1fr)',
      'min-height': '0',
      overflow: 'hidden',
    })
    // 行距之类的外观取值不锁死：这里只守“列表是滚动容器、内容从顶部排”。
    expect(declarations(styles, '.ledger-list')).toMatchObject({
      display: 'grid',
      'align-content': 'start',
      'min-height': '0',
      overflow: 'auto',
    })
  })

  it('keeps the collapsed ledger at 36px and lets the summary shed details as it narrows', () => {
    expect(declarations(styles, '.app-shell')['grid-template-rows']).toBe('48px minmax(0,1fr) 36px')
    expect(declarations(styles, '.ledger-bar')['min-height']).toBe('35px')
    expect(declarations(styles, '.ledger-glance')).toMatchObject({
      'container-type': 'inline-size',
      display: 'flex',
    })
    expect(declarations(styles, '.ledger-glance-text')).toMatchObject({
      flex: '0 1 auto',
      'min-width': '0',
      overflow: 'hidden',
      'text-overflow': 'ellipsis',
      'white-space': 'nowrap',
    })
    // 放不下时先隐藏时间，再隐藏状态徽标。
    expect(styles).toContain('@container (max-width:260px){.ledger-glance time{display:none}}')
    expect(styles).toContain('@container (max-width:180px){.ledger-glance-status{display:none}}')
  })

  it('turns the top bar into the drag region and reserves the overlay safe area', () => {
    const topbar = declarations(styles, '.topbar')
    expect(topbar).toMatchObject({
      display: 'grid',
      'align-items': 'center',
      background: 'var(--surface)',
      'border-bottom': '1px solid var(--line)',
      '-webkit-app-region': 'drag',
    })
    // 系统窗口控件在 Window Controls Overlay 安全区里，不写死宽度。
    expect(topbar['padding-right']).toContain('env(titlebar-area-x,0px)')
    expect(topbar['padding-right']).toContain('env(titlebar-area-width,100vw)')
    // 交互控件退出拖拽区；macOS 保留左侧原生交通灯空间。
    expect(styles).toContain('.topbar button,.topbar input,.top-state{-webkit-app-region:no-drag}')
    expect(declarations(styles, '.platform-darwin .topbar')).toMatchObject({ 'padding-left': '78px' })
    // 1240px 以下先把文字标签折成图标，title / aria-label 仍在。
    expect(styles).toContain('@media(max-width:1240px){.view-tab-label{display:none}')
    expect(styles).toContain('@media(max-width:1240px){.top-action-label{display:none}}')
  })

  it('gives each ledger record two lines with two distinct type sizes', () => {
    expect(declarations(styles, '.ledger-summary')).toMatchObject({
      display: 'grid',
      'grid-template-columns': '15px minmax(0,1fr) 14px',
    })
    // 命令单行省略而不是换行；列表不出现横向滚动条。
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

  it('keeps the history view inside a notice-plus-scroll main-content grid', () => {
    expect(declarations(styles, '.main-content')).toMatchObject({
      display: 'grid',
      'grid-template-rows': 'auto minmax(0,1fr)',
      'min-height': '0',
    })
    expect(declarations(styles, '.history-view')).toMatchObject({ 'min-height': '0', overflow: 'auto' })
  })

  it('keeps the compare button inside the commit row instead of wrapping below it', () => {
    // P1 回归点：只有 grid-template-columns 而没有 display:grid 时，
    // “比较”按钮会掉到下一行左侧。
    for (const match of styles.matchAll(/\.history-row\{([^}]*)\}/g)) {
      expect(match[1]).toContain('display:grid')
      expect(match[1]).toContain('grid-template-columns:minmax(0,1fr) auto')
    }
    expect(declarations(styles, '.compare-pin')).toMatchObject({
      'align-self': 'center',
      'justify-self': 'end',
      'white-space': 'nowrap',
    })
    // 选中态覆盖整条提交行：整行浅底 + 左侧 2px 强调条。
    const selected = declarations(styles, '.history-row.selected')
    expect(selected).toMatchObject({ 'box-shadow': 'inset 2px 0 var(--blue)' })
    expect(selected.background).toBe('var(--blue-soft)')
  })

  it('styles the two-row batch toolbar and its checkboxes with the restrained visual language', () => {
    // 提示属于次级正文：字号不低于 11px，颜色走统一的 --muted。
    expect(declarations(styles, '.batch-hint')).toMatchObject({
      margin: '0',
      color: 'var(--muted)',
      'line-height': 'var(--line-secondary)',
    })
    expect(declarations(styles, '.batch-hint')['font-size']).toBe('var(--font-aux)')
    // 两行以内：操作行（全选 / 暂存所选）+ 计数或原因行。
    expect(declarations(styles, '.batch-toolbar')).toMatchObject({ display: 'grid', gap: '6px' })
    expect(declarations(styles, '.batch-tools-row')).toMatchObject({ display: 'flex', gap: '6px' })
    expect(declarations(styles, '.batch-tool')).toMatchObject({
      flex: '1',
      'min-width': '0',
      overflow: 'hidden',
    })
    expect(declarations(styles, '.batch-stage-row')).toMatchObject({ display: 'flex', 'align-items': 'center' })
    // 「全选 / 暂存所选」并排等宽：两者都撑满操作行，不换行。
    expect(declarations(styles, '.batch-tools-row .batch-tool')).toMatchObject({ flex: '1', 'min-width': '0' })
    expect(declarations(styles, '.batch-tools-row .batch-stage')).toMatchObject({ flex: '1', 'min-width': '0' })
    // 「暂存所选」是次按钮（描边），三态齐全：hover 浅底、禁用灰、焦点环。
    expect(declarations(styles, '.batch-stage')).toMatchObject({
      display: 'inline-flex',
      border: '1px solid var(--line)',
      background: 'var(--surface)',
      color: 'var(--text)',
    })
    expect(declarations(styles, '.batch-stage:not(:disabled):hover')).toMatchObject({
      background: 'var(--hover)',
    })
    expect(declarations(styles, '.batch-stage:disabled')).toMatchObject({
      background: 'var(--hover)',
      color: 'var(--faint)',
    })
    expect(declarations(styles, '.batch-stage:focus-visible')['outline']).toBe('2px solid var(--ring)')
    // 「清除」是低权重文字动作，只出现在选中之后。
    expect(declarations(styles, '.batch-clear')).toMatchObject({ 'font-size': 'var(--font-aux)' })
    // 复选框保留可见焦点与蓝色 accent（与 dbx 表格里的勾选一致）。
    expect(declarations(styles, '.stage-check')).toMatchObject({
      width: '13px',
      height: '13px',
      'accent-color': 'var(--blue)',
    })
    expect(declarations(styles, '.stage-check:focus-visible')['outline']).toBe('2px solid var(--ring)')
    // 不引入深色终端风或渐变。
    expect(styles).not.toContain('linear-gradient')
  })
})
