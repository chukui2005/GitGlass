const { EventEmitter } = require('node:events')
const { GitCommandService } = require('../electron/git-command-service.cjs')

describe('GitCommandService', () => {
  it('records argv, output, result, source and safe spawn options', async () => {
    let received
    const spawnImpl = (binary, argv, options) => {
      received = { binary, argv, options }
      const child = new EventEmitter()
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
      queueMicrotask(() => { child.stdout.emit('data', Buffer.from('main\n')); child.stderr.emit('data', Buffer.from('warning\n')); child.emit('close', 0) })
      return child
    }
    const service = new GitCommandService({ spawnImpl, existsSync: () => true, idFactory: () => 'id-1', now: () => '2026-01-01T00:00:00.000Z' })
    const record = await service.run({ argv: ['status', '--porcelain=v1'], intent: 'Read working tree status', source: 'background', cwd: 'D:/repo' })
    expect(received).toEqual({ binary: 'git', argv: ['status', '--porcelain=v1'], options: { cwd: 'D:/repo', shell: false, windowsHide: true } })
    expect(record).toMatchObject({ id: 'id-1', operationId: 'id-1', source: 'background', argv: ['git', 'status', '--porcelain=v1'], displayCommand: 'git status --porcelain=v1', stdout: 'main\n', stderr: 'warning\n', exitCode: 0, ok: true })
    expect(service.history()).toEqual([record])
  })
  it('keeps a failure with stderr and a nonzero exit code', async () => {
    const spawnImpl = () => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); queueMicrotask(() => { child.stderr.emit('data', Buffer.from('fatal: failed')); child.emit('close', 128) }); return child }
    const service = new GitCommandService({ spawnImpl, existsSync: () => true })
    const record = await service.run({ argv: ['commit', '-m', 'test'], intent: 'Create commit', source: 'user', cwd: 'D:/repo' })
    expect(record).toMatchObject({ ok: false, exitCode: 128, stderr: 'fatal: failed', source: 'user' })
  })
})
