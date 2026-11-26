const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { GitCommandService, NETWORK_TIMEOUT_MS } = require('../../electron/git-command-service.cjs')
const {
  classifyCloneSource,
  redactCloneSource,
  redactCloneOutput,
  cloneProtocolArgs,
  cloneDisplayCommand,
  sourceRepositoryName,
  sanitizeRepositoryName,
  resolveRepositoryName,
  validateCloneTarget,
  normalizeCloneRequest,
  prepareClone,
  executeClone,
  describeCloneFailure,
  PLACEHOLDER,
  REASON,
} = require('../../electron/repository-cloner.cjs')

// An absolute path on whatever platform runs the suite (the clone classifier accepts
// absolute local paths, so the tests must supply one).
const absolute = (relative) => path.resolve(os.tmpdir(), relative)
// The local-path protocol pin: a folder travels over Git's `file` transport.
const FILE_PROTOCOL = ['-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always']
const HTTPS_PROTOCOL = ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always']

let directory
afterEach(() => {
  if (directory) fs.rmSync(directory, { recursive: true, force: true })
  directory = null
})

function tempDirectory() {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-cloner-unit-'))
  return directory
}

// The smallest possible stand-in for GitCommandService: the clone module only needs
// plan() and run(), and the assertions are about what it asks Git to do.
function fakeCommands(overrides = {}) {
  const calls = []
  const state = { planCalls: 0 }
  return {
    calls,
    state,
    plan: (request) => {
      state.planCalls += 1
      return { phase: 'planned', operationId: request.operationId || 'op-clone-1', intent: request.intent, argv: [...request.argv], displayCommand: `git ${request.argv.join(' ')}`, cwd: request.cwd }
    },
    run: async (request) => {
      calls.push(request)
      return overrides.run ? overrides.run(request) : { ok: true, argv: ['git', ...request.argv], exitCode: 0, stderr: '' }
    },
  }
}

// A GitCommandService whose child process is fully faked, used to prove what the
// ledger record looks like without touching the network.
function fakedGit(stderr, exitCode = 128) {
  return new GitCommandService({
    existsSync: () => true,
    spawnImpl: () => {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from(stderr))
        child.emit('close', exitCode)
      })
      return child
    },
  })
}

describe('clone source classification (structured)', () => {
  it('accepts HTTPS, SSH and local paths and records the transport each one needs', () => {
    expect(classifyCloneSource('https://github.com/owner/repo.git')).toMatchObject({ ok: true, kind: 'url', scheme: 'https', protocol: 'https', value: 'https://github.com/owner/repo.git' })
    expect(classifyCloneSource('  http://git.internal/owner/repo.git  ')).toMatchObject({ ok: true, kind: 'url', scheme: 'http', protocol: 'http', value: 'http://git.internal/owner/repo.git' })
    // A username is an address part in SSH, not a credential: it survives classification.
    expect(classifyCloneSource('ssh://git@example.com:2222/owner/repo.git')).toMatchObject({
      ok: true,
      kind: 'ssh',
      scheme: 'ssh',
      protocol: 'ssh',
      value: 'ssh://git@example.com:2222/owner/repo.git',
      display: 'ssh://git@example.com:2222/owner/repo.git',
    })
    expect(classifyCloneSource('git@github.com:owner/repo.git')).toMatchObject({ ok: true, kind: 'ssh', protocol: 'ssh', value: 'git@github.com:owner/repo.git', display: 'git@github.com:owner/repo.git' })
    expect(classifyCloneSource(absolute('repo.git'))).toMatchObject({ ok: true, kind: 'path', scheme: 'path', protocol: 'file' })
  })

  it('refuses HTTP(S) user info, SSH passwords and percent-encoded secret query keys', () => {
    expect(classifyCloneSource('https://user:secret@example.com/owner/repo.git')).toMatchObject({ ok: false, reason: REASON.embeddedCredential })
    expect(classifyCloneSource('https://token@example.com/owner/repo.git')).toMatchObject({ ok: false, reason: REASON.embeddedCredential })
    // An SSH password is credential material too, even though the username is fine.
    expect(classifyCloneSource('ssh://deploy:hunter2@example.com/owner/repo.git')).toMatchObject({ ok: false, reason: REASON.sshPassword })
    expect(classifyCloneSource('https://example.com/owner/repo.git?access_token=abc')).toMatchObject({ ok: false, reason: REASON.secretQuery })
    expect(classifyCloneSource('https://example.com/owner/repo.git?access%5Ftoken=abc')).toMatchObject({ ok: false, reason: REASON.secretQuery })
    expect(classifyCloneSource('https://example.com/owner/repo.git?%74oken=abc')).toMatchObject({ ok: false, reason: REASON.secretQuery })
    // Normal query parameters are still ordinary address parts.
    expect(classifyCloneSource('https://example.com/owner/repo.git?ref=main')).toMatchObject({ ok: true, kind: 'url' })
  })

  it('refuses unsupported schemes, relative paths and garbage', () => {
    expect(classifyCloneSource('ftp://example.com/repo.git')).toEqual({ ok: false, reason: REASON.unsupportedScheme })
    expect(classifyCloneSource('owner/repo.git')).toEqual({ ok: false, reason: REASON.invalidSource })
    expect(classifyCloneSource('https://')).toEqual({ ok: false, reason: REASON.invalidSource })
    expect(classifyCloneSource('https://example.com/a\u0000b')).toEqual({ ok: false, reason: REASON.invalidSource })
    expect(classifyCloneSource(`https://example.com/${'a'.repeat(3000)}`)).toEqual({ ok: false, reason: REASON.invalidSource })
    expect(classifyCloneSource(null)).toEqual({ ok: false, reason: REASON.invalidSource })
  })
})

