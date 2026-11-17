const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { GitCommandService } = require('../../electron/git-command-service.cjs')
const { RepositoryService } = require('../../electron/repository-service.cjs')

let cwd
afterEach(() => { if (cwd) fs.rmSync(cwd, { recursive: true, force: true }); cwd = null })

async function initializeRepository() {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-empty-repo-'))
  const commands = new GitCommandService()
  const run = (argv) => commands.run({ argv, intent: 'Fixture', source: 'background', cwd })
  for (const argv of [['init', '-b', 'main'], ['config', 'user.name', 'Empty Test'], ['config', 'user.email', 'empty@test.local']]) {
    expect((await run(argv)).ok).toBe(true)
  }
  return { commands, repository: new RepositoryService(commands, () => cwd) }
}

describe('repository without any commit (real Git)', () => {
  it('unstages a staged file by resetting the index instead of restoring from HEAD', async () => {
    const { repository } = await initializeRepository()
    fs.writeFileSync(path.join(cwd, 'first.txt'), 'first\n')

    const staged = await repository.stage('first.txt')
    expect(staged).toMatchObject({ ok: true, argv: ['git', 'add', '--', 'first.txt'] })

    const unstaged = await repository.unstage('first.txt')
    // `git restore --staged` needs HEAD, which does not exist yet.
    expect(unstaged).toMatchObject({ ok: true, argv: ['git', 'reset', '--', 'first.txt'] })

    const state = await repository.state()
    expect(state.ok).toBe(true)
    expect(state.files).toContainEqual(expect.objectContaining({ path: 'first.txt', area: 'unstaged' }))
  })

  it('still restores from HEAD once the repository has a commit', async () => {
    const { commands, repository } = await initializeRepository()
    fs.writeFileSync(path.join(cwd, 'first.txt'), 'first\n')
    await repository.stage('first.txt')
    const committed = await repository.commit('chore: seed')
    expect(committed.ok).toBe(true)

    fs.writeFileSync(path.join(cwd, 'second.txt'), 'second\n')
    await repository.stage('second.txt')
    const unstaged = await repository.unstage('second.txt')
    expect(unstaged).toMatchObject({ ok: true, argv: ['git', 'restore', '--staged', '--', 'second.txt'] })

    // The HEAD probe is a background record; the unstage itself is a user action.
    const probe = commands.history().find((entry) => entry.intent === 'Check HEAD for unstage')
    expect(probe).toMatchObject({ ok: true, source: 'background' })
  })

  it('reports the unborn branch without inventing a commit history', async () => {
    const { repository } = await initializeRepository()
    const state = await repository.state()
    expect(state).toMatchObject({ ok: true, branch: 'main', files: [] })
    const history = await repository.commits()
    expect(history.record.ok).toBe(false)
    expect(history.commits).toEqual([])
    expect(history.reason).toBe('此仓库还没有提交记录。')
  })
})
