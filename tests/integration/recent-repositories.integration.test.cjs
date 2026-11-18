const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { GitCommandService } = require('../../electron/git-command-service.cjs')
const { RepositoryService } = require('../../electron/repository-service.cjs')
const { RecentRepositories } = require('../../electron/recent-repositories.cjs')
const { openRepositoryPath } = require('../../electron/repository-opener.cjs')

let workspace
afterEach(() => { if (workspace) fs.rmSync(workspace, { recursive: true, force: true }); workspace = null })

function harness() {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-open-repo-'))
  const commands = new GitCommandService()
  const recent = new RecentRepositories(path.join(workspace, 'recent-repos.json'))
  let current = null
  const repository = new RepositoryService(commands, () => current)
  const openRepository = (candidate) => openRepositoryPath({
    candidate,
    commandService: commands,
    repository,
    remember: (root) => recent.remember(root),
    setRepositoryPath: (root) => { current = root },
  })
  return { commands, openRepository, recent, current: () => current }
}

async function initializeRepository(commands, name) {
  const directory = path.join(workspace, name)
  fs.mkdirSync(directory, { recursive: true })
  const record = await commands.run({ argv: ['init', '-b', 'main'], intent: 'Fixture', source: 'background', cwd: directory })
  expect(record.ok).toBe(true)
  return directory
}

// Git reports the canonical worktree root, while os.tmpdir() can be the 8.3 short
// form on CI (C:\Users\RUNNER~1\... vs C:\Users\runneradmin\...). Compare canonical paths.
function canonical(target) {
  try {
    return fs.realpathSync.native(target)
  } catch {
    return path.resolve(target)
  }
}

describe('opening a repository path (real Git)', () => {
  it('resolves real worktree roots and remembers them newest first', async () => {
    const { commands, openRepository, recent, current } = harness()
    const first = await initializeRepository(commands, 'first')
    const second = await initializeRepository(commands, 'second')

    const opened = await openRepository(first)
    expect(opened).toMatchObject({ ok: true, path: canonical(first) })
    expect(opened.state).toMatchObject({ ok: true, path: canonical(first), branch: 'main' })
    expect(current()).toBe(canonical(first))
    expect(recent.list()).toEqual([canonical(first)])

    const secondOpened = await openRepository(second)
    expect(secondOpened).toMatchObject({ ok: true, path: canonical(second) })
    expect(recent.list()).toEqual([canonical(second), canonical(first)])

    // Re-opening an existing entry moves it to the front without duplicating it.
    await openRepository(first)
    expect(recent.list()).toEqual([canonical(first), canonical(second)])

    // The root came from Git, not from the renderer-supplied string.
    const resolver = commands.history().find((entry) => entry.intent === 'Resolve repository root')
    expect(resolver).toMatchObject({ ok: true, source: 'background' })
  })

  it('resolves a subfolder to the worktree root instead of trusting the given path', async () => {
    const { commands, openRepository } = harness()
    const repositoryRoot = await initializeRepository(commands, 'nested')
    const subfolder = path.join(repositoryRoot, 'src')
    fs.mkdirSync(subfolder)

    const opened = await openRepository(subfolder)
    expect(opened).toMatchObject({ ok: true, path: canonical(repositoryRoot) })
  })

  it('rejects a plain folder with a Chinese explanation and keeps the list unchanged', async () => {
    const { openRepository, recent, current } = harness()
    const plain = path.join(workspace, 'plain')
    fs.mkdirSync(plain)

    const failed = await openRepository(plain)
    expect(failed).toMatchObject({
      ok: false,
      message: '此文件夹不是 Git 仓库。请选择包含 .git 目录的项目文件夹。',
    })
    expect(failed.execution.ok).toBe(false)
    expect(recent.list()).toEqual([])
    expect(current()).toBe(null)
  })

  it('never remembers missing or invalid candidates', async () => {
    const { openRepository, recent } = harness()

    expect(await openRepository(path.join(workspace, 'not-created'))).toMatchObject({ ok: false, missing: true })
    expect(await openRepository('')).toMatchObject({ ok: false })
    expect(await openRepository('   ')).toMatchObject({ ok: false })
    expect(await openRepository(42)).toMatchObject({ ok: false })
    expect(await openRepository('C:/bad\0path')).toMatchObject({ ok: false })
    expect(await openRepository(`C:/${'x'.repeat(5000)}`)).toMatchObject({ ok: false })

    expect(recent.list()).toEqual([])
  })
})