describe('placeholder redaction', () => {
  it('keeps a normal SSH username while hiding every credential component', () => {
    expect(redactCloneSource('ssh://git@host/owner/repo.git')).toBe('ssh://git@host/owner/repo.git')
    expect(redactCloneSource('ssh://deploy:hunter2@host/owner/repo.git')).toBe(`ssh://deploy:${PLACEHOLDER}@host/owner/repo.git`)
    expect(redactCloneSource('https://user:hunter2@host/owner/repo.git')).toBe(`https://${PLACEHOLDER}@host/owner/repo.git`)
    expect(redactCloneSource('https://token@host/owner/repo.git')).toBe(`https://${PLACEHOLDER}@host/owner/repo.git`)
    expect(redactCloneSource('https://host/owner/repo.git?access_token=abc&ref=main')).toBe(`https://host/owner/repo.git?access_token=${PLACEHOLDER}&ref=main`)
    // Fragments are never sent to Git, so they never appear in a preview either.
    expect(redactCloneSource('https://host/owner/repo.git#secret')).toBe('https://host/owner/repo.git')
    const local = absolute('repo.git')
    expect(redactCloneSource(local)).toBe(local)
    expect(redactCloneSource('git@host:owner/repo.git')).toBe('git@host:owner/repo.git')
  })

  it('puts the placeholder into the preview and into Git output', () => {
    // Even if a later change let credentials through classification, the reviewed
    // command would still show the placeholder instead of the secret.
    expect(cloneDisplayCommand({ protocol: 'https', display: `https://${PLACEHOLDER}@host/owner/repo.git` }, 'repo')).toBe(
      `git -c protocol.allow=never -c protocol.https.allow=always clone -- https://${PLACEHOLDER}@host/owner/repo.git repo`,
    )
    expect(cloneDisplayCommand({ protocol: 'ssh', display: `ssh://deploy:${PLACEHOLDER}@host/owner/repo.git` }, 'repo')).toContain(`ssh://deploy:${PLACEHOLDER}@host`)
    const output = redactCloneOutput("fatal: unable to access 'https://user:hunter2@host/x.git/': 401\ntoken=abc&access_token=def")
    expect(output).not.toContain('hunter2')
    expect(output).toContain(`https://${PLACEHOLDER}@host/x.git/`)
    expect(output).toContain(`access_token=${PLACEHOLDER}`)
  })

  it('pins the transport for the classified address only', () => {
    expect(cloneProtocolArgs({ protocol: 'https' })).toEqual(HTTPS_PROTOCOL)
    expect(cloneProtocolArgs({ protocol: 'ssh' })).toEqual(['-c', 'protocol.allow=never', '-c', 'protocol.ssh.allow=always'])
    expect(cloneProtocolArgs({ protocol: 'file' })).toEqual(FILE_PROTOCOL)
    // No protocol name may be injected from outside the classifier's fixed map.
    expect(cloneProtocolArgs({ protocol: 'ext::sh -c echo' })).toEqual(['-c', 'protocol.allow=never', '-c', 'protocol.ext::sh -c echo.allow=always'])
  })
})

