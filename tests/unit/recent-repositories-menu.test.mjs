import { describe, expect, it } from 'vitest'
import { buildRecentItems } from '../../src/recent-repositories-menu.jsx'

describe('buildRecentItems', () => {
  it('keeps the newest-first order from the main process', () => {
    const items = buildRecentItems(
      [
        { path: 'C:\\work\\newest', name: 'newest', exists: true },
        { path: 'C:\\work\\older', name: 'older', exists: true },
      ],
      'C:\\work\\older',
    )
    expect(items.map((item) => item.name)).toEqual(['newest', 'older'])
    expect(items.map((item) => item.current)).toEqual([false, true])
  })

  it('caps the menu at five entries and drops duplicates', () => {
    const repositories = ['a', 'b', 'c', 'd', 'e', 'f', 'a'].map((name) => ({
      path: `C:\\work\\${name}`,
      name,
      exists: true,
    }))
    const items = buildRecentItems(repositories, null)
    expect(items.map((item) => item.name)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('compares the current repository across separators and letter case', () => {
    const items = buildRecentItems(
      [{ path: 'C:\\Work\\Repo', name: 'Repo', exists: true }],
      'c:/work/repo/',
    )
    expect(items[0].current).toBe(true)
  })

  it('never marks a repository as current while none is open', () => {
    const items = buildRecentItems([{ path: 'C:\\work\\repo', name: 'repo', exists: true }], null)
    expect(items[0].current).toBe(false)
  })

  it('keeps the exists flag so missing folders can be greyed out', () => {
    const items = buildRecentItems(
      [
        { path: 'C:\\work\\present', name: 'present', exists: true },
        { path: 'C:\\work\\gone', name: 'gone', exists: false },
      ],
      null,
    )
    expect(items.map((item) => item.exists)).toEqual([true, false])
  })

  it('accepts bare path strings and derives the folder name', () => {
    const items = buildRecentItems(['D:\\projects\\alpha', 'D:/projects/beta'], 'D:\\projects\\beta')
    expect(items).toEqual([
      { path: 'D:\\projects\\alpha', name: 'alpha', exists: true, current: false },
      { path: 'D:/projects/beta', name: 'beta', exists: true, current: true },
    ])
  })

  it('ignores empty and malformed entries', () => {
    expect(buildRecentItems(null, 'D:\\repo')).toEqual([])
    expect(buildRecentItems([null, 42, '', {}, { path: '' }, { path: 7 }], 'D:\\repo')).toEqual([])
  })
})
