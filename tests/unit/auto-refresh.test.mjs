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
})
