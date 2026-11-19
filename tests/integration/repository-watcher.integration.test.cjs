const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { RepositoryWatcher } = require('../../electron/repository-watcher.cjs')
const { GitCommandService } = require('../../electron/git-command-service.cjs')
const { resolveGitDirectory } = require('../../electron/repository-service.cjs')

let cwd
let extraDirectory

// Windows keeps a directory busy until every fs.watch handle on it is released,
// and a watcher that is still attached (for example after a failed assertion)
// makes the cleanup itself fail. Retry instead of masking the real failure with
// an EBUSY from rmdir.
function removeDirectory(directory) {
  if (!directory) return
  try {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    // Best effort: a leftover temp directory must never fail an otherwise green run.
  }
}

afterEach(() => {
  removeDirectory(cwd)
  removeDirectory(extraDirectory)
  cwd = null
  extraDirectory = null
})

// Integration tests spawn real Git processes, and the coverage run instruments
// every module they load. The 5 s default is not enough on a cold CI runner: one
// timed-out test used to skip its cleanup and leave a watched directory behind.
const TEST_TIMEOUT_MS = 30_000

// Pending filesystem events are collected by polling; a fixed sleep would be
// flaky on a cold CI runner.
async function waitFor(predicate, label, timeout = 10_000) {
  const deadline = Date.now() + timeout
  let last
  for (;;) {
    last = predicate()
    if (last) return last
    if (Date.now() >= deadline) throw new Error(`等待超时：${label}；最后观测值=${JSON.stringify(last)}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

// Poll until the watcher has been silent for `quietMs`; used instead of a fixed
// sleep to assert how many notifications a burst produced.
async function waitForQuiet(events, quietMs = 1000, timeout = 10_000) {
  const deadline = Date.now() + timeout
  let lastCount = events.length
  let lastChange = Date.now()
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    if (events.length !== lastCount) {
      lastCount = events.length
      lastChange = Date.now()
    } else if (Date.now() - lastChange >= quietMs) {
      return
    }
  }
}

// 200 refs are written through one `git update-ref --stdin` process so the test
// stays fast; Git still produces ~1200 filesystem events for them.
function updateRefs(directory, lines) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['update-ref', '--stdin'], { cwd: directory, stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`update-ref --stdin exited ${code}`))))
    child.stdin.end(lines.join('\n') + '\n')
  })
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
  return { run, gitDirectory: resolveGitDirectory(cwd), sha: (await run(['rev-parse', 'HEAD'])).stdout.trim() }
}

function startWatcher(gitDirectory) {
  const events = []
  const watcher = new RepositoryWatcher()
  expect(watcher.watch(gitDirectory, ({ reason }) => events.push({ reason, at: Date.now() }))).toBe(true)
  return { watcher, events }
}

describe('repository watcher against real Git (integration)', () => {
  it('reports a commit executed by another Git process', async () => {
    const { run, gitDirectory } = await repositoryFixture()
    const { watcher, events } = startWatcher(gitDirectory)
    try {
      const startedAt = Date.now()
      fs.writeFileSync(path.join(cwd, 'seed.txt'), 'changed from the terminal\n')
      await run(['add', '--', 'seed.txt'])
      await run(['commit', '-m', 'chore: external commit'])
      await waitFor(() => events.length > 0, '提交触发一次 repo:changed')
      // Leading edge: the first report must not wait for the burst to finish.
      expect(events[0].at - startedAt).toBeLessThan(1500)
      expect(events.every(({ reason }) => ['head', 'index', 'refs'].includes(reason))).toBe(true)
      // The trailing report merges index+refs+head into the strongest reason.
      await waitFor(() => events.some(({ reason }) => reason === 'head'), '合并后上报 head')
    } finally {
      watcher.close()
    }
  }, TEST_TIMEOUT_MS)

  it('reports a branch switch and releases the watch on close()', async () => {
    const { run, gitDirectory } = await repositoryFixture()
    const { watcher, events } = startWatcher(gitDirectory)
    try {
      await run(['checkout', '-b', 'feature/watched'])
      await waitFor(() => events.length > 0, '切换分支触发一次 repo:changed')
    } finally {
      // Always release the handle: without this, a failed assertion above leaves
      // .git watched and the cleanup cannot delete the directory on Windows.
      watcher.close()
    }
    expect(() => watcher.close()).not.toThrow()
    // The temporary repository (including .git) must be removable afterwards,
    // which fails on Windows while a watcher still holds a handle on it.
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    expect(fs.existsSync(cwd)).toBe(false)
    cwd = null
  }, TEST_TIMEOUT_MS)

  it('coalesces a burst of 200 new refs into at most three notifications', async () => {
    const { gitDirectory, sha } = await repositoryFixture()
    const { watcher, events } = startWatcher(gitDirectory)
    try {
      const lines = []
      for (let index = 0; index < 200; index++) lines.push(`create refs/heads/bulk-${index} ${sha}`)
      const startedAt = Date.now()
      await updateRefs(cwd, lines)
      await waitFor(() => events.length > 0, '200 个分支触发一次 repo:changed')
      expect(events[0].at - startedAt).toBeLessThan(1500)
      // Wait for the burst to go quiet, then assert the notification count is
      // bounded: ~1200 raw filesystem events must not become 200 refreshes.
      await waitForQuiet(events)
      expect(events.length).toBeLessThanOrEqual(3)
      expect(events.every(({ reason }) => reason === 'refs')).toBe(true)
    } finally {
      watcher.close()
    }
  }, TEST_TIMEOUT_MS)

  it('reports a fetch that updates 200 remote-tracking refs', async () => {
    const { run, gitDirectory, sha } = await repositoryFixture()
    extraDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-watch-remote-'))
    const remote = path.join(extraDirectory, 'remote.git')
    const commands = new GitCommandService()
    const runAt = async (directory, argv) => {
      const record = await commands.run({ argv, intent: 'Fixture', source: 'background', cwd: directory })
      expect(record.ok, `${argv.join(' ')}: ${record.stderr}`).toBe(true)
      return record
    }
    await runAt(extraDirectory, ['init', '--bare', remote])
    await run(['remote', 'add', 'origin', remote])
    await run(['push', 'origin', 'main'])
    const remoteLines = []
    for (let index = 0; index < 200; index++) remoteLines.push(`create refs/heads/remote-${index} ${sha}`)
    await updateRefs(remote, remoteLines)

    const { watcher, events } = startWatcher(gitDirectory)
    try {
      const startedAt = Date.now()
      await run(['fetch', 'origin'])
      await waitFor(() => events.length > 0, 'fetch 触发一次 repo:changed')
      expect(events[0].at - startedAt).toBeLessThan(1500)
      await waitForQuiet(events)
      expect(events.length).toBeLessThanOrEqual(3)
    } finally {
      watcher.close()
    }
  }, TEST_TIMEOUT_MS)
})
