const { parseRefs, buildHead, REF_ARGV } = require('../../electron/git-refs.cjs')

const MAIN = '1111111111111111111111111111111111111111'
const FEATURE = '2222222222222222222222222222222222222222'
const MERGE = '3333333333333333333333333333333333333333'
const ANNOTATED_OBJECT = '4444444444444444444444444444444444444444'
const TREE_OBJECT = '5555555555555555555555555555555555555555'

function row(fullName, objectName, objectType, peeledName = '', peeledType = '', symref = '', head = ' ') {
  return [fullName, objectName, objectType, peeledName, peeledType, symref, head].join('\t')
}

describe('Git ref parsing', () => {
  it('reads a fixed for-each-ref range without accepting renderer argv', () => {
    expect(REF_ARGV).toEqual([
      'for-each-ref',
      '--format=%(refname)%09%(objectname)%09%(objecttype)%09%(*objectname)%09%(*objecttype)%09%(symref)%09%(HEAD)',
      'refs/heads',
      'refs/remotes',
      'refs/tags',
    ])
  })

  it('keeps full names and full commit ids while distinguishing equal short names', () => {
    const refs = parseRefs([
      row('refs/heads/main', MAIN, 'commit', '', '', '', '*'),
      row('refs/heads/release', FEATURE, 'commit'),
      row('refs/tags/release', FEATURE, 'commit'),
      row('refs/remotes/origin/main', MAIN, 'commit'),
      row('refs/remotes/origin/HEAD', MAIN, 'commit', '', '', 'refs/remotes/origin/main'),
    ].join('\n'))

    expect(refs.map((ref) => ref.fullName)).toEqual([
      'refs/heads/main',
      'refs/heads/release',
      'refs/tags/release',
      'refs/remotes/origin/main',
      'refs/remotes/origin/HEAD',
    ])
    expect(refs[0]).toMatchObject({ shortName: 'main', kind: 'local', commit: MAIN, head: true })
    expect(refs[1]).toMatchObject({ shortName: 'release', kind: 'local', commit: FEATURE })
    expect(refs[2]).toMatchObject({ shortName: 'release', kind: 'tag', commit: FEATURE })
    expect(refs[2].fullName).not.toBe(refs[1].fullName)
    expect(refs[4]).toMatchObject({
      kind: 'alias',
      shortName: 'origin/HEAD',
      targetRef: 'refs/remotes/origin/main',
      targetShortName: 'origin/main',
      commit: MAIN,
    })
  })

  it('peels annotated tags to the commit and explains tags that do not point at a commit', () => {
    const refs = parseRefs([
      row('refs/tags/annotated', ANNOTATED_OBJECT, 'tag', MERGE, 'commit'),
      row('refs/tags/lightweight', FEATURE, 'commit'),
      row('refs/tags/tree-only', ANNOTATED_OBJECT, 'tag', TREE_OBJECT, 'tree'),
    ].join('\n'))

    expect(refs[0]).toMatchObject({ annotated: true, commit: MERGE, status: '' })
    expect(refs[1]).toMatchObject({ annotated: false, commit: FEATURE, status: '' })
    expect(refs[2]).toMatchObject({ annotated: true, commit: '', status: expect.stringContaining('不是提交') })
    // The tag object id is retained for audit, but never becomes the target commit.
    expect(refs[2].objectName).toBe(ANNOTATED_OBJECT)
  })

  it('drops the stale commit id of an alias whose target remote branch is missing', () => {
    const refs = parseRefs(row('refs/remotes/origin/HEAD', MAIN, 'commit', '', '', 'refs/remotes/origin/gone'))
    expect(refs[0]).toMatchObject({
      kind: 'alias',
      targetRef: 'refs/remotes/origin/gone',
      targetShortName: 'origin/gone',
      commit: '',
      status: '目标分支不存在',
    })
  })

  it('drops a trailing partial record when for-each-ref output was truncated', () => {
    const complete = row('refs/tags/complete', FEATURE, 'commit')
    const partial = 'refs/tags/cut-off\t111111111111111111111111111111111111'
    expect(parseRefs(`${complete}\n${partial}`, { truncated: true })).toHaveLength(1)
    expect(parseRefs(`${complete}\n${partial}`, { truncated: true })[0]).toMatchObject({
      fullName: 'refs/tags/complete',
      commit: FEATURE,
    })
  })

  it('builds detached and unborn HEAD states without inventing a commit', () => {
    const detached = buildHead({ symbolicRef: '', headCommit: `${MAIN}\n`, refs: [] })
    expect(detached).toMatchObject({ fullName: 'HEAD', shortName: 'HEAD', commit: MAIN, detached: true, unborn: false })

    const unborn = buildHead({ symbolicRef: 'refs/heads/main\n', headCommit: '', refs: [] })
    expect(unborn).toMatchObject({ fullName: 'refs/heads/main', shortName: 'main', commit: '', detached: false, unborn: true })
    expect(unborn.status).toContain('还没有提交')

    const head = buildHead({
      symbolicRef: 'refs/heads/main',
      headCommit: MAIN,
      refs: [{ fullName: 'refs/heads/main', shortName: 'main', commit: MAIN }],
    })
    expect(head).toMatchObject({ fullName: 'refs/heads/main', shortName: 'main', commit: MAIN, symbolic: true })
  })
})
