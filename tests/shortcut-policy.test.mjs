import { describe, expect, it } from 'vitest'
import { isMacPlatform, isTextEditingTarget, resolveShortcut, shortcutLabel } from '../src/shortcut-policy.js'
import { commandAvailability } from '../src/command-palette-model.js'

const event = (key, overrides = {}) => ({ key, ctrlKey: true, metaKey: false, target: { tagName: 'DIV' }, ...overrides })

describe('V0.5.5 快捷键策略', () => {
  it('按平台识别并展示 Ctrl / Command', () => {
    expect(isMacPlatform('MacIntel')).toBe(true)
    expect(isMacPlatform('Win32')).toBe(false)
    expect(shortcutLabel('K', 'MacIntel')).toBe('⌘ K')
    expect(shortcutLabel('K', 'Win32')).toBe('Ctrl K')
  })

  it('只在非文本编辑状态打开面板、切换账本，且历史页才聚焦搜索', () => {
    expect(resolveShortcut(event('k'))).toBe('open-palette')
    expect(resolveShortcut(event('j'))).toBe('toggle-ledger')
    expect(resolveShortcut(event('f'), { historyMode: false })).toBeNull()
    expect(resolveShortcut(event('f'), { historyMode: true })).toBe('focus-history-search')
    expect(resolveShortcut(event('k', { target: { tagName: 'INPUT' } }))).toBeNull()
    expect(resolveShortcut(event('j', { target: { tagName: 'TEXTAREA' } }))).toBeNull()
    expect(resolveShortcut(event('f', { target: { isContentEditable: true } }), { historyMode: true })).toBeNull()
  })

  it('仅允许提交输入框内的 Ctrl/Cmd+Enter 在满足安全前提时提交', () => {
    const commitEvent = event('Enter', { target: { tagName: 'TEXTAREA', id: 'commit-message' } })
    expect(resolveShortcut(commitEvent, { hasStaged: true, hasMessage: true, loading: false })).toBe('commit')
    expect(resolveShortcut(commitEvent, { hasStaged: false, hasMessage: true, loading: false })).toBeNull()
    expect(resolveShortcut(commitEvent, { hasStaged: true, hasMessage: false, loading: false })).toBeNull()
    expect(resolveShortcut(commitEvent, { hasStaged: true, hasMessage: true, loading: true })).toBeNull()
  })

  it('IME、裸 S、模态与加载状态均不会越权触发 Git 操作', () => {
    expect(resolveShortcut(event('k', { isComposing: true }))).toBeNull()
    expect(resolveShortcut({ key: 's', target: { tagName: 'DIV' } })).toBeNull()
    expect(resolveShortcut(event('j', { isComposing: true }))).toBeNull()
    expect(resolveShortcut(event('k'), { paletteOpen: true })).toBeNull()
    expect(resolveShortcut({ key: 'Escape', target: { tagName: 'DIV' } }, { paletteOpen: true, loading: true })).toBe('close-palette')
    expect(resolveShortcut({ key: 'Escape', target: { tagName: 'DIV' } }, { loading: true })).toBeNull()
    expect(isTextEditingTarget({ tagName: 'SELECT' })).toBe(true)
  })

  it('无仓库或加载期间会禁用依赖仓库和写入的面板命令', () => {
    const noRepository = commandAvailability({ hasRepository: false, loading: false, historyMode: false })
    expect(noRepository.refresh.available).toBe(false)
    expect(noRepository.history.available).toBe(false)
    expect(noRepository.stageSelected.available).toBe(false)

    const loading = commandAvailability({ hasRepository: true, loading: true, historyMode: true, selectedArea: 'unstaged' })
    expect(loading.openRepository.available).toBe(false)
    expect(loading.refresh.available).toBe(false)
    expect(loading.stageSelected.available).toBe(false)
    expect(loading.historySearch.available).toBe(true)
  })
})
