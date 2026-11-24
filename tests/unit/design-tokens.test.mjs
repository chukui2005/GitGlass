import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { declarations, fontSizesBelow } = require('../support/css-inspect.cjs')

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const styles = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8')
const renderer = fs.readFileSync(path.join(root, 'src', 'main.jsx'), 'utf8')
const updates = fs.readFileSync(path.join(root, 'src', 'app-updates.jsx'), 'utf8')

// 读文件 + 正则的轻量断言：不启动 Electron，也不锁定规则的书写方式，只校验设计 token 与按钮体系存在。
// 基线见 docs/ui-redesign-handoff.md（0.7 工作台改版）。
describe('Design tokens: 0.7 工作台基线', () => {
  it('carries the handoff palette for canvas, panels and text', () => {
    expect(declarations(styles, ':root')).toMatchObject({
      '--app': '#fff',
      '--surface': '#fff',
      '--sidebar': '#f7f8fa',
      '--sunken': '#f7f8fa',
      '--code': '#f7f8fa',
      '--hover': '#f2f4f8',
      '--active': '#eaeef3',
      '--text': '#20252d',
      '--muted': '#586474',
      '--faint': '#8d97a6',
      '--line': '#e1e5eb',
      '--line-strong': '#cbd2dd',
      '--ring': '#2456b5',
    })
  })

  it('keeps selection, brand and diff tint tokens in one place', () => {
    expect(declarations(styles, ':root')).toMatchObject({
      '--blue': '#2456b5',
      '--blue-soft': '#eaf1ff',
      '--green-wash': '#edf7ef',
      '--red-wash': '#fbeff0',
    })
    // 状态字用深色：深绿 / 深红 / 深橙，而不是荧光色。
    expect(declarations(styles, ':root')).toMatchObject({
      '--green-ink': '#166534',
      '--red-ink': '#a62632',
      '--orange-ink': '#8b4b11',
    })
    // 实心主按钮用主文字色，而不是品牌蓝。
    expect(declarations(styles, '.primary-button,.primary-action').background).toBe('#20252d')
  })

  it('uses the 4 / 6 / 10px radius scale and a single modal shadow token', () => {
    expect(declarations(styles, ':root')).toMatchObject({
      '--radius-sm': '4px',
      '--radius': '6px',
      '--radius-lg': '10px',
      '--shadow-modal': '0 12px 32px rgba(15,23,42,.12)',
    })
  })

  it('keeps the 14 / 13 / 12 / 11px type scale and the 12/22px diff line', () => {
    expect(declarations(styles, ':root')).toMatchObject({
      '--font-title': '14px',
      '--font-body': '13px',
      '--line-body': '1.5',
      '--font-secondary': '12px',
      '--line-secondary': '1.45',
      '--font-aux': '11px',
      '--line-aux': '1.4',
      '--font-diff': '12px',
      '--line-diff': '22px',
    })
    expect(styles).toContain('正文 13px/1.5')
    expect(styles).toContain('Diff 正文 12px/22px')
  })

  it('leaves no 10px text behind anywhere in the stylesheet', () => {
    expect(fontSizesBelow(styles, 11)).toEqual([])
  })

  it('keeps the notice banner and its pin on the ghost recipe', () => {
    expect(declarations(styles, '.app-notice')).toMatchObject({
      'font-size': 'var(--font-secondary)',
      background: 'var(--surface)',
      'border-bottom': '1px solid var(--line)',
    })
    // 横幅不再通栏染色：白底 + 左侧 2px 色条，正文用对应的 ink 色。
    expect(declarations(styles, '.app-notice.success')).toMatchObject({
      'border-left': '2px solid var(--green)',
      color: 'var(--green-ink)',
    })
    expect(declarations(styles, '.app-notice.error')).toMatchObject({
      'border-left': '2px solid var(--red)',
      color: 'var(--red-ink)',
    })
    // pin 是 ghost 按钮：--line 描边 + --text 文字，按下才用淡蓝底强调。
    expect(declarations(styles, '.app-notice-pin')).toMatchObject({
      'font-size': 'var(--font-aux)',
      'line-height': 'var(--line-aux)',
      'border-radius': 'var(--radius-sm)',
      border: '1px solid var(--line)',
      color: 'var(--text)',
    })
    expect(declarations(styles, '.app-notice-pin[aria-pressed="true"]')).toMatchObject({
      background: 'var(--blue-soft)',
    })
  })

  it('keeps the recent-repository menu on the same tokens', () => {
    expect(declarations(styles, '.recent-repositories-menu')).toMatchObject({
      border: '1px solid var(--line)',
      'border-radius': 'var(--radius-lg)',
      'box-shadow': 'var(--shadow-modal)',
    })
    expect(declarations(styles, '.recent-repository:hover,.recent-repository:focus,.recent-repository:focus-visible')).toMatchObject({
      background: 'var(--hover)',
    })
    // 当前项与侧栏选中行同观感：整行浅底 + 左侧 2px 蓝条，hover 深一级。
    expect(declarations(styles, '.recent-repository.current')).toMatchObject({
      background: 'var(--hover)',
      'box-shadow': 'inset 2px 0 var(--blue)',
    })
    expect(
      declarations(styles, '.recent-repository.current:hover,.recent-repository.current:focus,.recent-repository.current:focus-visible'),
    ).toMatchObject({ background: 'var(--active)' })
    expect(declarations(styles, '.recent-repository-badge')).toMatchObject({ color: 'var(--blue)' })
    // 路径/失效提示统一到 11px，失效项用 --faint（只做装饰性弱化）。
    expect(declarations(styles, '.recent-repository-path')['font']).toBe('var(--font-aux) var(--mono)')
    expect(declarations(styles, '.recent-repository-missing')).toMatchObject({ 'font-size': 'var(--font-aux)' })
    expect(declarations(styles, '.recent-repository.missing')).toMatchObject({ color: 'var(--faint)' })
    expect(declarations(styles, '.recent-repository.missing .recent-repository-path')).toMatchObject({
      color: 'var(--faint)',
    })
  })

  it('never uses the disabled grey for text that has to be read', () => {
    const readable = [
      '.ledger-glance time',
      '.ledger-entry-meta',
      '.remote-status b',
      '.diff-line>.diff-line-number',
      '.diff-line>.diff-marker',
      '.ledger-facts',
      '.commit-meta',
      '.full-time',
      '.file-dir',
      '.current-file-path',
    ]
    for (const selector of readable) {
      const values = declarations(styles, selector)
      expect(values, selector).not.toBeNull()
      expect(values.color, selector).not.toMatch(/#(a1a1a1|98a2b3|b6c0ca|8d97a6)/i)
    }
  })
})

describe('Design tokens: 按钮三档', () => {
  it('makes the primary button the solid text colour with hover/active steps', () => {
    expect(declarations(styles, '.primary-button,.primary-action')).toMatchObject({
      height: '32px',
      'border-radius': 'var(--radius)',
      background: '#20252d',
      color: '#fff',
      'font-size': 'var(--font-body)',
    })
    expect(
      declarations(styles, '.primary-button:not(:disabled):hover,.primary-action:not(:disabled):hover'),
    ).toMatchObject({ background: '#2b323c' })
    expect(
      declarations(styles, '.primary-button:not(:disabled):active,.primary-action:not(:disabled):active'),
    ).toMatchObject({ background: '#171b21' })
    // 禁用态回到中性灰底：页面上永远只有一个"看起来实心"的主按钮。
    expect(
      declarations(
        styles,
        '.primary-button:disabled,.primary-action:disabled,.secondary-button:disabled,.secondary-action:disabled,.sync-action:disabled,.remote-actions button:disabled',
      )['background'],
    ).toBe('var(--sunken)')
  })

  it('uses one disabled formula for primary, secondary and remote buttons', () => {
    const formula = {
      background: 'var(--sunken)',
      'border-color': 'var(--line)',
      color: 'var(--faint)',
      opacity: '1',
    }
    expect(
      declarations(
        styles,
        '.primary-button:disabled,.primary-action:disabled,.secondary-button:disabled,.secondary-action:disabled,.sync-action:disabled,.remote-actions button:disabled',
      ),
    ).toMatchObject(formula)
    expect(declarations(styles, '.remote-actions button:disabled')).toBeNull()
    expect(declarations(styles, '.secondary-button:disabled,.secondary-action:disabled,.sync-action:disabled')).toBeNull()
  })

  it('gives the secondary tier a 1px neutral border and a 32px height', () => {
    expect(declarations(styles, '.secondary-button,.secondary-action,.sync-action')).toMatchObject({
      height: '32px',
      border: '1px solid var(--line)',
      background: 'var(--surface)',
      color: 'var(--text)',
      'font-size': 'var(--font-body)',
    })
  })

  it('uses 30px for the title-bar chrome and 28px for in-panel icon buttons', () => {
    expect(declarations(styles, '.toolbar-button,.top-action')).toMatchObject({
      height: '30px',
      'border-radius': 'var(--radius)',
      'font-size': 'var(--font-body)',
    })
    expect(declarations(styles, '.icon-button')).toMatchObject({
      width: '28px',
      height: '28px',
      'border-radius': 'var(--radius)',
    })
    // 顶栏里的按钮统一 30px（文字按钮与纯图标按钮都不例外）。
    expect(styles).toMatch(/\.top-actions \.toolbar-button,\.top-actions \.top-action,\.top-actions \.icon-button\{height:30px\}/)
    expect(styles).toMatch(/\.top-actions \.icon-button\{width:30px\}/)
  })

  it('sizes form controls to 30px with a visible focus ring', () => {
    expect(declarations(styles, '.inspector-flow input')).toMatchObject({
      height: '30px',
      border: '1px solid var(--line)',
      'border-radius': 'var(--radius)',
    })
    expect(declarations(styles, '.history-filters input,.history-filters select')).toMatchObject({
      height: '30px',
      border: '1px solid var(--line)',
    })
    // 交接稿：提交说明初始高度 82–96px。
    expect(declarations(styles, '.context-panel textarea')).toMatchObject({ 'min-height': '88px' })
    expect(
      declarations(styles, 'button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible'),
    ).toMatchObject({ outline: '2px solid var(--ring)' })
  })

  it('gives modals and plan cards the 10px radius and the light shadow', () => {
    for (const selector of ['.update-dialog', '.command-palette']) {
      expect(declarations(styles, selector), selector).toMatchObject({
        'border-radius': 'var(--radius-lg)',
        'box-shadow': 'var(--shadow-modal)',
        border: '1px solid var(--line)',
      })
    }
    expect(declarations(styles, '.planned-command')).toMatchObject({ 'border-radius': 'var(--radius-lg)' })
  })

  it('gives every tier hover, active and disabled states', () => {
    for (const selector of [
      '.primary-button:not(:disabled):hover,.primary-action:not(:disabled):hover',
      '.primary-button:not(:disabled):active,.primary-action:not(:disabled):active',
      '.secondary-button:not(:disabled):hover,.secondary-action:not(:disabled):hover,.sync-action:not(:disabled):hover',
      '.secondary-button:not(:disabled):active,.secondary-action:not(:disabled):active,.sync-action:not(:disabled):active',
      '.toolbar-button:not(:disabled):hover,.top-action:not(:disabled):hover',
      '.toolbar-button:not(:disabled):active,.top-action:not(:disabled):active',
      '.icon-button:not(:disabled):hover',
      '.icon-button:not(:disabled):active',
    ]) {
      expect(declarations(styles, selector), selector).not.toBeNull()
    }
    // 低权重按钮仍只降透明度：不写 width/height/padding/margin/border，避免禁用态改变布局。
    const disabled = declarations(styles, 'button:disabled')
    expect(disabled).toMatchObject({
      cursor: 'not-allowed',
      'pointer-events': 'none',
      opacity: '.5',
    })
    for (const property of ['width', 'height', 'padding', 'margin', 'border']) {
      expect(disabled[property], property).toBeUndefined()
    }
  })

  it('keeps the legacy class names as aliases of the new tiers', () => {
    expect(styles).toMatch(/\.primary-button,\.primary-action\{/)
    expect(styles).toMatch(/\.secondary-button,\.secondary-action,\.sync-action\{/)
    expect(styles).toMatch(/\.toolbar-button,\.top-action\{/)
    expect(declarations(styles, '.text-action')).not.toBeNull()
    // 低权重的红字动作直接复用 .text-action，不再保留一个独立的 .danger-outline 变体。
    expect(declarations(styles, '.danger-text')).toMatchObject({ color: 'var(--red)' })
    expect(styles).not.toContain('.danger-outline{')
  })

  it('renders the brand mark and repo name at the handoff sizes', () => {
    expect(declarations(styles, '.brand h1')).toMatchObject({ 'font-size': '13px', 'font-weight': '650' })
    expect(declarations(styles, '.brand strong')).toMatchObject({
      'font-size': '12px',
      color: 'var(--muted)',
    })
  })
})

describe('Design tokens: 顶栏层次', () => {
  it('splits the top bar into left, view-switch and actions groups', () => {
    // 48px 应用栏 + 三列 grid：左组、居中的视图切换、右动作组。
    expect(declarations(styles, '.topbar')).toMatchObject({
      display: 'grid',
      'grid-template-columns': 'minmax(0,1fr) auto minmax(0,1fr)',
      height: '48px',
      '-webkit-app-region': 'drag',
    })
    expect(declarations(styles, '.view-switch')).toMatchObject({ display: 'flex', 'justify-self': 'center' })
    // 当前视图：蓝色下划线 + aria-pressed 语义，不只靠颜色。
    expect(declarations(styles, '.view-tab[aria-pressed="true"]')).toMatchObject({
      color: 'var(--blue)',
      'box-shadow': 'inset 0 -2px var(--blue)',
    })
    const topbar = renderer.slice(
      renderer.indexOf('<header className="topbar">'),
      renderer.indexOf('</header>'),
    )
    // 左组：品牌 + 仓库名 + 分支 + 改动状态；中组：工作区 / 历史审查；右组：动作区。
    expect(topbar).toContain('className="topbar-group topbar-left"')
    expect(topbar).toContain('className="view-switch"')
    expect(topbar).toContain('className="topbar-group top-actions"')
    expect((topbar.match(/className="view-tab"/g) || []).length).toBe(2)
    // 打开仓库 / 获取… 是次按钮（描边），命令 / 恢复是低权重工具条。
    expect(topbar).toMatch(/className="secondary-button"[^>]*aria-label="打开仓库"/)
    expect(topbar).toMatch(/className="secondary-button"[^>]*aria-label="获取远程更新/)
    expect((topbar.match(/className="toolbar-button"/g) || []).length).toBe(2)
    // 顶栏唯一的实心按钮是「更新」：平时是 30×30 的纯图标按钮，只有下载完成、等待重启时才展开成实心「更新」。
    expect(updates).toMatch(/\$\{ready \? 'primary-button' : 'icon-button'\} update-trigger/)
    expect(updates).toContain("aria-label={ready ? '更新已就绪' : '检查更新'}")
    expect(topbar).not.toContain('primary-button')
    expect(topbar).not.toContain('primary-action')
  })

  it('requires title and aria-label on every icon-only button', () => {
    const iconButtons = [...renderer.matchAll(/<button\b[^>]*>/g)]
      .map((match) => match[0])
      .filter((tag) => tag.includes('"icon-button"'))
    expect(iconButtons.length).toBeGreaterThanOrEqual(2)
    for (const tag of iconButtons) {
      expect(tag).toContain('aria-label')
      expect(tag).toMatch(/\btitle=/)
    }
  })
})

describe('Design tokens: Diff 与右栏', () => {
  it('keeps one breadcrumb file row for renames and multi-file results', () => {
    // presentDiff 只产出 type='file' 的一行（路径或「旧 → 新」），工作区单文件视图在标题里已经有路径时由
    // diff-presentation.js 去掉这一行；样式本身仍然保留给重命名与多文件结果。
    expect(declarations(styles, '.diff-line.file')).toMatchObject({
      display: 'flex',
      'font-size': 'var(--font-secondary)',
      'font-weight': '600',
      background: 'var(--code)',
    })
    expect(styles).not.toContain('.diff-line.file-path')
    expect(styles).not.toMatch(/\.diff-line\.file \.diff-label/)
  })

  it('draws changed rows with the handoff tints and keeps only changed lines coloured', () => {
    expect(declarations(styles, '.diff-line.plus')).toMatchObject({ background: 'var(--green-wash)', color: 'var(--green-ink)' })
    expect(declarations(styles, '.diff-line.minus')).toMatchObject({ background: 'var(--red-wash)', color: 'var(--red-ink)' })
    // 行号与 +/- 符号与行底色同底，只用深色文字标识。
    expect(declarations(styles, '.diff-line.plus .diff-line-number,.diff-line.plus .diff-marker')).toMatchObject({
      background: 'transparent',
      color: 'var(--green-ink)',
    })
    // 上下文行不染色。
    expect(declarations(styles, '.diff-line.context')).toBeNull()
    // Diff 正文 12px / 行高 22px。
    expect(declarations(styles, '.diff-content')).toMatchObject({
      font: 'var(--font-diff)/var(--line-diff) var(--mono)',
    })
  })

  it('separates the current-file section from the commit section with one hairline', () => {
    expect(declarations(styles, '.commit-panel')).toMatchObject({
      'margin-top': '18px',
      'padding-top': '16px',
      'border-top': '1px solid var(--line)',
    })
    expect(declarations(styles, '.current-file-name')).toMatchObject({
      'font-size': 'var(--font-title)',
      'font-weight': '600',
    })
    // 命令预览只在有确定命令时出现，标题与代码分两层。
    expect(declarations(styles, '.command-preview')).toMatchObject({ background: 'var(--sidebar)' })
    expect(declarations(styles, '.command-preview code')['font']).toBe('var(--font-secondary)/1.5 var(--mono)')
  })

  it('keeps the collapsed ledger bar at 36px and the summary on one line', () => {
    expect(declarations(styles, '.ledger-bar')['min-height']).toBe('35px')
    expect(declarations(styles, '.app-shell')['grid-template-rows']).toBe('48px minmax(0,1fr) 36px')
    expect(declarations(styles, '.ledger-glance-source')).toMatchObject({ color: 'var(--muted)' })
  })

  it('restyles the native scrollbars without taking away native behaviour', () => {
    expect(declarations(styles, '::-webkit-scrollbar')).toMatchObject({ width: '8px', height: '8px' })
    expect(declarations(styles, '::-webkit-scrollbar-track,::-webkit-scrollbar-corner')).toMatchObject({
      background: 'transparent',
    })
    expect(declarations(styles, '::-webkit-scrollbar-thumb')).toMatchObject({ 'border-radius': '4px' })
    expect(declarations(styles, '::-webkit-scrollbar-thumb:hover')).toMatchObject({ background: 'var(--faint)' })
    // 不接管滚动：不用 scrollbar-width 关闭原生行为，也不隐藏滚动条。
    expect(styles).not.toContain('scrollbar-width')
    expect(styles).not.toContain('scrollbar-gutter')
  })
})
