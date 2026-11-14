import { describe, expect, it } from 'vitest'
import { isBlockingContextOpen, isMacPlatform, isTextEditingTarget, resolveShortcut, shortcutLabel } from '../src/shortcut-policy.js'
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

  it('IME、裸 S 与 loading 均不会越权触发 Git 操作', () => {
    expect(resolveShortcut(event('k', { isComposing: true }))).toBeNull()
    expect(resolveShortcut({ key: 's', target: { tagName: 'DIV' } })).toBeNull()
    expect(resolveShortcut(event('j', { isComposing: true }))).toBeNull()
    expect(resolveShortcut({ key: 'Escape', target: { tagName: 'DIV' } }, { paletteOpen: true, loading: true })).toBe('close-palette')
    expect(resolveShortcut({ key: 'Escape', target: { tagName: 'DIV' } }, { loading: true })).toBeNull()
    expect(resolveShortcut(event('k'), { loading: true })).toBeNull()
    expect(resolveShortcut(event('j'), { loading: true })).toBeNull()
    expect(resolveShortcut(event('f'), { loading: true, historyMode: true })).toBeNull()
    expect(isTextEditingTarget({ tagName: 'SELECT' })).toBe(true)
  })

  it('所有确认与恢复上下文都会阻断非 Escape 快捷键', () => {
    const contexts = [
      { paletteOpen: true },
      { safetyPlan: { kind: 'discard' } },
      { branchPlan: { name: 'feature/next' } },
      { remotePlan: { kind: 'push' } },
      { recoveryOpen: true },
    ]
    for (const context of contexts) {
      const blockingContextOpen = isBlockingContextOpen(context)
      expect(blockingContextOpen).toBe(true)
      expect(resolveShortcut(event('k'), { ...context, blockingContextOpen })).toBeNull()
      expect(resolveShortcut(event('j'), { ...context, blockingContextOpen })).toBeNull()
    }
  })

  it('丢弃确认输入框中的 Escape 会取消计划，但 loading 时不会中断执行', () => {
    const discardNameInput = { tagName: 'INPUT', id: 'discard-file-name' }
    expect(resolveShortcut({ key: 'Escape', target: discardNameInput }, { blockingContextOpen: true })).toBe('escape')
    expect(resolveShortcut({ key: 'Escape', target: discardNameInput }, { blockingContextOpen: true, loading: true })).toBeNull()
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
    expect(loading.historySearch.available).toBe(false)
    expect(loading.ledger.available).toBe(false)
    expect(loading.workspace.available).toBe(false)
  })
})
