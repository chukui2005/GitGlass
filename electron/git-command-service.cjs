const { spawn: nodeSpawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')

function quoteForDisplay(value) {
  const text = String(value)
  return /[\s"']/.test(text) ? JSON.stringify(text) : text
}

function displayGitCommand(argv) {
  return ['git', ...argv].map(quoteForDisplay).join(' ')
}

/**
 * The only module allowed to execute the local Git binary. Each attempt,
 * including inexpensive background reads, appends one immutable CommandRecord.
 */
class GitCommandService {
  constructor({ spawnImpl = nodeSpawn, existsSync = fs.existsSync, idFactory = randomUUID, now = () => new Date().toISOString(), maxRecords = 300 } = {}) {
    this.spawnImpl = spawnImpl
    this.existsSync = existsSync
    this.idFactory = idFactory
    this.now = now
    this.maxRecords = maxRecords
    this.records = []
  }

  createOperationId() { return this.idFactory() }

  plan({ argv, intent, cwd, operationId = null }) {
    return { phase: 'planned', operationId: operationId || this.createOperationId(), intent, argv: [...argv], displayCommand: displayGitCommand(argv), cwd }
  }

  history() { return [...this.records] }

  async run({ argv, intent, source, cwd, operationId = null, redactOutput = null, maxOutputBytes = null }) {
    const record = {
      id: this.idFactory(), operationId: operationId || this.createOperationId(), intent, source,
      argv: ['git', ...argv], displayCommand: displayGitCommand(argv), command: displayGitCommand(argv),
      cwd: cwd || '', startedAt: this.now(), endedAt: null, stdout: '', stderr: '', exitCode: null, ok: false, outputTruncated: false,
    }
    const finish = (exitCode, error = '') => {
      if (error) record.stderr += error
      // Some Git queries can legitimately return a credential-bearing URL.
      // Redact before the immutable audit record is retained or sent over IPC.
      if (typeof redactOutput === 'function') {
        record.stdout = redactOutput(record.stdout)
        record.stderr = redactOutput(record.stderr)
      }
      record.exitCode = Number.isInteger(exitCode) ? exitCode : -1
      record.ok = record.exitCode === 0
      record.endedAt = this.now()
      this.records.unshift(Object.freeze({ ...record }))
      if (this.records.length > this.maxRecords) this.records.length = this.maxRecords
      return this.records[0]
    }
    if (!cwd || !this.existsSync(cwd)) return finish(-1, 'No repository is open.')
    return new Promise((resolve) => {
      let settled = false
      const settle = (code, error) => { if (!settled) { settled = true; resolve(finish(code, error)) } }
      let child
      try {
        // Never pass a command string or enable a shell: argv is the source of truth.
        child = this.spawnImpl('git', argv, { cwd, shell: false, windowsHide: true })
      } catch (error) { settle(-1, error.message); return }
      const collect = (field, data) => {
        const text = data.toString()
        if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) { record[field] += text; return }
        const used = Buffer.byteLength(record.stdout) + Buffer.byteLength(record.stderr)
        const remaining = maxOutputBytes - used
        if (remaining <= 0) { record.outputTruncated = true; return }
        const slice = Buffer.from(text).subarray(0, remaining).toString()
        record[field] += slice
        if (Buffer.byteLength(text) > remaining) record.outputTruncated = true
      }
      child.stdout?.on('data', (data) => collect('stdout', data))
      child.stderr?.on('data', (data) => collect('stderr', data))
      child.on('error', (error) => settle(-1, error.message))
      child.on('close', (code) => settle(code ?? -1))
    })
  }
}

module.exports = { GitCommandService, displayGitCommand }
