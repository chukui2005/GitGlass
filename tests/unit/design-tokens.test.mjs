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
describe('Design tokens: dbx 中性色板', () => {
  it('carries the dbx light-theme neutrals', () => {
    expect(declarations(styles, ':root')).toMatchObject({
      '--app': '#fff',
      '--surface': '#fff',
      '--sidebar': '#fafafa',
      '--sunken': '#fafafa',
      '--hover': '#f5f5f5',
      '--active': '#f3f3f3',
      '--code': '#f3f3f3',
      '--text': '#0a0a0a',
      '--muted': '#737373',
      '--faint': '#a1a1a1',
      '--line': '#e5e5e5',
      '--line-strong': '#d4d4d4',
      '--ring': '#a1a1a1',
    })
  })

  it('keeps the status colours and the brand blue as an accent only', () => {
    expect(declarations(styles, ':root')).toMatchObject({
      '--green': '#16a34a',
      '--orange': '#d97706',
      '--red': '#e7000b',
      '--blue': '#2563eb',
      '--blue-soft': '#eff6ff',
    })
    // 品牌蓝不再当主按钮底色：主按钮是近黑。
    expect(declarations(styles, '.primary-button,.primary-action').background).toBe('#171717')
  })

  it('uses the 4 / 6 / 10px radius scale and a single modal shadow token', () => {
    expect(declarations(styles, ':root')).toMatchObject({
      '--radius-sm': '4px',
      '--radius': '6px',
      '--radius-lg': '10px',
      '--shadow-modal': '0 12px 32px rgba(0,0,0,.10)',
    })
  })

  it('keeps the 13 / 12 / 11px type scale', () => {
    expect(declarations(styles, ':root')).toMatchObject({
      '--font-body': '13px',
      '--line-body': '1.5',
      '--font-secondary': '12px',
      '--line-secondary': '1.45',
      '--font-aux': '11px',
      '--line-aux': '1.4',
    })
    expect(styles).toContain('正文 13px/1.5')
    expect(styles).toContain('辅助 11px/1.4')
  })

  it('leaves no 10px text behind anywhere in the stylesheet', () => {
    // 通知条与最近仓库菜单现在也走 token，所以整份 styles.css 都不允许再出现 10px 正文。
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
    // hover 中性浅底；蓝色只保留给「当前仓库」标记与徽标。
    expect(declarations(styles, '.recent-repository:hover,.recent-repository:focus,.recent-repository:focus-visible')).toMatchObject({
      background: 'var(--hover)',
    })
    expect(declarations(styles, '.recent-repository.current')['box-shadow']).toBe('inset 2px 0 var(--blue)')
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
    ]
    for (const selector of readable) {
      const values = declarations(styles, selector)
      expect(values, selector).not.toBeNull()
      expect(values.color, selector).not.toMatch(/#(a1a1a1|98a2b3|b6c0ca)/i)
    }
  })
})

