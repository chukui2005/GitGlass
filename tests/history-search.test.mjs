import { describe, expect, it } from 'vitest'
import { binaryDiffPattern, changeOf, changeKindLetter, filterCommits, fullLocalTime, isHeadCommit, orderComparePair, relativeTime } from '../src/history-search.js'

const commits = [
  { hash: 'a'.repeat(40), shortHash: 'aaaa111', subject: 'feat: add search filter', author: 'Ada Lovelace', authoredAt: '2026-11-01T10:00:00+08:00', refs: ['HEAD -> main'] },
  { hash: 'b'.repeat(40), shortHash: 'bbbb222', subject: 'fix: rename handling', author: 'Ben', authoredAt: '2026-11-02T10:00:00+08:00', refs: [] },
]

describe('V0.5.2 history search filtering', () => {
  it('returns all commits without filtering when the query is blank', () => {
    for (const blank of ['', '   ', null, undefined]) {
      const result = filterCommits(commits, blank)
      expect(result.filtered).toBe(false)
      expect(result.matches).toHaveLength(2)
    }
  })
  it('filters locally by subject, author name, and short SHA', () => {
    expect(filterCommits(commits, 'search').matches.map((c) => c.subject)).toEqual(['feat: add search filter'])
    expect(filterCommits(commits, '  FEAT: ADD search ').matches).toHaveLength(1)
    expect(filterCommits(commits, 'ben').matches.map((c) => c.author)).toEqual(['Ben'])
    expect(filterCommits(commits, 'aaaa1').matches).toHaveLength(1)
    expect(filterCommits(commits, 'bbbb222').matches).toHaveLength(1)
  })
  it('matches a full SHA prefix, not only the short hash', () => {
    expect(filterCommits(commits, 'a'.repeat(10)).matches).toHaveLength(1)
    expect(filterCommits(commits, 'a'.repeat(10)).matches[0].shortHash).toBe('aaaa111')
  })
  it('reports an empty match set for the no-result empty state', () => {
    const result = filterCommits(commits, '不存在的关键词')
    expect(result.filtered).toBe(true)
    expect(result.matches).toEqual([])
  })
})

describe('V0.5.2 compare ordering', () => {
  const newer = commits[1]
  const older = commits[0]
  it('defaults the base to the earlier commit and the target to the later one', () => {
    const picked = orderComparePair(newer, older)
    expect(picked.base.subject).toBe(older.subject)
    expect(picked.target.subject).toBe(newer.subject)
    const sameOrder = orderComparePair(older, newer)
    expect(sameOrder.base.subject).toBe(older.subject)
    expect(sameOrder.target.subject).toBe(newer.subject)
  })
  it('keeps partial selections untouched', () => {
    expect(orderComparePair(null, newer)).toEqual({ base: null, target: newer })
    expect(orderComparePair(older, null)).toEqual({ base: older, target: null })
  })
  it('falls back to pick order when timestamps cannot be parsed', () => {
    const unknown = { subject: 'no time', author: 'x', hash: 'c'.repeat(40) }
    expect(orderComparePair(unknown, newer)).toEqual({ base: unknown, target: newer })
  })
})

describe('V0.5.2 time and status presentation', () => {
  it('formats relative times in Chinese', () => {
    const at = (iso) => Date.parse(iso)
    expect(relativeTime('2026-11-13T12:00:10+08:00', at('2026-11-13T12:00:30+08:00'))).toBe('刚刚')
    expect(relativeTime('2026-11-13T11:30:00+08:00', at('2026-11-13T12:00:00+08:00'))).toBe('30 分钟前')
    expect(relativeTime('2026-11-13T09:00:00+08:00', at('2026-11-13T12:00:00+08:00'))).toBe('3 小时前')
    expect(relativeTime('2026-11-10T12:00:00+08:00', at('2026-11-13T12:00:00+08:00'))).toBe('3 天前')
    expect(relativeTime('', 0)).toBe('—')
  })
  it('formats the full local time for the tooltip', () => {
    expect(fullLocalTime('2026-11-13T12:00:00+08:00')).toContain('2026')
    expect(fullLocalTime('not a date')).toBe('not a date')
  })
  it('maps name-status codes including rename scores to UI kinds', () => {
    expect(changeOf('A')).toBe('added')
    expect(changeOf('M')).toBe('modified')
    expect(changeOf('D')).toBe('deleted')
    expect(changeOf('R100')).toBe('renamed')
    expect(changeOf('')).toBe('modified')
    expect(changeKindLetter.renamed).toBe('R')
  })
  it('marks the HEAD commit and detects binary diff lines', () => {
    expect(isHeadCommit(commits[0])).toBe(true)
    expect(isHeadCommit(commits[1])).toBe(false)
    expect(binaryDiffPattern.test('Binary files a/logo.png and b/logo.png differ')).toBe(true)
    expect(binaryDiffPattern.test('+ text change')).toBe(false)
  })
})
