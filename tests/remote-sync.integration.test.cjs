const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { GitCommandService } = require('../electron/git-command-service.cjs')
const { RepositoryService } = require('../electron/repository-service.cjs')

const temporaryRoots = []

function createRunner(commands, cwd) {
  return (argv, intent) => commands.run({ argv, intent, source: 'background', cwd })
}

async function configureAuthor(run) {
  expect((await run(['config', 'user.name', 'GitGlass Remote Test'], 'Configure test author')).ok).toBe(true)
  expect((await run(['config', 'user.email', 'remote-test@gitglass.local'], 'Configure test email')).ok).toBe(true)
}

async function createRemoteFixture(commands) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-remote-'))
  temporaryRoots.push(root)
  const origin = path.join(root, 'origin.git')
  const seed = path.join(root, 'seed')
  const work = path.join(root, 'work')
  const writer = path.join(root, 'writer')
  const rootRun = createRunner(commands, root)

  expect((await rootRun(['init', '--bare', origin], 'Initialize bare origin')).ok).toBe(true)
  fs.mkdirSync(seed)
  const seedRun = createRunner(commands, seed)
  expect((await seedRun(['init', '-b', 'main'], 'Initialize seed repository')).ok).toBe(true)
  await configureAuthor(seedRun)
  fs.writeFileSync(path.join(seed, 'note.txt'), 'base\n')
  expect((await seedRun(['add', '--', 'note.txt'], 'Stage seed file')).ok).toBe(true)
  expect((await seedRun(['commit', '-m', 'chore: seed remote fixture'], 'Create seed commit')).ok).toBe(true)
  expect((await seedRun(['remote', 'add', 'origin', origin], 'Configure seed origin')).ok).toBe(true)
  expect((await seedRun(['push', '-u', 'origin', 'main'], 'Publish seed branch')).ok).toBe(true)
  expect((await createRunner(commands, origin)(['symbolic-ref', 'HEAD', 'refs/heads/main'], 'Set origin default branch')).ok).toBe(true)
  expect((await rootRun(['clone', origin, work], 'Clone work repository')).ok).toBe(true)
  expect((await rootRun(['clone', origin, writer], 'Clone writer repository')).ok).toBe(true)
  await configureAuthor(createRunner(commands, work))
  await configureAuthor(createRunner(commands, writer))
  return { work, writer }
}

afterEach(() => {
  while (temporaryRoots.length) fs.rmSync(temporaryRoots.pop(), { recursive: true, force: true })
})

