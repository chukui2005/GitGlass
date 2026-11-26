const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { GitCommandService } = require('../../electron/git-command-service.cjs')
const { RepositoryService } = require('../../electron/repository-service.cjs')

let cwd
afterEach(() => {
  if (cwd) fs.rmSync(cwd, { recursive: true, force: true })
  cwd = null
})

describe('real Git refs truncation', () => {
  it('resolves origin/HEAD target separately when many local branches truncate origin/main out', async () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-ref-truncation-remote-'))
    const bare = path.join(cwd, 'origin.git')
    const commands = new GitCommandService()
    const run = (request) => commands.run({ intent: 'Fixture', source: 'background', cwd, ...request })
    const repository = new RepositoryService(commands, () => cwd)

    expect((await run({ argv: ['init', '-b', 'main'] })).ok).toBe(true)
    expect((await run({ argv: ['config', 'user.name', 'Ref Truncation Test'] })).ok).toBe(true)
    expect((await run({ argv: ['config', 'user.email', 'ref-truncation@test.local'] })).ok).toBe(true)
    fs.writeFileSync(path.join(cwd, 'root.txt'), 'root\n')
    expect((await run({ argv: ['add', '--', 'root.txt'] })).ok).toBe(true)
    expect((await run({ argv: ['commit', '-m', 'root'] })).ok).toBe(true)
    const hash = (await run({ argv: ['rev-parse', 'HEAD'] })).stdout.trim()

    expect((await run({ argv: ['init', '--bare', bare] })).ok).toBe(true)
    expect((await run({ argv: ['remote', 'add', 'origin', bare] })).ok).toBe(true)
    expect((await run({ argv: ['push', '-u', 'origin', 'main'] })).ok).toBe(true)
    expect((await run({ argv: ['--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main'] })).ok).toBe(true)
    expect((await run({ argv: ['remote', 'set-head', 'origin', '-a'] })).ok).toBe(true)

    const branchInput = Array.from({ length: 900 }, (_, index) =>
      `create refs/heads/load-branch-${String(index).padStart(4, '0')} ${hash}`,
    ).join('\n') + '\n'
    expect((await run({ argv: ['update-ref', '--stdin'], input: branchInput })).ok).toBe(true)

    const refs = await repository.refs()
    expect(refs.ok).toBe(true)
    expect(refs.truncated).toBe(true)
    expect(refs.refs.some((ref) => ref.fullName === 'refs/remotes/origin/main')).toBe(false)
    const alias = refs.refs.find((ref) => ref.fullName === 'refs/remotes/origin/HEAD')
    expect(alias).toMatchObject({
      kind: 'alias',
      targetRef: 'refs/remotes/origin/main',
      targetShortName: 'origin/main',
      commit: hash,
      status: '',
    })
    // The alias target was resolved by a separate real Git read, not assumed
    // missing because it fell past the truncated ref list.
    expect(refs.records.some((record) =>
      record.intent === 'Resolve remote default branch target' && record.ok,
    )).toBe(true)
  }, 30_000)

  it('drops the incomplete trailing record and reports a partial ref list with 900 tags', async () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-ref-truncation-'))
    const commands = new GitCommandService()
    const run = (request) => commands.run({ intent: 'Fixture', source: 'background', cwd, ...request })
    const repository = new RepositoryService(commands, () => cwd)

    expect((await run({ argv: ['init', '-b', 'main'] })).ok).toBe(true)
    expect((await run({ argv: ['config', 'user.name', 'Ref Truncation Test'] })).ok).toBe(true)
    expect((await run({ argv: ['config', 'user.email', 'ref-truncation@test.local'] })).ok).toBe(true)
    fs.writeFileSync(path.join(cwd, 'root.txt'), 'root\n')
    expect((await run({ argv: ['add', '--', 'root.txt'] })).ok).toBe(true)
    expect((await run({ argv: ['commit', '-m', 'root'] })).ok).toBe(true)
    const hash = (await run({ argv: ['rev-parse', 'HEAD'] })).stdout.trim()

    // One real Git command creates 900 refs; the for-each-ref stdout then
    // exceeds the CommandRecord's 64 KiB budget.
    const input = Array.from({ length: 900 }, (_, index) =>
      `create refs/tags/load-${String(index).padStart(4, '0')} ${hash}`,
    ).join('\n') + '\n'
    const created = await run({ argv: ['update-ref', '--stdin'], input })
    expect(created.ok).toBe(true)

    const refs = await repository.refs()
    expect(refs.ok).toBe(true)
    expect(refs.truncated).toBe(true)
    expect(refs.records[0].outputTruncated).toBe(true)
    expect(refs.refs.length).toBeGreaterThan(100)
    expect(refs.refs.length).toBeLessThan(900)

    const tags = refs.refs.filter((ref) => ref.kind === 'tag')
    expect(tags.length).toBe(refs.refs.length - 1) // refs/heads/main + tags
    // Every returned tag is a complete record pointing at the real commit; the
    // cut-off trailing line never becomes a fabricated unresolved tag.
    expect(tags.every((tag) => tag.commit === hash && tag.status === '')).toBe(true)
    expect(tags.at(-1).fullName).toMatch(/^refs\/tags\/load-\d{4}$/)
  }, 30_000)
})