describe('repository folder names', () => {
  it('derives the default folder from the address', () => {
    expect(sourceRepositoryName({ kind: 'url', value: 'https://host/owner/repo.git' })).toBe('repo')
    expect(sourceRepositoryName({ kind: 'url', value: 'https://host/owner/repo/' })).toBe('repo')
    expect(sourceRepositoryName({ kind: 'ssh', value: 'git@host:owner/repo.git' })).toBe('repo')
    expect(sourceRepositoryName({ kind: 'ssh', value: 'ssh://git@host/owner/repo.git' })).toBe('repo')
    expect(sourceRepositoryName({ kind: 'path', value: absolute('demo.git') })).toBe('demo')
    expect(sourceRepositoryName({ kind: 'url', value: 'https://host' })).toBe('repository')
  })

  it('sanitizes characters Windows cannot create and reserved names', () => {
    expect(sanitizeRepositoryName('my:repo')).toBe('my-repo')
    expect(sanitizeRepositoryName('  spaced name  ')).toBe('spaced name')
    expect(sanitizeRepositoryName('trailing.')).toBe('trailing')
    expect(sanitizeRepositoryName('con')).toBe('con-repo')
    expect(sanitizeRepositoryName('lpt1.txt')).toBe('lpt1.txt-repo')
    expect(sanitizeRepositoryName('')).toBe('repository')
    expect(sanitizeRepositoryName('a'.repeat(140))).toHaveLength(100)
  })

  it('validates an explicit folder name instead of rewriting it', () => {
    const source = { kind: 'url', value: 'https://host/owner/repo.git' }
    expect(resolveRepositoryName('', source)).toEqual({ ok: true, name: 'repo', derived: true })
    expect(resolveRepositoryName('custom', source)).toEqual({ ok: true, name: 'custom', derived: false })
    expect(resolveRepositoryName('..', source)).toEqual({ ok: false, reason: REASON.invalidName })
    expect(resolveRepositoryName('a/b', source)).toEqual({ ok: false, reason: REASON.invalidName })
    expect(resolveRepositoryName('name.', source)).toEqual({ ok: false, reason: REASON.invalidName })
    expect(resolveRepositoryName('con', source)).toEqual({ ok: false, reason: REASON.reservedName })
    expect(resolveRepositoryName('x'.repeat(101), source)).toEqual({ ok: false, reason: REASON.invalidName })
  })
})

describe('clone target validation', () => {
  const source = { kind: 'url', value: 'https://host/owner/repo.git' }

  it('accepts a new folder and an existing empty folder', () => {
    const parent = tempDirectory()
    const fresh = validateCloneTarget({ parent, name: 'repo', source })
    expect(fresh).toEqual({ ok: true, parent, name: 'repo', target: path.join(parent, 'repo'), existingEmpty: false })

    fs.mkdirSync(path.join(parent, 'existing'))
    expect(validateCloneTarget({ parent, name: 'existing', source })).toEqual({
      ok: true,
      parent,
      name: 'existing',
      target: path.join(parent, 'existing'),
      existingEmpty: true,
    })
  })

  it('refuses a non-empty target, a target that is a file and a missing parent', () => {
    const parent = tempDirectory()
    fs.mkdirSync(path.join(parent, 'full'))
    fs.writeFileSync(path.join(parent, 'full', 'keep.txt'), 'keep')
    expect(validateCloneTarget({ parent, name: 'full', source })).toEqual({ ok: false, reason: REASON.targetNotEmpty })

    fs.writeFileSync(path.join(parent, 'file.txt'), 'x')
    expect(validateCloneTarget({ parent, name: 'file.txt', source })).toEqual({ ok: false, reason: REASON.targetIsFile })

    expect(validateCloneTarget({ parent: path.join(parent, 'missing'), name: 'repo', source })).toEqual({ ok: false, reason: REASON.missingParent })
    expect(validateCloneTarget({ parent: '', name: 'repo', source })).toEqual({ ok: false, reason: REASON.invalidParent })
  })
})

