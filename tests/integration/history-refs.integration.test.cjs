const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { GitCommandService } = require('../../electron/git-command-service.cjs')
const { RepositoryService } = require('../../electron/repository-service.cjs')

let root

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = null
})

function makeService(commands, cwd) {
  return {
    run: (argv) => commands.run({ argv, intent: 'Fixture', source: 'background', cwd }),
    repository: new RepositoryService(commands, () => cwd),
  }
}

async function commitFile(run, cwd, name, content, message) {
  fs.writeFileSync(path.join(cwd, name), content)
  expect((await run(['add', '--', name])).ok).toBe(true)
  const result = await run(['commit', '-m', message])
  if (!result.ok) throw new Error(`commit failed: ${result.stderr}`)
  return result
}

async function buildFixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-refs-'))
  const cwd = path.join(root, 'work')
  const bare = path.join(root, 'origin.git')
  fs.mkdirSync(cwd)
  const commands = new GitCommandService()
  const { run, repository } = makeService(commands, cwd)
  for (const argv of [
    ['init', '-b', 'main', cwd],
    ['init', '--bare', bare],
    ['config', 'user.name', 'Refs Test'],
    ['config', 'user.email', 'refs@test.local'],
  ]) expect((await run(argv)).ok).toBe(true)

  await commitFile(run, cwd, 'initial.txt', 'root\n', 'feat: initial commit')
  const initialHash = (await run(['rev-parse', 'HEAD'])).stdout.trim()

  // 82 empty filler commits put the initial commit outside the default 80-row
  // page. Empty commits keep this fixture fast: no worktree writes and one Git
  // spawn per commit instead of add + commit.
  for (let index = 0; index < 82; index += 1) {
    const filler = await run(['commit', '--allow-empty', '-m', `chore: filler ${index}`])
    expect(filler.ok).toBe(true)
  }

  expect((await run(['switch', '-c', 'feature'])).ok).toBe(true)
  await commitFile(run, cwd, 'feature.txt', 'feature\n', 'feat: feature work')
  const featureHash = (await run(['rev-parse', 'HEAD'])).stdout.trim()

  expect((await run(['switch', 'main'])).ok).toBe(true)
  await commitFile(run, cwd, 'main.txt', 'main\n', 'feat: main work')
  expect((await run(['merge', '--no-ff', 'feature', '-m', 'merge: feature into main'])).ok).toBe(true)
  const mergeHash = (await run(['rev-parse', 'HEAD'])).stdout.trim()

  expect((await run(['branch', 'release', featureHash])).ok).toBe(true)
  expect((await run(['tag', 'release', featureHash])).ok).toBe(true) // lightweight, same short name as the branch
  expect((await run(['tag', '-a', 'v1.0.0', '-m', 'release 1.0.0', mergeHash])).ok).toBe(true) // annotated
  expect((await run(['tag', '-a', 'v0.1.0', '-m', 'root release', initialHash])).ok).toBe(true) // outside the page

  expect((await run(['remote', 'add', 'origin', bare])).ok).toBe(true)
  expect((await run(['push', '-u', 'origin', 'main'])).ok).toBe(true)
  // The branch and the tag share the short name `release`, so name both sides
  // explicitly; a bare `release` refspec is ambiguous to Git.
  expect((await run(['push', 'origin', 'refs/heads/feature:refs/heads/feature', 'refs/heads/release:refs/heads/release'])).ok).toBe(true)
  // A bare repository still has its default HEAD; point it at main before
  // asking Git to create the refs/remotes/origin/HEAD symbolic alias.
  expect((await run(['--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main'])).ok).toBe(true)
  expect((await run(['remote', 'set-head', 'origin', '-a'])).ok).toBe(true)

  return { cwd, bare, commands, repository, initialHash, featureHash, mergeHash }
}

