const { RepositoryService, redactRemoteUrl } = require('../../electron/repository-service.cjs')

function commandsFor(records) {
  return { run: async (request) => ({ ...request, id: 'record', operationId: request.operationId || 'operation', argv: ['git', ...request.argv], displayCommand: `git ${request.argv.join(' ')}`, stdout: records.shift() ?? '', stderr: '', exitCode: 0, ok: true }), plan: (request) => ({ phase: 'planned', ...request, operationId: request.operationId || 'planned-operation', argv: [...request.argv], displayCommand: `git ${request.argv.join(' ')}` }) }
}
describe('Branch workspace safety', () => {
  it('blocks a switch on a dirty worktree without constructing a switch plan', async () => {
    const repo = new RepositoryService(commandsFor(['', 'main\n', ' M changed.js\0']), () => 'D:/repo')
    const result = await repo.prepareSwitch('feature/report')
    expect(result).toMatchObject({ ok: false, blocked: true })
    expect(result.reason).toContain('不会自动 stash')
  })
  it('plans, then executes, a clean branch switch using argv', async () => {
    const repo = new RepositoryService(commandsFor(['', 'main\n', '', '', 'main\n', '', '', 'main\n', '']), () => 'D:/repo')
    const plan = await repo.prepareSwitch('feature/report')
    expect(plan.plan).toMatchObject({ phase: 'planned', operationId: 'planned-operation', argv: ['switch', 'feature/report'], displayCommand: 'git switch feature/report' })
    const result = await repo.executeSwitch('feature/report', false, plan.plan.operationId)
    expect(result.execution).toMatchObject({ argv: ['git', 'switch', 'feature/report'], operationId: plan.plan.operationId })
  })
  it('uses Git ref validation failures to reject unsafe branch names', async () => {
    const commands = { run: async (request) => ({ ...request, ok: false, stderr: 'fatal: invalid branch name', stdout: '', exitCode: 1 }), plan: () => { throw new Error('invalid refs must not be planned') } }
    const repo = new RepositoryService(commands, () => 'D:/repo')
    for (const name of ['@{}', 'feature/.hidden', 'main.lock']) {
      const result = await repo.prepareSwitch(name)
      expect(result).toMatchObject({ ok: false, blocked: true, plan: null })
      expect(result.validation.argv).toEqual(['check-ref-format', '--branch', name])
    }
  })
})

describe('Diff read contract for hunk operations', () => {
  const twoHunks = [
    'diff --git a/src/app.js b/src/app.js',
    'index 1111111..2222222 100644',
    '--- a/src/app.js',
    '+++ b/src/app.js',
    '@@ -1,6 +1,6 @@',
    ' line 1',
    '-line 2',
    '+line 2 edited',
    ' line 3',
    '@@ -28,7 +28,7 @@',
    ' line 28',
    '-line 29',
    '+line 29 edited',
    ' line 30',
    '',
  ].join('\n')

  function stubCommands({ stdout = twoHunks, outputTruncated = false, ok = true } = {}) {
    const requests = []
    return {
      requests,
      run: async (request) => {
        requests.push(request)
        return { ...request, id: 'record', operationId: 'operation', argv: ['git', ...request.argv], displayCommand: `git ${request.argv.join(' ')}`, stdout, stderr: '', exitCode: ok ? 0 : 1, ok, outputTruncated }
      },
      recordRejection: (request) => ({ ...request, rejected: true, ok: false, exitCode: null, argv: ['git', ...request.argv] }),
    }
  }

  it('reads the staged area with the pinned patch parameters and hands back locators', async () => {
    const commands = stubCommands()
    const repo = new RepositoryService(commands, () => 'D:/repo')
    const result = await repo.diff({ path: 'src/app.js', area: 'staged' })
    expect(commands.requests[0].argv).toEqual(['diff', '--cached', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '-U3', '--inter-hunk-context=0', '--', 'src/app.js'])
    // 展示读取的预算仍放宽到 1 MiB，并保留原有的记录字段。
    expect(commands.requests[0].maxOutputBytes).toBe(1024 * 1024)
    expect(result).toMatchObject({ ok: true, area: 'staged', path: 'src/app.js' })
    expect(result.snapshot).toMatch(/^[0-9a-f]{64}$/)
    expect(result.hunkSupport.hunks.map((hunk) => hunk.header)).toEqual(['@@ -1,6 +1,6 @@', '@@ -28,7 +28,7 @@'])
    expect(result.stdout).toBe(twoHunks)
  })

  it('reports truncation instead of publishing hunk locators', async () => {
    const repo = new RepositoryService(stubCommands({ outputTruncated: true }), () => 'D:/repo')
    const result = await repo.diff({ path: 'src/app.js', area: 'unstaged' })
    expect(result.hunkSupport).toMatchObject({ ok: false, hunks: [] })
    expect(result.hunkSupport.reason).toContain('截断')
  })

  it('does not run Git for an invalid file path', async () => {
    const commands = stubCommands()
    const repo = new RepositoryService(commands, () => 'D:/repo')
    const result = await repo.diff({ path: 'bad\u0000path', area: 'unstaged' })
    expect(result.ok).toBe(false)
    expect(commands.requests).toHaveLength(0)
  })
})

describe('Remote URL safety', () => {
  it('removes credentials, query parameters, and fragments before a remote URL reaches the ledger', () => {
    const value = redactRemoteUrl('https://token:secret@example.test/team/repo.git?access_token=abc#private\n')
    expect(value).toBe('https://example.test/team/repo.git\n')
    expect(redactRemoteUrl('git@example.test:team/repo.git?token=secret')).toBe('git@example.test:team/repo.git')
  })
})