describe('clone request contract', () => {
  it('accepts only the three documented fields', () => {
    expect(normalizeCloneRequest({ source: 'https://host/a.git', parent: absolute('work'), name: '' })).toEqual({
      ok: true,
      source: 'https://host/a.git',
      parent: absolute('work'),
      name: '',
      operationId: null,
    })
    expect(normalizeCloneRequest({ source: 'x', parent: 'y', argv: ['clone'] })).toEqual({ ok: false, reason: '克隆请求包含不支持的字段。' })
    expect(normalizeCloneRequest({ source: 'x', parent: 'y', name: 'z', operationId: 'op-1' })).toEqual({ ok: false, reason: '克隆请求包含不支持的字段。' })
    expect(normalizeCloneRequest({ source: 'x', parent: 'y', operationId: 'op-1' }, { allowOperationId: true })).toEqual({
      ok: true,
      source: 'x',
      parent: 'y',
      name: '',
      operationId: 'op-1',
    })
    expect(normalizeCloneRequest({ source: 'x', parent: 'y', operationId: 'has space' }, { allowOperationId: true })).toEqual({ ok: false, reason: '克隆请求的操作标识无效。' })
    expect(normalizeCloneRequest(null)).toEqual({ ok: false, reason: REASON.invalidSource })
  })
})

