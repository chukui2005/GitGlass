const { parseStatus, parseBranches, parseCommits, parseCommitDetail } = require('../electron/git-parsers.cjs')

// 测试里统一用 String.fromCharCode 构造分隔符，避免源文件里出现不可见的控制字符。
const RS = String.fromCharCode(30)
const US = String.fromCharCode(31)
const NUL = String.fromCharCode(0)

describe('Git output parsers', () => {
  it('separates staged and unstaged porcelain entries', () => {
    const raw = [' M src/a.js', 'A  src/new.js', 'R  src/after.js', 'src/before.js', '?? notes.md', ''].join(NUL)
    expect(parseStatus(raw)).toEqual([
      { path: 'src/a.js', oldPath: null, status: 'modified', area: 'unstaged' },
      { path: 'src/new.js', oldPath: null, status: 'added', area: 'staged' },
      { path: 'src/after.js', oldPath: 'src/before.js', status: 'renamed', area: 'staged' },
      { path: 'notes.md', oldPath: null, status: 'added', area: 'unstaged' },
    ])
  })
  it('parses local branches and a simple commit graph', () => {
    expect(parseBranches(`main${NUL}*${NUL}abc123\nfeature/a${NUL} ${NUL}def456\n`)).toEqual([
      { name: 'main', current: true, hash: 'abc123' },
      { name: 'feature/a', current: false, hash: 'def456' },
    ])
    expect(parseCommits(`abc${US}parent${US}Subject${US}Ada${US}2026-01-01T00:00:00Z`)).toEqual([
      { hash: 'abc', parents: ['parent'], subject: 'Subject', author: 'Ada', authoredAt: '2026-01-01T00:00:00Z' },
    ])
  })
  it('parses the V0.5.2 eight-field history format including author email and refs', () => {
    const row1 = ['fullhash0000000000000000000000000000000001', 'abc1234', 'parent1', 'feat: add search', 'Ada', 'ada@example.test', '2026-11-01T10:00:00+08:00', 'HEAD -> main, origin/main'].join(US)
    const row2 = ['fullhash0000000000000000000000000000000002', 'def5678', '', 'init: first', 'Ben', 'ben@example.test', '2026-11-02T11:00:00+08:00', ''].join(US)
    const rows = parseCommits(`${row1}\n${row2}`)
    expect(rows[0]).toMatchObject({
      hash: 'fullhash0000000000000000000000000000000001',
      shortHash: 'abc1234',
      parents: ['parent1'],
      subject: 'feat: add search',
      author: 'Ada',
      authorEmail: 'ada@example.test',
      authoredAt: '2026-11-01T10:00:00+08:00',
      refs: ['HEAD -> main', 'origin/main'],
    })
    expect(rows[1]).toMatchObject({ parents: [], refs: [], authorEmail: 'ben@example.test' })
  })
  it('parses the structured commit detail: message, author, email, date and statistics', () => {
    const raw = [
      'feat: add history search',
      '',
      'Filter the loaded commits locally without extra git calls.',
      `${RS}ena Lovelace${US}ada@example.test${US}2026-11-01T10:00:00+08:00`,
      ' 2 files changed, 10 insertions(+), 2 deletions(-)',
    ].join('\n')
    expect(parseCommitDetail(raw)).toEqual({
      message: 'feat: add history search\n\nFilter the loaded commits locally without extra git calls.',
      subject: 'feat: add history search',
      authorName: 'ena Lovelace',
      authorEmail: 'ada@example.test',
      authoredAt: '2026-11-01T10:00:00+08:00',
      filesChanged: 2,
      insertions: 10,
      deletions: 2,
    })
  })
  it('reports zero statistics when git prints no shortstat line', () => {
    const raw = `feat: empty stat${RS}Ada Lovelace${US}ada@example.test${US}2026-11-01T10:00:00+08:00`
    expect(parseCommitDetail(raw)).toMatchObject({ subject: 'feat: empty stat', filesChanged: 0, insertions: 0, deletions: 0 })
  })
})
