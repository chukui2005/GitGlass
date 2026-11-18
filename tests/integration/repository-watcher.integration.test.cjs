const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { RepositoryWatcher } = require('../../electron/repository-watcher.cjs')
const { GitCommandService } = require('../../electron/git-command-service.cjs')
const { resolveGitDirectory } = require('../../electron/repository-service.cjs')

let cwd
afterEach(() => {
  if (cwd) fs.rmSync(cwd, { recursive: true, force: true })
  cwd = null
})

// Pending filesystem events are collected by polling; a fixed sleep would be
// flaky on a cold CI runner.
async function waitFor(predicate, label, timeout = 5000) {
  const deadline = Date.now() + timeout
  let last
  for (;;) {
    last = predicate()
    if (last) return last
    if (Date.now() >= deadline) throw new Error(`等待超时：${label}；最后观测值=${JSON.stringify(last)}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function repositoryFixture() {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-watch-'))
  const commands = new GitCommandService()
  const run = async (argv) => {
    const record = await commands.run({ argv, intent: 'Fixture', source: 'background', cwd })
    expect(record.ok, `${argv.join(' ')}: ${record.stderr}`).toBe(true)
    return record
  }
  for (const argv of [['init', '-b', 'main'], ['config', 'user.name', 'Watcher Test'], ['config', 'user.email', 'watcher@test.local']]) await run(argv)
  fs.writeFileSync(path.join(cwd, 'seed.txt'), 'seed\n')
  await run(['add', '--', 'seed.txt'])
  await run(['commit', '-m', 'chore: seed'])
  return { run, gitDirectory: resolveGitDirectory(cwd) }
}

describe('repository watcher against real Git (integration)', () => {
  it('reports a commit executed by another Git process', async () => {
    const { run, gitDirectory } = await repositoryFixture()
    expect(gitDirectory).toBeTruthy()
    const reasons = []
    const watcher = new RepositoryWatcher()
    expect(watcher.watch(gitDirectory, ({ reason }) => reasons.push(reason))).toBe(true)
    try {
      fs.writeFileSync(path.join(cwd, 'seed.txt'), 'changed from the terminal\n')
      await run(['add', '--', 'seed.txt'])
      await run(['commit', '-m', 'chore: external commit'])
      await waitFor(() => reasons.length > 0, '提交触发一次 repo:changed')
      expect(reasons.every((reason) => ['head', 'index', 'refs'].includes(reason))).toBe(true)
    } finally {
      watcher.close()
    }
  })

  it('reports a branch switch and releases the watch on close()', async () => {
    const { run, gitDirectory } = await repositoryFixture()
    const reasons = []
    const watcher = new RepositoryWatcher()
    watcher.watch(gitDirectory, ({ reason }) => reasons.push(reason))
    await run(['checkout', '-b', 'feature/watched'])
    await waitFor(() => reasons.length > 0, '切换分支触发一次 repo:changed')
    watcher.close()
    expect(() => watcher.close()).not.toThrow()
    // The temporary repository (including .git) must be removable afterwards,
    // which fails on Windows while a watcher still holds a handle on it.
    fs.rmSync(cwd, { recursive: true, force: true })
    expect(fs.existsSync(cwd)).toBe(false)
    cwd = null
  })
})