describe('clone plans and execution', () => {
  it('plans the protocol pin plus `git clone -- <source> <name>` in the chosen parent folder', () => {
    const parent = tempDirectory()
    const commands = fakeCommands()
    const prepared = prepareClone({ source: 'https://host/owner/repo.git', parent, name: '', commandService: commands })
    expect(prepared.ok).toBe(true)
    expect(prepared.target).toBe(path.join(parent, 'repo'))
    expect(prepared.plan.argv).toEqual([...HTTPS_PROTOCOL, 'clone', '--', 'https://host/owner/repo.git', 'repo'])
    expect(prepared.plan.displayCommand).toBe('git -c protocol.allow=never -c protocol.https.allow=always clone -- https://host/owner/repo.git repo')
    expect(prepared.plan.cwd).toBe(parent)
    expect(prepared.plan.intent).toBe('Clone repository')
    expect(prepared.plan.phase).toBe('planned')
    expect(prepared.source).toEqual({ kind: 'url', scheme: 'https', protocol: 'https', display: 'https://host/owner/repo.git' })
    // A plan is not a CommandRecord: no execution facts may appear on it.
    expect(prepared.plan).not.toHaveProperty('exitCode')
    expect(prepared.plan).not.toHaveProperty('startedAt')
    expect(commands.calls).toHaveLength(0)
  })

  it('blocks invalid or credential-bearing requests with no plan and without touching Git', async () => {
    const parent = tempDirectory()
    const cases = [
      ['https://user:pw@host/repo.git', REASON.embeddedCredential],
      ['https://token@host/repo.git', REASON.embeddedCredential],
      ['ssh://deploy:hunter2@host/repo.git', REASON.sshPassword],
      ['https://host/repo.git?access%5Ftoken=abc', REASON.secretQuery],
    ]
    for (const [source, reason] of cases) {
      const commands = fakeCommands()
      const prepared = prepareClone({ source, parent, name: '', commandService: commands })
      expect(prepared, source).toMatchObject({ ok: false, blocked: true, plan: null, reason })
      // The rejection itself must not echo the secret back to the user.
      expect(prepared.reason, source).not.toContain('hunter2')
      expect(prepared.reason, source).not.toContain('pw@')

      const executed = await executeClone({ source, parent, name: '', commandService: commands })
      expect(executed, source).toMatchObject({ ok: false, plan: null, execution: null })
      // No plan was built and no command was started: the module stopped before Git.
      expect(commands.state.planCalls, source).toBe(0)
      expect(commands.calls, source).toHaveLength(0)
    }

    // A real GitCommandService proves the same thing at the ledger: nothing ran.
    const ledger = new GitCommandService()
    const executed = await executeClone({ source: 'https://user:pw@host/repo.git', parent, name: '', commandService: ledger })
    expect(executed.ok).toBe(false)
    expect(ledger.history()).toHaveLength(0)
    expect(fs.existsSync(path.join(parent, 'repo'))).toBe(false)
  })

  it('runs the reviewed plan as one user command with the network deadline', async () => {
    const parent = tempDirectory()
    const commands = fakeCommands()
    const result = await executeClone({ source: 'https://host/owner/repo.git', parent, name: '', commandService: commands, operationId: 'op-reviewed' })
    expect(result.ok).toBe(true)
    expect(commands.calls).toHaveLength(1)
    expect(commands.calls[0]).toMatchObject({
      argv: [...HTTPS_PROTOCOL, 'clone', '--', 'https://host/owner/repo.git', 'repo'],
      cwd: parent,
      source: 'user',
      intent: 'Clone repository',
      operationId: 'op-reviewed',
      timeoutMs: NETWORK_TIMEOUT_MS,
    })
    expect(typeof commands.calls[0].redactOutput).toBe('function')
    // Git's own error output goes through the placeholder layer before the ledger keeps it.
    expect(commands.calls[0].redactOutput("fatal: unable to access 'https://user:hunter2@host/x.git/'")).toBe(`fatal: unable to access 'https://${PLACEHOLDER}@host/x.git/'`)
  })

  it('keeps a credential echoed by Git out of the ledger record', async () => {
    const parent = tempDirectory()
    // Both shapes Git actually echoes back when a remote rejects a request.
    const commands = fakedGit("fatal: unable to access 'https://host/x.git/?access_token=tok3n': 401\nfatal: ssh://deploy:hunter2@host/repo.git denied")
    const result = await executeClone({ source: 'https://host/owner/repo.git', parent, name: '', commandService: commands })
    expect(result.ok).toBe(false)
    const record = commands.history()[0]
    expect(record.ok).toBe(false)
    expect(record.stderr).not.toContain('tok3n')
    expect(record.stderr).not.toContain('hunter2')
    // The placeholder is what the user reads, so a diagnostic URL stays readable.
    expect(record.stderr).toContain(`access_token=${PLACEHOLDER}`)
  })

  it('returns the real failure with its explanation instead of throwing', async () => {
    const parent = tempDirectory()
    const commands = fakeCommands({ run: async () => ({ ok: false, exitCode: 128, stderr: "fatal: could not read Username for 'https://host': terminal prompts disabled", timedOut: false }) })
    const result = await executeClone({ source: 'https://host/owner/repo.git', parent, name: '', commandService: commands })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('认证失败')
    expect(result.execution.exitCode).toBe(128)
  })
})

describe('clone failure explanations', () => {
  it('maps Git and timeout evidence to one Chinese sentence each', () => {
    expect(describeCloneFailure({ timedOut: true, stderr: '' })).toContain('克隆超时')
    expect(describeCloneFailure({ stderr: 'fatal: Authentication failed for https://host/repo.git/' })).toContain('认证失败')
    expect(describeCloneFailure({ stderr: "fatal: destination path 'repo' already exists and is not an empty directory." })).toContain('目标目录已存在且非空')
    // A transport blocked by the protocol pin is explained as such, not as "wrong address".
    expect(describeCloneFailure({ stderr: "fatal: transport 'file' not allowed" })).toContain('传输协议')
    expect(describeCloneFailure({ stderr: "remote: Repository not found. fatal: repository 'https://host/x.git/' not found" })).toContain('远程仓库不存在')
    expect(describeCloneFailure({ stderr: 'fatal: unable to access https://host/x.git/: Could not resolve host: host' })).toContain('无法连接远程仓库')
    expect(describeCloneFailure({ stderr: 'fatal: something unexpected' })).toContain('命令账本')
  })
})
