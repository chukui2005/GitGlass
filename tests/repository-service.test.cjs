const { RepositoryService } = require('../electron/repository-service.cjs')

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
