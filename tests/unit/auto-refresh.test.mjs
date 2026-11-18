import { describe, expect, it } from 'vitest'
import { AUTO_REFRESH_QUIET_MS, shouldRefreshOnChange } from '../../src/auto-refresh.js'

describe('automatic refresh policy', () => {
  it('refreshes when the repository changed outside the app and nothing is busy', () => {
    expect(shouldRefreshOnChange({ hasRepository: true, lastRefreshAt: 0, now: 10_000 })).toBe(true)
    expect(shouldRefreshOnChange({ loading: false, refreshing: false, lastRefreshAt: 0, now: 10_000 })).toBe(true)
  })

  it('ignores an event while a user-visible operation or refresh is loading', () => {
    expect(shouldRefreshOnChange({ loading: true, lastRefreshAt: 0, now: 10_000 })).toBe(false)
  })

  it('ignores an event while a silent refresh is still running', () => {
    expect(shouldRefreshOnChange({ refreshing: true, lastRefreshAt: 0, now: 10_000 })).toBe(false)
  })

  it('keeps a one second quiet window after the previous refresh finished', () => {
    expect(AUTO_REFRESH_QUIET_MS).toBe(1000)
    expect(shouldRefreshOnChange({ lastRefreshAt: 10_000, now: 10_001 })).toBe(false)
    expect(shouldRefreshOnChange({ lastRefreshAt: 10_000, now: 10_999 })).toBe(false)
    expect(shouldRefreshOnChange({ lastRefreshAt: 10_000, now: 11_000 })).toBe(true)
  })

  it('does nothing when no repository is open', () => {
    expect(shouldRefreshOnChange({ hasRepository: false, lastRefreshAt: 0, now: 10_000 })).toBe(false)
  })

  it('lets HEAD and refs changes through the quiet window but keeps index changes quiet', () => {
    // 终端里先 add 再 commit：commit 写 HEAD/refs，必须立刻反映，不能等到窗口聚焦。
    expect(shouldRefreshOnChange({ lastRefreshAt: 10_000, now: 10_100, reason: 'head' })).toBe(true)
    expect(shouldRefreshOnChange({ lastRefreshAt: 10_000, now: 10_100, reason: 'refs' })).toBe(true)
    // index 的变化可能来自我们自己刚跑完的 `git status`，仍要压住以掐断自触发。
    expect(shouldRefreshOnChange({ lastRefreshAt: 10_000, now: 10_100, reason: 'index' })).toBe(false)
    // 窗口聚焦没有 reason，也走静默窗。
    expect(shouldRefreshOnChange({ lastRefreshAt: 10_000, now: 10_100, reason: '' })).toBe(false)
  })

  it('still refuses bypassing events while a refresh or an operation is running', () => {
    expect(shouldRefreshOnChange({ loading: true, lastRefreshAt: 10_000, now: 10_100, reason: 'head' })).toBe(false)
    expect(shouldRefreshOnChange({ refreshing: true, lastRefreshAt: 10_000, now: 10_100, reason: 'refs' })).toBe(false)
  })
})
