const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { NETWORK_TIMEOUT_MS } = require('../../electron/git-command-service.cjs')
const {
  classifyCloneSource,
  sourceRepositoryName,
  sanitizeRepositoryName,
  resolveRepositoryName,
  validateCloneTarget,
  normalizeCloneRequest,
  prepareClone,
  executeClone,
  describeCloneFailure,
  REASON,
} = require('../../electron/repository-cloner.cjs')

// An absolute path on whatever platform runs the suite (the clone classifier accepts
// absolute local paths, so the tests must supply one).
const absolute = (relative) => path.resolve(os.tmpdir(), relative)

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
  return {
    calls,
    plan: (request) => ({ phase: 'planned', operationId: request.operationId || 'op-clone-1', intent: request.intent, argv: [...request.argv], displayCommand: `git ${request.argv.join(' ')}`, cwd: request.cwd }),
    run: async (request) => {
      calls.push(request)
      return overrides.run ? overrides.run(request) : { ok: true, argv: ['git', ...request.argv], exitCode: 0, stderr: '' }
    },
  }
}

describe('clone source classification', () => {
  it('accepts HTTPS, SSH and local paths as one argv argument each', () => {
    expect(classifyCloneSource('https://github.com/owner/repo.git')).toEqual({ ok: true, kind: 'url', value: 'https://github.com/owner/repo.git' })
    expect(classifyCloneSource('  http://git.internal/owner/repo.git  ')).toEqual({ ok: true, kind: 'url', value: 'http://git.internal/owner/repo.git' })
    expect(classifyCloneSource('ssh://git@example.com/owner/repo.git')).toEqual({ ok: true, kind: 'ssh', value: 'ssh://git@example.com/owner/repo.git' })
    // The scp-like form keeps its username: that is an address, not a credential.
    expect(classifyCloneSource('git@github.com:owner/repo.git')).toEqual({ ok: true, kind: 'ssh', value: 'git@github.com:owner/repo.git' })
    const local = absolute('repo.git')
    expect(classifyCloneSource(local)).toEqual({ ok: true, kind: 'path', value: local })
  })

  it('refuses embedded credentials and token query parameters before anything runs', () => {
    expect(classifyCloneSource('https://user:secret@example.com/owner/repo.git')).toEqual({ ok: false, reason: REASON.embeddedCredential })
    expect(classifyCloneSource('https://token@example.com/owner/repo.git')).toEqual({ ok: false, reason: REASON.embeddedCredential })
    expect(classifyCloneSource('https://example.com/owner/repo.git?access_token=abc')).toEqual({ ok: false, reason: REASON.secretQuery })
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
  it('plans exactly `git clone -- <source> <name>` in the chosen parent folder', () => {
    const parent = tempDirectory()
    const commands = fakeCommands()
    const prepared = prepareClone({ source: 'https://host/owner/repo.git', parent, name: '', commandService: commands })
    expect(prepared.ok).toBe(true)
    expect(prepared.target).toBe(path.join(parent, 'repo'))
    expect(prepared.plan.argv).toEqual(['clone', '--', 'https://host/owner/repo.git', 'repo'])
    expect(prepared.plan.cwd).toBe(parent)
    expect(prepared.plan.intent).toBe('Clone repository')
    expect(prepared.plan.phase).toBe('planned')
    // A plan is not a CommandRecord: no execution facts may appear on it.
    expect(prepared.plan).not.toHaveProperty('exitCode')
    expect(prepared.plan).not.toHaveProperty('startedAt')
    expect(commands.calls).toHaveLength(0)
  })

  it('blocks before Git is consulted when the inputs are invalid', () => {
    const parent = tempDirectory()
    expect(prepareClone({ source: 'https://user:pw@host/repo.git', parent, name: '', commandService: fakeCommands() })).toMatchObject({
      ok: false,
      blocked: true,
      plan: null,
      reason: REASON.embeddedCredential,
    })
    expect(prepareClone({ source: 'owner/repo', parent, name: '', commandService: fakeCommands() })).toMatchObject({ ok: false, blocked: true })
  })

  it('runs the reviewed plan as one user command with the network deadline', async () => {
    const parent = tempDirectory()
    const commands = fakeCommands()
    const result = await executeClone({ source: 'https://host/owner/repo.git', parent, name: '', commandService: commands, operationId: 'op-reviewed' })
    expect(result.ok).toBe(true)
    expect(commands.calls).toHaveLength(1)
    expect(commands.calls[0]).toMatchObject({
      argv: ['clone', '--', 'https://host/owner/repo.git', 'repo'],
      cwd: parent,
      source: 'user',
      intent: 'Clone repository',
      operationId: 'op-reviewed',
      timeoutMs: NETWORK_TIMEOUT_MS,
    })
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
    expect(describeCloneFailure({ stderr: "remote: Repository not found. fatal: repository 'https://host/x.git/' not found" })).toContain('远程仓库不存在')
    expect(describeCloneFailure({ stderr: 'fatal: unable to access https://host/x.git/: Could not resolve host: host' })).toContain('无法连接远程仓库')
    expect(describeCloneFailure({ stderr: 'fatal: something unexpected' })).toContain('命令账本')
  })
})
