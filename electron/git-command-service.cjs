const { spawn: nodeSpawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const { displayGitCommand } = require('./command-display.mjs')

// Network commands can legitimately take minutes; everything else should fail
// fast instead of leaving the UI (and the update gate) blocked forever.
const DEFAULT_TIMEOUT_MS = 60_000
const NETWORK_TIMEOUT_MS = 300_000
// A single command may not retain an unbounded amount of output: the ledger
// keeps up to 300 records and every one of them crosses IPC.
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024
const KILL_GRACE_MS = 2_000

// Cheap pre-check: most output has neither a URL nor a token parameter, and
// running the patterns over a large diff without this guard costs seconds
// (the scheme pattern can consume the whole string before failing).
const CREDENTIAL_HINTS = /:\/\/|[?&](?:access_token|auth|key|password|passwd|pwd|secret|token)=/i
// Bounded quantifiers keep the patterns linear on long output; a Git remote URL
// is far shorter than these limits.
const URL_CREDENTIALS = /[a-z][a-z0-9+.-]{0,31}:\/\/[^/\s@"']{1,512}@/gi
const URL_QUERY_SECRETS = /([?&](?:access_token|auth|key|password|passwd|pwd|secret|token)=)[^&\s"']+/gi

/**
 * Strips credentials from Git output before it is retained or sent to the UI.
 * Git echoes remote URLs in several failures ("unable to access
 * 'https://user:token@host/...'"), so this runs for every command, not only for
 * `git remote get-url`.
 */
function redactCredentials(value) {
  const text = String(value ?? '')
  if (!CREDENTIAL_HINTS.test(text)) return text
  return text
    .replace(URL_CREDENTIALS, (match) => match.replace(/\/\/[^/\s@"']{1,512}@/, '//'))
    .replace(URL_QUERY_SECRETS, (_match, prefix) => `${prefix}<redacted>`)
}

/**
 * `git apply` reads its patch from stdin, so argv alone cannot say which
 * repository file or which hunk an operation touched. Those two audit facts are
 * added only when a caller supplies them; the patch text itself never enters the
 * ledger. `hunk` carries a `@@ -a,b +c,d @@` range rather than the raw hunk
 * header, but it still goes through the same redaction as stdout/stderr: no
 * annotation may become a way around the credential filter.
 */
function auditTarget({ target = '', hunk = '' } = {}) {
  const fields = {}
  if (typeof target === 'string' && target) fields.target = target
  if (typeof hunk === 'string' && hunk) fields.hunk = redactCredentials(hunk)
  return fields
}

/**
 * The three variables that keep Git from blocking on a credential prompt. A caller
 * may extend the child environment (the clone transport allow-list needs it), but
 * these three are owned by this module.
 */
const RESERVED_ENVIRONMENT = new Set(['GIT_TERMINAL_PROMPT', 'GIT_ASKPASS', 'SSH_ASKPASS'])

/**
 * @param {unknown} env Caller-supplied overrides
 * @returns {Record<string, string>} Only string values, never a prompt variable
 */
function safeEnvironmentOverrides(env) {
  const result = {}
  if (!env || typeof env !== 'object') return result
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string' || RESERVED_ENVIRONMENT.has(key)) continue
    result[key] = value
  }
  return result
}

/**
 * The only module allowed to execute the local Git binary. Each attempt,
 * including inexpensive background reads, appends one immutable CommandRecord.
 */
class GitCommandService {
  constructor({
    spawnImpl = nodeSpawn,
    existsSync = fs.existsSync,
    idFactory = randomUUID,
    now = () => new Date().toISOString(),
    maxRecords = 300,
    defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
    defaultMaxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    killGraceMs = KILL_GRACE_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.spawnImpl = spawnImpl
    this.existsSync = existsSync
    this.idFactory = idFactory
    this.now = now
    this.maxRecords = maxRecords
    this.records = []
    this.defaultTimeoutMs = defaultTimeoutMs
    this.defaultMaxOutputBytes = defaultMaxOutputBytes
    this.killGraceMs = killGraceMs
    this.setTimer = setTimer
    this.clearTimer = clearTimer
  }

  createOperationId() { return this.idFactory() }

  plan({ argv, intent, cwd, operationId = null }) {
    return { phase: 'planned', operationId: operationId || this.createOperationId(), intent, argv: [...argv], displayCommand: displayGitCommand(argv), cwd }
  }

  history() { return [...this.records] }

  /**
   * Records a locally rejected user operation WITHOUT executing anything.
   * The entry keeps the requested argv for audit but is clearly marked as
   * never having run: no exit code, and the visible command line states
   * the rejection so it can never be mistaken for an executed Git command.
   */
  recordRejection({ argv = [], intent, source, cwd, stderr = '', userMessage = '', target = '', hunk = '' }) {
    const note = '本地校验拒绝，未执行 Git 命令'
    const record = {
      id: this.idFactory(), operationId: this.createOperationId(), intent, source,
      argv: ['git', ...argv], displayCommand: note, command: note,
      cwd: cwd || '', ...auditTarget({ target, hunk }), startedAt: this.now(), endedAt: this.now(),
      stdout: '', stderr: redactCredentials(stderr), userMessage, exitCode: null, ok: false,
      outputTruncated: false, timedOut: false, rejected: true,
    }
    this.records.unshift(Object.freeze({ ...record }))
    if (this.records.length > this.maxRecords) this.records.length = this.maxRecords
    return this.records[0]
  }

  async run(request) { return (await this.execute(request)).record }

  /**
   * Same execution and audit record as run(), but it also hands back the raw
   * stdout captured **before** credential redaction.
   *
   * Only patch construction may use this: a single-hunk patch has to reach Git
   * byte for byte, and redaction would silently rewrite a line that merely looks
   * like a credential URL. The CommandRecord stays redacted, so neither the
   * ledger nor IPC ever sees the unredacted text — callers must not retain it.
   */
  async runCapturingOutput(request) { return this.execute(request) }

  /** @returns {Promise<{ record: object, stdout: string }>} */
  async execute({ argv, intent, source, cwd, operationId = null, redactOutput = null, maxOutputBytes = null, timeoutMs = null, input = null, target = '', hunk = '', env = null, retainOutput = true }) {
    const outputLimit = Number.isSafeInteger(maxOutputBytes) && maxOutputBytes > 0 ? maxOutputBytes : this.defaultMaxOutputBytes
    const timeout = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : this.defaultTimeoutMs
    // 有些读取只用于内部计算（例如远程配置版本）：账本留执行元数据，输出一个字都不留。
    const keepOutput = retainOutput !== false
    const record = {
      id: this.idFactory(), operationId: operationId || this.createOperationId(), intent, source,
      argv: ['git', ...argv], displayCommand: displayGitCommand(argv), command: displayGitCommand(argv),
      cwd: cwd || '', ...auditTarget({ target, hunk }), startedAt: this.now(), endedAt: null, stdout: '', stderr: '', exitCode: null, ok: false,
      outputTruncated: false, timedOut: false, ...(keepOutput ? {} : { outputRetained: false }),
    }
    let settled = false
    let timedOut = false
    let timer = null
    let killTimer = null
    const clearTimers = () => {
      if (timer) { this.clearTimer(timer); timer = null }
      if (killTimer) { this.clearTimer(killTimer); killTimer = null }
    }
    // 原始 stdout 单独累积：补丁需要逐字节原文，而 `retainOutput: false` 只用于内部
    // 计算（远程配置版本），账本里连一个字符都不留。
    let rawStdout = ''
    let rawStderr = ''
    const finish = (exitCode, error = '') => {
      clearTimers()
      if (error) rawStderr += error
      if (timedOut) {
        record.timedOut = true
        rawStderr += `\n命令执行超时（${Math.round(timeout / 1000)} 秒），已终止。`
      }
      // Some Git output legitimately contains a credential-bearing URL. Redact
      // before the immutable audit record is retained or sent over IPC, then let
      // the caller apply its own narrower redaction on top.
      if (keepOutput) {
        record.stdout = redactCredentials(rawStdout)
        record.stderr = redactCredentials(rawStderr)
        if (typeof redactOutput === 'function') {
          record.stdout = redactOutput(record.stdout)
          record.stderr = redactOutput(record.stderr)
        }
      }
      record.exitCode = Number.isInteger(exitCode) ? exitCode : -1
      record.ok = record.exitCode === 0 && !timedOut
      record.endedAt = this.now()
      this.records.unshift(Object.freeze({ ...record }))
      if (this.records.length > this.maxRecords) this.records.length = this.maxRecords
      return { record: this.records[0], stdout: rawStdout }
    }
    if (!cwd || !this.existsSync(cwd)) return finish(-1, 'No repository is open.')
    return new Promise((resolve) => {
      const settle = (code, error) => { if (!settled) { settled = true; resolve(finish(code, error)) } }
      let child
      let outputBytes = 0
      try {
        // Never pass a command string or enable a shell: argv is the source of truth.
        // Credential prompts are disabled so a missing credential fails instead of
        // blocking the process (and the update gate) until the timeout kills it.
        // `env` is a narrow, per-command extension (the clone protocol allow-list);
        // the three prompt variables can never be overridden through it.
        child = this.spawnImpl('git', argv, {
          cwd,
          shell: false,
          windowsHide: true,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', ...safeEnvironmentOverrides(env) },
        })
      } catch (error) { settle(-1, error.message); return }
      const collect = (field, data) => {
        if (outputBytes >= outputLimit) {
          if (keepOutput) record.outputTruncated = true
          return
        }
        const text = data.toString()
        const size = Buffer.byteLength(text)
        const remaining = outputLimit - outputBytes
        const chunk = size > remaining ? Buffer.from(text).subarray(0, remaining).toString() : text
        if (field === 'stdout') rawStdout += chunk
        else rawStderr += chunk
        if (keepOutput) record[field] += chunk
        outputBytes += Math.min(size, remaining)
        if (size > remaining && keepOutput) record.outputTruncated = true
      }
      child.stdout?.on('data', (data) => collect('stdout', data))
      child.stderr?.on('data', (data) => collect('stderr', data))
      child.on('error', (error) => settle(-1, error.message))
      child.on('close', (code) => settle(code ?? -1))
      // Patch text is data, never argv: Git reads it from stdin, so it cannot be
      // mistaken for a command line and never reaches the ledger. A broken pipe
      // means Git already exited (a rejected patch, for example); its exit code
      // and stderr are the answer, so the write error is deliberately ignored.
      if (typeof input === 'string') {
        child.stdin?.on?.('error', () => {})
        child.stdin?.end?.(input)
      }
      timer = this.setTimer(() => {
        if (settled) return
        timedOut = true
        try { child.kill('SIGTERM') } catch { /* The close event still settles the record. */ }
        // Escalate when the process ignores SIGTERM; on Windows this is the only
        // way to be sure a hung child cannot keep the repository locked.
        killTimer = this.setTimer(() => { try { child.kill('SIGKILL') } catch { /* Already gone. */ } }, this.killGraceMs)
        killTimer?.unref?.()
      }, timeout)
      timer?.unref?.()
    })
  }
}

module.exports = {
  GitCommandService,
  displayGitCommand,
  redactCredentials,
  DEFAULT_TIMEOUT_MS,
  NETWORK_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
}
