const { parseStatus, parseBranches, parseCommits } = require('../electron/git-parsers.cjs')

describe('Git output parsers', () => {
  it('separates staged and unstaged porcelain entries', () => {
    expect(parseStatus(' M src/a.js\0A  src/new.js\0R  src/after.js\0src/before.js\0?? notes.md\0')).toEqual([
      { path: 'src/a.js', oldPath: null, status: 'modified', area: 'unstaged' },
      { path: 'src/new.js', oldPath: null, status: 'added', area: 'staged' },
      { path: 'src/after.js', oldPath: 'src/before.js', status: 'renamed', area: 'staged' },
      { path: 'notes.md', oldPath: null, status: 'added', area: 'unstaged' },
    ])
  })
  it('parses local branches and a simple commit graph', () => {
    expect(parseBranches('main\0*\0abc123\nfeature/a\0 \0def456\n')).toEqual([{ name: 'main', current: true, hash: 'abc123' }, { name: 'feature/a', current: false, hash: 'def456' }])
    expect(parseCommits('abc\x1fparent\x1fSubject\x1fAda\x1f2026-01-01T00:00:00Z')).toEqual([{ hash: 'abc', parents: ['parent'], subject: 'Subject', author: 'Ada', authoredAt: '2026-01-01T00:00:00Z' }])
  })
})