describe('Design tokens: 按钮三档（dbx 度量）', () => {
  it('makes the primary button near-black with dbx hover/active steps', () => {
    expect(declarations(styles, '.primary-button,.primary-action')).toMatchObject({
      height: '32px',
      'border-radius': 'var(--radius)',
      background: '#171717',
      color: '#fafafa',
      'font-size': 'var(--font-body)',
    })
    expect(
      declarations(styles, '.primary-button:not(:disabled):hover,.primary-action:not(:disabled):hover'),
    ).toMatchObject({ background: '#262626' })
    expect(
      declarations(styles, '.primary-button:not(:disabled):active,.primary-action:not(:disabled):active'),
    ).toMatchObject({ background: '#0a0a0a' })
    // 禁用态回到中性灰底：页面上永远只有一个"看起来实心"的主按钮（完整公式见下一组用例）。
    expect(
      declarations(
        styles,
        '.primary-button:disabled,.primary-action:disabled,.secondary-button:disabled,.secondary-action:disabled,.sync-action:disabled,.remote-actions button:disabled',
      )['background'],
    ).toBe('var(--sunken)')
  })

  it('uses one disabled formula for primary, secondary and remote buttons', () => {
    // 以前主/次按钮靠全局 opacity:.5，远程动作按钮用 --sunken + --faint，深浅不一致；
    // 现在三条档位共用同一组声明，只有低权重按钮还保留透明度兜底。
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
    // 远端按钮不允许再有一套自己的禁用底色（它只出现在上面那条共用规则里）。
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

  it('sizes form controls to 30px with a neutral focus ring', () => {
    expect(declarations(styles, '.inspector-flow input')).toMatchObject({
      height: '30px',
      border: '1px solid var(--line)',
      'border-radius': 'var(--radius)',
    })
    expect(declarations(styles, '.history-filters input,.history-filters select')).toMatchObject({
      height: '30px',
      border: '1px solid var(--line)',
    })
    expect(declarations(styles, '.context-panel textarea')).toMatchObject({ 'min-height': '96px' })
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
    // 低权重按钮仍只降透明度（dbx disabled:opacity-50）：不写 width/height/padding/margin/border，避免禁用态改变布局。
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
    expect(declarations(styles, '.danger-outline')).not.toBeNull()
  })

  it('renders the brand mark and repo name at dbx sizes', () => {
    expect(declarations(styles, '.brand h1')).toMatchObject({ 'font-size': '13px', 'font-weight': '650' })
    expect(declarations(styles, '.brand strong')).toMatchObject({
      'font-size': '12px',
      color: 'var(--muted)',
    })
  })
})

describe('Design tokens: 顶栏层次', () => {
  it('ranks the toolbar by weight and keeps the solid button for the update entry only', () => {
    const topbar = renderer.slice(
      renderer.indexOf('<div className="top-actions">'),
      renderer.indexOf('</header>'),
    )
    // 打开仓库 / 获取… 是次按钮（描边）。
    expect(topbar).toMatch(/className="secondary-button"[^>]*aria-label="打开仓库"/)
    expect(topbar).toMatch(/className="secondary-button"[^>]*aria-label="获取远程更新/)
    // 命令 / 工作区 / 历史审查 / 恢复 是图标 + 小字的低权重工具条。
    expect((topbar.match(/className="toolbar-button"/g) || []).length).toBe(4)
    // 顶栏唯一的实心按钮是「更新」：平时是 30×30 的纯图标按钮，只有下载完成、等待重启时才展开成黑底「更新」。
    expect(updates).toMatch(/\$\{ready \? 'primary-button' : 'icon-button'\} update-trigger/)
    expect(updates).toContain("aria-label={ready ? '更新已就绪' : '检查更新'}")
    expect(topbar).not.toContain('primary-button')
    expect(topbar).not.toContain('primary-action')
  })

  it('requires title and aria-label on every icon-only button', () => {
    const iconButtons = [...renderer.matchAll(/<button\b[^>]*>/g)]
      .map((match) => match[0])
      .filter((tag) => tag.includes('"icon-button"'))
    expect(iconButtons.length).toBeGreaterThanOrEqual(3)
    for (const tag of iconButtons) {
      expect(tag).toContain('aria-label')
      expect(tag).toMatch(/\btitle=/)
    }
  })
})

describe('Design tokens: Diff 文件头', () => {
  it('renders one 12px/600 breadcrumb row instead of three header lines', () => {
    // presentDiff 只产出 type='file' 的一行（路径或「旧 → 新」），CSS 侧不再有原文件/新文件两列。
    expect(declarations(styles, '.diff-line.file')).toMatchObject({
      display: 'flex',
      'font-size': 'var(--font-secondary)',
      'font-weight': '600',
      background: 'var(--code)',
    })
    expect(styles).not.toContain('.diff-line.file-path')
    expect(styles).not.toMatch(/\.diff-line\.file \.diff-label/)
  })
})
