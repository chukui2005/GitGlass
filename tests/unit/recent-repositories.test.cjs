const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { RecentRepositories, describeRecent } = require('../../electron/recent-repositories.cjs')

let directory
afterEach(() => { if (directory) fs.rmSync(directory, { recursive: true, force: true }); directory = null })

function store(options) {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-recent-'))
  return new RecentRepositories(path.join(directory, 'recent-repos.json'), options)
}

describe('RecentRepositories', () => {
  it('starts empty and survives a missing file', () => {
    expect(store().list()).toEqual([])
  })

  it('keeps the newest repository first and de-duplicates', () => {
    const recent = store()
    recent.remember('D:/work/one')
    recent.remember('D:/work/two')
    recent.remember('D:/work/one')
    expect(recent.list()).toEqual([path.resolve('D:/work/one'), path.resolve('D:/work/two')])
  })

  it('caps the list at five entries', () => {
    const recent = store()
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) recent.remember(`D:/work/${name}`)
    expect(recent.list()).toHaveLength(5)
    expect(recent.list()[0]).toBe(path.resolve('D:/work/f'))
    expect(recent.list()).not.toContain(path.resolve('D:/work/a'))
  })

  it('persists across instances', () => {
    const first = store()
    first.remember('D:/work/persisted')
    const reopened = new RecentRepositories(path.join(directory, 'recent-repos.json'))
    expect(reopened.list()).toEqual([path.resolve('D:/work/persisted')])
  })

  it('ignores damaged files and invalid entries', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-recent-'))
    const file = path.join(directory, 'recent-repos.json')
    fs.writeFileSync(file, 'not json')
    expect(new RecentRepositories(file).list()).toEqual([])

    fs.writeFileSync(file, JSON.stringify({ paths: ['D:/ok', 42, '', 'D:/bad\0path'] }))
    expect(new RecentRepositories(file).list()).toEqual(['D:/ok'])
  })

  it('does not grow without bound when the file is huge', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-recent-'))
    const file = path.join(directory, 'recent-repos.json')
    fs.writeFileSync(file, 'x'.repeat(128 * 1024))
    expect(new RecentRepositories(file).list()).toEqual([])
  })

  it('forgets a repository without touching the others', () => {
    const recent = store()
    recent.remember('D:/work/one')
    recent.remember('D:/work/two')
    expect(recent.forget('D:/work/one')).toEqual([path.resolve('D:/work/two')])
  })

  it('ignores a forget request for a path that is not remembered', () => {
    const recent = store()
    recent.remember('D:/work/one')
    recent.remember('D:/work/two')
    expect(recent.forget('D:/work/three')).toEqual([
      path.resolve('D:/work/two'),
      path.resolve('D:/work/one'),
    ])
  })

  it('re-adds a forgotten repository at the front and still de-duplicates', () => {
    const recent = store()
    recent.remember('D:/work/one')
    recent.remember('D:/work/two')
    recent.forget('D:/work/two')
    recent.remember('D:/work/two')
    expect(recent.list()).toEqual([path.resolve('D:/work/two'), path.resolve('D:/work/one')])
  })
})

describe('describeRecent', () => {
  it('keeps the newest-first order and maps existence without reordering', () => {
    const newest = path.resolve('D:/work/newest')
    const older = path.resolve('D:/work/older')
    const described = describeRecent([newest, older], (entry) => entry === older)
    expect(described).toEqual([
      { path: newest, name: 'newest', exists: false },
      { path: older, name: 'older', exists: true },
    ])
  })

  it('falls back to the path itself when it has no folder name', () => {
    const driveRoot = path.parse(process.cwd()).root
    expect(describeRecent([driveRoot], () => true)).toEqual([
      { path: driveRoot, name: driveRoot, exists: true },
    ])
  })

  it('reports an unreadable path as missing instead of throwing', () => {
    expect(describeRecent(['D:/work/one'], () => { throw new Error('EACCES') })).toEqual([
      { path: 'D:/work/one', name: 'one', exists: false },
    ])
    expect(describeRecent(null)).toEqual([])
  })
})
