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

  it('accepts a narrow environment extension but never lets it re-enable credential prompts', async () => {
    let received
    const spawnImpl = (binary, argv, options) => {
      received = { binary, argv, options }
      return fakeChild({ code: 0 })
    }
    const service = serviceWith(spawnImpl)
    await service.run({
      argv: ['-c', 'protocol.allow=never', 'clone', '--', 'https://host/x.git', 'x'],
      intent: 'Clone repository',
      source: 'user',
      cwd: 'D:/parent',
      env: { GIT_ALLOW_PROTOCOL: 'https', GIT_TERMINAL_PROMPT: '1', GIT_ASKPASS: 'askpass', SSH_ASKPASS: 'x', IGNORED: 5 },
    })
    // The caller's allow-list reaches Git; the prompt variables stay owned by the service,
    // and non-string values are dropped instead of reaching spawn().
    expect(received.options.env).toMatchObject({ GIT_ALLOW_PROTOCOL: 'https', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' })
    expect(received.options.env.IGNORED).toBeUndefined()
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

describe('patch input on stdin', () => {
  const patch = 'diff --git a/a.txt b/a.txt\nindex 1..2 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n'

  function stdinChild({ code = 0, stderr = '' } = {}) {
    const child = fakeChild({ code, stderr })
    const written = []
    child.stdin = {
      on: (event, handler) => { if (event === 'error') child.stdin.errorHandler = handler },
      end: (data) => { written.push(data) },
    }
    return { child, written }
  }

  it('sends the patch through stdin and keeps the target file and hunk in the record', async () => {
    let written
    const service = serviceWith(() => {
      const harness = stdinChild()
      written = harness.written
      return harness.child
    })
    const record = await service.run({
      argv: ['apply', '--cached', '-'],
      intent: 'Stage diff hunk',
      source: 'user',
      cwd: 'D:/repo',
      input: patch,
      target: 'a.txt',
      hunk: '@@ -1 +1 @@',
    })
    // 补丁是执行输入，不是命令：它不进 argv、不进账本，只经 stdin 交给 Git。
    expect(written).toEqual([patch])
    expect(record.argv).toEqual(['git', 'apply', '--cached', '-'])
    expect(record).toMatchObject({ ok: true, target: 'a.txt', hunk: '@@ -1 +1 @@' })
    expect(JSON.stringify(record)).not.toContain('+new')
  })

  it('adds no audit fields when a command has no patch target', async () => {
    const service = serviceWith(() => fakeChild({}))
    const record = await service.run({ argv: ['status'], intent: 'Read working tree status', source: 'background', cwd: 'D:/repo' })
    expect(record).not.toHaveProperty('target')
    expect(record).not.toHaveProperty('hunk')
  })

  it('keeps Git real exit code when the patch is refused before stdin is read', async () => {
    const service = serviceWith(() => {
      const harness = stdinChild({ code: 128, stderr: 'error: patch failed: a.txt:1\n' })
      const end = harness.child.stdin.end
      harness.child.stdin.end = (data) => {
        end(data)
        // Git 已经退出：写入补丁时管道断开，不能变成未处理的错误。
        harness.child.stdin.errorHandler?.(new Error('EPIPE'))
      }
      return harness.child
    })
    const record = await service.run({ argv: ['apply', '--cached', '-'], intent: 'Stage diff hunk', source: 'user', cwd: 'D:/repo', input: patch, target: 'a.txt', hunk: '@@ -1 +1 @@' })
    expect(record).toMatchObject({ ok: false, exitCode: 128 })
    expect(record.stderr).toContain('patch failed')
  })

  it('records rejected hunk operations without executing anything', () => {
    const service = serviceWith(() => { throw new Error('rejections must not spawn') })
    const record = service.recordRejection({
      argv: ['apply', '--cached', '-R', '-'],
      intent: 'Unstage diff hunk',
      source: 'user',
      cwd: 'D:/repo',
      stderr: 'Diff 已过期',
      userMessage: 'Diff 已过期',
      target: 'a.txt',
      hunk: '@@ -1 +1 @@',
    })
    expect(record).toMatchObject({ rejected: true, exitCode: null, target: 'a.txt', hunk: '@@ -1 +1 @@', stderr: 'Diff 已过期' })
    expect(record.displayCommand).toContain('本地校验拒绝，未执行 Git 命令')
  })
})

describe('unredacted output capture', () => {
  const diffWithToken = 'diff --git a/api.txt b/api.txt\n--- a/api.txt\n+++ b/api.txt\n@@ -1 +1,2 @@\n base\n+endpoint = https://api.example.test/x?access_token=SECRET-42\n'

  it('hands the patch builder the bytes Git produced while the record stays redacted', async () => {
    const service = serviceWith(() => fakeChild({ stdout: diffWithToken }))
    const { record, stdout } = await service.runCapturingOutput({ argv: ['diff', '--', 'api.txt'], intent: 'Read hunk patch', source: 'background', cwd: 'D:/repo', maxOutputBytes: 1024 * 1024 })
    // 补丁路径需要原始字节：行里只是「长得像」凭据，也不能被改写。
    expect(stdout).toContain('SECRET-42')
    // 账本记录仍然脱敏，且与 run() 生成的是同一形状。
    expect(record.stdout).not.toContain('SECRET-42')
    expect(record.stdout).toContain('access_token=<redacted>')
    expect(service.history()).toEqual([record])
    expect(service.history()[0].stdout).not.toContain('SECRET-42')
  })

  it('keeps run() output redacted so no caller can leak the raw text by accident', async () => {
    const service = serviceWith(() => fakeChild({ stdout: diffWithToken }))
    const record = await service.run({ argv: ['diff', '--', 'api.txt'], intent: 'Read file diff', source: 'background', cwd: 'D:/repo' })
    expect(record.stdout).not.toContain('SECRET-42')
    expect(record).not.toHaveProperty('stdoutRaw')
  })

  it('reports the same real failure through both entry points', async () => {
    const service = serviceWith(() => fakeChild({ stderr: 'fatal: bad revision', code: 128 }))
    const { record, stdout } = await service.runCapturingOutput({ argv: ['diff', '--', 'api.txt'], intent: 'Read hunk patch', source: 'background', cwd: 'D:/repo' })
    expect(record).toMatchObject({ ok: false, exitCode: 128 })
    expect(stdout).toBe('')
  })
})

describe('redactCredentials', () => {
  it('leaves large credential-free output untouched without pathological backtracking', () => {
    const big = 'y'.repeat(200_000)
    const started = Date.now()
    expect(redactCredentials(big)).toBe(big)
    // The unbounded scheme pattern took seconds per 64 KiB chunk; keep this honest.
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('redacts a credential URL inside large output', () => {
    const text = 'x'.repeat(100_000) + ' https://user:tok@example.com/repo\n'
    const redacted = redactCredentials(text)
    expect(redacted).not.toContain('tok@')
    expect(redacted).toContain('https://example.com/repo')
  })

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