describe('real remote sync integration', () => {
  it('records fetch, ahead/behind, safe push, ff-only pull, dirty blocking, and non-fast-forward blocking', async () => {
    const commands = new GitCommandService()
    const { work, writer } = await createRemoteFixture(commands)
    const repository = new RepositoryService(commands, () => work)
    const writerRun = createRunner(commands, writer)

    const initial = await repository.remoteOverview()
    expect(initial).toMatchObject({ ok: true, upstream: { ref: 'origin/main', remote: 'origin', branch: 'main' }, ahead: 0, behind: 0 })

    const fetchPlan = await repository.prepareRemote('fetch')
    expect(fetchPlan.plan).toMatchObject({ phase: 'planned', argv: ['fetch', 'origin'], operationId: expect.any(String) })
    const fetch = await repository.executeRemote('fetch', fetchPlan.plan.operationId)
    expect(fetch.execution).toMatchObject({ ok: true, argv: ['git', 'fetch', 'origin'], operationId: fetchPlan.plan.operationId })

    fs.appendFileSync(path.join(work, 'note.txt'), 'ahead from work\n')
    expect((await repository.stage('note.txt')).ok).toBe(true)
    expect((await repository.commit('feat: work ahead')).ok).toBe(true)
    expect((await repository.remoteOverview()).ahead).toBe(1)
    const pushPlan = await repository.prepareRemote('push')
    expect(pushPlan.plan).toMatchObject({ argv: ['push', 'origin', 'main:main'], operationId: expect.any(String) })
    const push = await repository.executeRemote('push', pushPlan.plan.operationId)
    expect(push.execution).toMatchObject({ ok: true, argv: ['git', 'push', 'origin', 'main:main'], operationId: pushPlan.plan.operationId })

    expect((await writerRun(['pull', '--ff-only', 'origin', 'main'], 'Update writer clone')).ok).toBe(true)
    fs.appendFileSync(path.join(writer, 'note.txt'), 'behind from writer\n')
    expect((await writerRun(['add', '--', 'note.txt'], 'Stage writer update')).ok).toBe(true)
    expect((await writerRun(['commit', '-m', 'feat: writer ahead'], 'Commit writer update')).ok).toBe(true)
    expect((await writerRun(['push', 'origin', 'main'], 'Publish writer update')).ok).toBe(true)
    const fetchBehindPlan = await repository.prepareRemote('fetch')
    expect((await repository.executeRemote('fetch', fetchBehindPlan.plan.operationId)).execution.ok).toBe(true)
    expect((await repository.remoteOverview()).behind).toBe(1)
    const pullPlan = await repository.prepareRemote('pull')
    expect(pullPlan.plan).toMatchObject({ argv: ['pull', '--ff-only', 'origin', 'main'], operationId: expect.any(String) })
    const pull = await repository.executeRemote('pull', pullPlan.plan.operationId)
    expect(pull.execution).toMatchObject({ ok: true, argv: ['git', 'pull', '--ff-only', 'origin', 'main'], operationId: pullPlan.plan.operationId })

    fs.appendFileSync(path.join(writer, 'note.txt'), 'dirty remote change\n')
    expect((await writerRun(['add', '--', 'note.txt'], 'Stage dirty remote change')).ok).toBe(true)
    expect((await writerRun(['commit', '-m', 'feat: remote change for dirty block'], 'Commit dirty remote change')).ok).toBe(true)
    expect((await writerRun(['push', 'origin', 'main'], 'Publish dirty remote change')).ok).toBe(true)
    const dirtyFetchPlan = await repository.prepareRemote('fetch')
    expect((await repository.executeRemote('fetch', dirtyFetchPlan.plan.operationId)).execution.ok).toBe(true)
    const cleanContent = fs.readFileSync(path.join(work, 'note.txt'), 'utf8')
    fs.appendFileSync(path.join(work, 'note.txt'), 'uncommitted local change\n')
    const dirtyPull = await repository.prepareRemote('pull')
    expect(dirtyPull).toMatchObject({ ok: false, blocked: true, plan: null })
    expect(dirtyPull.reason).toContain('不会自动 stash')
    fs.writeFileSync(path.join(work, 'note.txt'), cleanContent)

    fs.appendFileSync(path.join(work, 'note.txt'), 'divergent local commit\n')
    expect((await repository.stage('note.txt')).ok).toBe(true)
    expect((await repository.commit('feat: divergent local')).ok).toBe(true)
    fs.appendFileSync(path.join(writer, 'note.txt'), 'divergent remote commit\n')
    expect((await writerRun(['add', '--', 'note.txt'], 'Stage divergent remote change')).ok).toBe(true)
    expect((await writerRun(['commit', '-m', 'feat: divergent remote'], 'Commit divergent remote change')).ok).toBe(true)
    expect((await writerRun(['push', 'origin', 'main'], 'Publish divergent remote change')).ok).toBe(true)
    const divergenceFetchPlan = await repository.prepareRemote('fetch')
    expect((await repository.executeRemote('fetch', divergenceFetchPlan.plan.operationId)).execution.ok).toBe(true)
    const nonFastForward = await repository.prepareRemote('pull')
    expect(nonFastForward).toMatchObject({ ok: false, blocked: true, plan: null })
    expect(nonFastForward.reason).toContain('fast-forward')
    expect(nonFastForward.fastForward).toMatchObject({ ok: false, exitCode: 1, argv: ['git', 'merge-base', '--is-ancestor', 'HEAD', '@{upstream}'] })

    const ledger = commands.history()
    expect(ledger.some((record) => record.argv.join(' ') === 'git remote')).toBe(true)
    expect(ledger.some((record) => record.argv.join(' ') === 'git remote get-url origin')).toBe(true)
    expect(ledger.some((record) => record.argv.join(' ') === 'git rev-list --left-right --count @{upstream}...HEAD')).toBe(true)
    expect(ledger.some((record) => record.operationId === fetchPlan.plan.operationId && record.argv.join(' ') === 'git fetch origin')).toBe(true)
    expect(ledger.some((record) => record.operationId === pushPlan.plan.operationId && record.argv.join(' ') === 'git push origin main:main')).toBe(true)
    expect(ledger.some((record) => record.operationId === pullPlan.plan.operationId && record.argv.join(' ') === 'git pull --ff-only origin main')).toBe(true)
  }, 20_000)
})
