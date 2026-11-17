const { EventEmitter } = require('node:events')
const { GitCommandService, redactCredentials, DEFAULT_MAX_OUTPUT_BYTES } = require('../../electron/git-command-service.cjs')

function fakeChild({ stdout = '', stderr = '', code = 0, close = true } = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.kill = () => {
    child.killed = true
    queueMicrotask(() => child.emit('close', null))
  }
  if (close) {
    queueMicrotask(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout))
      if (stderr) child.stderr.emit('data', Buffer.from(stderr))
      child.emit('close', code)
    })
  }
  return child
}

function serviceWith(spawnImpl, options = {}) {
  return new GitCommandService({ spawnImpl, existsSync: () => true, ...options })
}

describe('GitCommandService', () => {
  it('records argv, output, result, source and safe spawn options', async () => {
    let received
    const spawnImpl = (binary, argv, options) => {
      received = { binary, argv, options }
      return fakeChild({ stdout: 'main\n', stderr: 'warning\n' })
    }
    const service = serviceWith(spawnImpl, { idFactory: () => 'id-1', now: () => '2026-01-01T00:00:00.000Z' })
    const record = await service.run({ argv: ['status', '--porcelain=v1'], intent: 'Read working tree status', source: 'background', cwd: 'D:/repo' })

    expect(received.binary).toBe('git')
    expect(received.argv).toEqual(['status', '--porcelain=v1'])
    expect(received.options).toMatchObject({ cwd: 'D:/repo', shell: false, windowsHide: true })
    // Credential prompts are disabled so a missing credential fails instead of hanging.
    expect(received.options.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' })
    expect(record).toMatchObject({
      id: 'id-1', operationId: 'id-1', source: 'background', argv: ['git', 'status', '--porcelain=v1'],
      displayCommand: 'git status --porcelain=v1', stdout: 'main\n', stderr: 'warning\n', exitCode: 0, ok: true,
      outputTruncated: false, timedOut: false,
    })
    expect(service.history()).toEqual([record])
  })

  it('keeps a failure with stderr and a nonzero exit code', async () => {
    const service = serviceWith(() => fakeChild({ stderr: 'fatal: failed', code: 128 }))
    const record = await service.run({ argv: ['commit', '-m', 'test'], intent: 'Create commit', source: 'user', cwd: 'D:/repo' })
    expect(record).toMatchObject({ ok: false, exitCode: 128, stderr: 'fatal: failed', source: 'user' })
  })

  it('terminates a command that exceeds its timeout and marks the record', async () => {
    let child
    const service = serviceWith(() => { child = fakeChild({ close: false }); return child }, { defaultTimeoutMs: 5 })
    const record = await service.run({ argv: ['push', 'origin', 'main'], intent: 'Push branch safely', source: 'user', cwd: 'D:/repo' })

    expect(child.killed).toBe(true)
    expect(record).toMatchObject({ ok: false, exitCode: -1, timedOut: true })
    expect(record.stderr).toContain('命令执行超时')
  })

  it('redacts credential-bearing URLs and tokens from captured output', async () => {
    const service = serviceWith(() => fakeChild({
      stdout: 'https://remote.example/x?token=abc123\n',
      stderr: "fatal: unable to access 'https://user:s3cret@github.com/chukui2005/GitGlass.git/': 403\n",
      code: 128,
    }))
    const record = await service.run({ argv: ['push', 'origin', 'main'], intent: 'Push branch safely', source: 'user', cwd: 'D:/repo' })

    expect(record.stderr).not.toContain('s3cret')
    expect(record.stderr).toContain("'https://github.com/chukui2005/GitGlass.git/'")
    expect(record.stdout).not.toContain('abc123')
    expect(record.stdout).toContain('token=<redacted>')
  })

  it('caps retained output and flags truncation', async () => {
    const big = 'x'.repeat(DEFAULT_MAX_OUTPUT_BYTES + 1024)
    const service = serviceWith(() => fakeChild({ stdout: big }))
    const record = await service.run({ argv: ['log'], intent: 'Read recent commits', source: 'background', cwd: 'D:/repo' })

    expect(record.outputTruncated).toBe(true)
    expect(Buffer.byteLength(record.stdout)).toBe(DEFAULT_MAX_OUTPUT_BYTES)
    expect(record.ok).toBe(true)
  })

  it('honours an explicit larger budget for diff-style reads', async () => {
    const big = 'y'.repeat(DEFAULT_MAX_OUTPUT_BYTES + 1024)
    const service = serviceWith(() => fakeChild({ stdout: big }))
    const record = await service.run({ argv: ['diff'], intent: 'Read file diff', source: 'background', cwd: 'D:/repo', maxOutputBytes: 1024 * 1024 })
    expect(record.outputTruncated).toBe(false)
    expect(Buffer.byteLength(record.stdout)).toBe(big.length)
  })

  it('never executes anything without a repository', async () => {
    let spawned = false
    const service = new GitCommandService({ spawnImpl: () => { spawned = true }, existsSync: () => false })
    const record = await service.run({ argv: ['status'], intent: 'Read working tree status', source: 'background', cwd: 'D:/missing' })
    expect(spawned).toBe(false)
    expect(record).toMatchObject({ ok: false, exitCode: -1, stderr: 'No repository is open.' })
  })
})

describe('redactCredentials', () => {
  it('keeps ordinary output untouched', () => {
    expect(redactCredentials('git@github.com:owner/repo.git')).toBe('git@github.com:owner/repo.git')
    expect(redactCredentials('https://github.com/owner/repo')).toBe('https://github.com/owner/repo')
  })

  it('strips embedded credentials and query tokens', () => {
    expect(redactCredentials('https://user:secret@example.com/repo')).toBe('https://example.com/repo')
    expect(redactCredentials('?access_token=abc&x=1')).toBe('?access_token=<redacted>&x=1')
    expect(redactCredentials('git clone https://token@example.com/x')).toBe('git clone https://example.com/x')
  })
})
