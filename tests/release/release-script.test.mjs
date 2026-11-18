import { describe, expect, it } from 'vitest'
import { nextBetaVersion, parseConventionalSubject, renderChangelogSection, selectPreviousTag } from '../../scripts/release.mjs'

function commit(subject, hash = 'a'.repeat(40)) {
  const parsed = parseConventionalSubject(subject)
  const shortHash = hash.slice(0, 7)
  return {
    hash,
    shortHash,
    subject,
    summary: parsed?.summary ?? subject,
    bullet: `* ${parsed?.summary ?? subject} ([${shortHash}](https://github.com/chukui2005/GitGlass/commit/${hash}))`,
  }
}

describe('manual release helpers', () => {
  it('parses conventional subjects and flags breaking changes', () => {
    expect(parseConventionalSubject('feat(updater): add in-app updates')).toEqual({ type: 'feat', breaking: false, summary: 'add in-app updates' })
    expect(parseConventionalSubject('fix!: drop legacy cache')).toEqual({ type: 'fix', breaking: true, summary: 'drop legacy cache' })
    expect(parseConventionalSubject('Merge pull request #1 from someone/branch')).toBeNull()
    expect(parseConventionalSubject('random text')).toBeNull()
  })

  it('groups only user-facing commits into the changelog section', () => {
    const commits = [
      commit('feat(history): filter by author', 'f'.repeat(40)),
      commit('fix(updater): keep the cached installer', 'a'.repeat(40)),
      commit('docs: refresh the README'),
      commit('chore(release): 0.6.2'),
      commit('test: group tests by layer'),
      commit('perf(diff): render fewer rows'),
    ]
    const section = renderChangelogSection(commits, { version: '0.6.2', previousTag: 'v0.6.1', date: '2026-11-18' })

    expect(section).toContain('## [0.6.2](https://github.com/chukui2005/GitGlass/compare/v0.6.1...v0.6.2) (2026-11-18)')
    expect(section).toContain('### Features')
    expect(section).toContain('filter by author')
    expect(section).toContain('### Bug Fixes')
    expect(section).toContain('keep the cached installer')
    expect(section).toContain('### Performance')
    expect(section).toContain('render fewer rows')
    expect(section).not.toContain('refresh the README')
    expect(section).not.toContain('group tests by layer')
    expect(section).not.toContain('chore(release)')
  })

  it('marks breaking changes and keeps them out of the ordinary sections', () => {
    const section = renderChangelogSection([commit('feat!: drop the legacy update channel')], {
      version: '0.7.0',
      previousTag: 'v0.6.10',
      date: '2026-11-18',
    })
    expect(section).toContain('### ⚠ BREAKING CHANGES')
    expect(section).toContain('drop the legacy update channel')
    expect(section).toContain('### Features')
  })

  it('numbers beta tags from the highest sequence already used that day', () => {
    expect(nextBetaVersion('0.6.2', [], '20261118')).toBe('0.6.2-beta.20261118.1')
    expect(nextBetaVersion('0.6.2', ['v0.6.2-beta.20261118.1', 'v0.6.2-beta.20261118.3', 'v0.6.2-beta.20261117.9'], '20261118'))
      .toBe('0.6.2-beta.20261118.4')
    // A withdrawn beta leaves its number behind: never reuse a lower sequence.
    expect(nextBetaVersion('0.6.2', ['v0.6.2-beta.20261118.7'], '20261118')).toBe('0.6.2-beta.20261118.8')
  })
})

describe('previous release selection', () => {
  it('counts prerelease tags so the changelog does not start from the first commit', () => {
    expect(selectPreviousTag(['v0.5.6-beta.1', 'v0.6.0-beta.1', 'v0.6.1-beta.1'], '0.6.1')).toBe('v0.6.1-beta.1')
  })

  it('picks the highest tag at or below the current version', () => {
    expect(selectPreviousTag(['v0.6.1', 'v0.6.2', 'v0.6.10'], '0.6.2')).toBe('v0.6.2')
    expect(selectPreviousTag(['v0.6.9', 'v0.6.10'], '0.6.10')).toBe('v0.6.10')
  })

  it('ignores noise and reports no previous release for a fresh repository', () => {
    expect(selectPreviousTag([], '0.6.1')).toBeNull()
    expect(selectPreviousTag(['nightly', 'not-a-tag'], '0.6.1')).toBeNull()
    expect(selectPreviousTag(['nightly', 'v0.6.1-beta.1'], '0.6.1')).toBe('v0.6.1-beta.1')
  })
})