async function snapshot(run, cwd) {
  return {
    head: (await run(['rev-parse', 'HEAD'])).stdout.trim(),
    refs: (await run(['for-each-ref', '--format=%(refname) %(objectname)'])).stdout,
    status: (await run(['status', '--porcelain=v1'])).stdout,
    diff: (await run(['diff'])).stdout,
    cached: (await run(['diff', '--cached'])).stdout,
    workingFiles: ['initial.txt', 'feature.txt', 'main.txt']
      .map((name) => `${name}:${fs.readFileSync(path.join(cwd, name), 'utf8')}`),
  }
}

describe('real Git refs and out-of-page commits', () => {
  it('reads full refs, peels tags, follows origin/HEAD and keeps the repository read-only', async () => {
    const { cwd, commands, repository, initialHash, featureHash, mergeHash } = await buildFixture()
    const { run } = makeService(commands, cwd)
    const before = await snapshot(run, cwd)

    const refs = await repository.refs()
    expect(refs.ok).toBe(true)
    expect(refs.head).toMatchObject({
      fullName: 'refs/heads/main',
      shortName: 'main',
      commit: mergeHash,
      detached: false,
      unborn: false,
    })

    const byFullName = new Map(refs.refs.map((ref) => [ref.fullName, ref]))
    expect(byFullName.get('refs/heads/main')).toMatchObject({ kind: 'local', commit: mergeHash, head: true })
    expect(byFullName.get('refs/heads/feature')).toMatchObject({ kind: 'local', commit: featureHash })
    expect(byFullName.get('refs/remotes/origin/main')).toMatchObject({ kind: 'remote', commit: mergeHash })
    expect(byFullName.get('refs/remotes/origin/HEAD')).toMatchObject({
      kind: 'alias',
      targetRef: 'refs/remotes/origin/main',
      targetShortName: 'origin/main',
      commit: mergeHash,
    })
    expect(byFullName.get('refs/tags/release')).toMatchObject({
      kind: 'tag',
      shortName: 'release',
      annotated: false,
      commit: featureHash,
    })
    expect(byFullName.get('refs/heads/release')).toMatchObject({
      kind: 'local',
      shortName: 'release',
      commit: featureHash,
    })
    // Same short name, different full ref name and kind: both survive.
    expect(byFullName.get('refs/heads/release').fullName).not.toBe(byFullName.get('refs/tags/release').fullName)
    expect(byFullName.get('refs/tags/v1.0.0')).toMatchObject({ annotated: true, commit: mergeHash })
    expect(byFullName.get('refs/tags/v0.1.0')).toMatchObject({ annotated: true, commit: initialHash })

    const history = await repository.commits()
    expect(history.limit).toBe(80)
    expect(history.commits).toHaveLength(80)
    expect(history.commits.some((commit) => commit.hash === initialHash)).toBe(false)
    const merge = history.commits.find((commit) => commit.hash === mergeHash)
    expect(merge.parents).toHaveLength(2)
    expect(merge.parents).toContain(featureHash)
    expect(new Set(merge.parents).size).toBe(2)

    const outside = await repository.commitBySha(initialHash)
    expect(outside.ok).toBe(true)
    expect(outside.commit).toMatchObject({ hash: initialHash, parents: [], subject: 'feat: initial commit' })

    const after = await snapshot(run, cwd)
    expect(after).toEqual(before)
    // Every new read is a background CommandRecord.
    const reads = commands.history().filter((record) => ['Read Git refs', 'Read HEAD reference', 'Read HEAD commit', 'Read commit by ID'].includes(record.intent))
    expect(reads.length).toBeGreaterThanOrEqual(4)
    expect(reads.every((record) => record.source === 'background')).toBe(true)
  }, 60_000)

  it('reports an empty repository as unborn instead of inventing a branch commit', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-refs-empty-'))
    const commands = new GitCommandService()
    const repository = new RepositoryService(commands, () => root)
    expect((await commands.run({ argv: ['init', '-b', 'main'], intent: 'Fixture', source: 'background', cwd: root })).ok).toBe(true)

    const refs = await repository.refs()
    expect(refs.ok).toBe(true)
    expect(refs.refs).toEqual([])
    expect(refs.head).toMatchObject({ fullName: 'refs/heads/main', shortName: 'main', commit: '', unborn: true })
    expect(refs.head.status).toContain('还没有提交')
  }, 20_000)
})
