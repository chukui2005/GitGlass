import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { declarations, fontSizesBelow, withoutRecentRepositories } = require('../support/css-inspect.cjs')

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const styles = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8')
const renderer = fs.readFileSync(path.join(root, 'src', 'main.jsx'), 'utf8')

// 读文件 + 正则的轻量断言：不启动 Electron，也不锁定规则的书写方式，只校验设计 token 与按钮体系存在。
describe('Design tokens: 三档字号与颜色', () => {
  it('defines the 13 / 12 / 11px type scale with matching line heights', () => {
    expect(declarations(styles, ':root')).toMatchObject({
      '--font-body': '13px',
      '--line-body': '1.5',
      '--font-secondary': '12px',
      '--line-secondary': '1.45',
      '--font-aux': '11px',
      '--line-aux': '1.4',
    })
  })

  it('keeps the existing radius token and adds the two smaller steps', () => {
    expect(declarations(styles, ':root')).toMatchObject({
      '--radius': '6px',
      '--radius-sm': '4px',
      '--radius-md': '8px',
    })
  })

  it('keeps --muted at the 5.3:1 grey and documents the three tiers in a comment', () => {
    expect(declarations(styles, ':root')['--muted']).toBe('#667085')
    expect(styles).toContain('正文 13px/1.5')
    expect(styles).toContain('辅助 11px/1.4')
  })

  it('leaves no 10px text behind in the rules this PR owns', () => {
    // `.recent-repositories` 菜单由另一个分支维护，本 PR 不改动它，因此不纳入这条断言。
    expect(fontSizesBelow(withoutRecentRepositories(styles), 11)).toEqual([])
  })

  it('never uses a sub-4.5:1 grey for text that has to be read', () => {
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
      expect(values.color, selector).not.toMatch(/#(98a2b3|b6c0ca|9aa4b2)/i)
    }
  })
})

describe('Design tokens: 按钮三档', () => {
  it('defines the primary, secondary and icon button tiers with their own sizes', () => {
    expect(declarations(styles, '.primary-button,.primary-action')).toMatchObject({
      height: '32px',
      'border-radius': 'var(--radius)',
      'font-size': 'var(--font-body)',
    })
    expect(declarations(styles, '.secondary-button,.secondary-action,.sync-action')).toMatchObject({
      height: '28px',
      'font-size': 'var(--font-secondary)',
    })
    expect(declarations(styles, '.icon-button')).toMatchObject({
      width: '28px',
      height: '28px',
      'border-radius': 'var(--radius-sm)',
    })
    expect(declarations(styles, '.toolbar-button,.top-action')).toMatchObject({
      height: '28px',
      'font-size': 'var(--font-aux)',
    })
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
    // 禁用只降透明度：不写 width/height/padding/margin/border，避免禁用态改变布局。
    const disabled = declarations(styles, 'button:disabled')
    expect(disabled).toMatchObject({
      cursor: 'not-allowed',
      'pointer-events': 'none',
      opacity: '.55',
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

  it('puts no solid primary button in the title bar and ranks the toolbar by weight', () => {
    const topbar = renderer.slice(
      renderer.indexOf('<div className="top-actions">'),
      renderer.indexOf('</header>'),
    )
    expect(topbar).not.toContain('primary-button')
    expect(topbar).not.toContain('primary-action')
    // 打开仓库 / 获取… 是次按钮（描边）。
    expect(topbar).toMatch(/className="secondary-button"[^>]*aria-label="打开仓库"/)
    expect(topbar).toMatch(/className="secondary-button"[^>]*aria-label="获取远程更新/)
    // 命令 / 工作区 / 历史审查 / 恢复 是图标 + 小字的低权重工具条。
    expect((topbar.match(/className="toolbar-button"/g) || []).length).toBe(4)
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
