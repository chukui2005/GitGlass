const { RepositoryService, isBranchName } = require('../electron/repository-service.cjs')

function commandsFor(records) {
  return { run: async (request) => ({ ...request, id: 'record', operationId: 'operation', argv: ['git', ...request.argv], displayCommand: `git ${request.argv.join(' ')}`, stdout: records.shift() ?? '', stderr: '', exitCode: 0, ok: true }), plan: (request) => ({ phase: 'planned', ...request, argv: [...request.argv], displayCommand: `git ${request.argv.join(' ')}` }) }
}
describe('Branch workspace safety', () => {
  it('blocks a switch on a dirty worktree without constructing a switch plan', async () => {
    const repo = new RepositoryService(commandsFor(['main\n', ' M changed.js\0']), () => 'D:/repo')
    const result = await repo.prepareSwitch('feature/report')
    expect(result).toMatchObject({ ok: false, blocked: true })
    expect(result.reason).toContain('不会自动 stash')
  })
  it('plans, then executes, a clean branch switch using argv', async () => {
    const repo = new RepositoryService(commandsFor(['main\n', '', 'main\n', '', '']), () => 'D:/repo')
    const plan = await repo.prepareSwitch('feature/report')
    expect(plan.plan).toMatchObject({ phase: 'planned', argv: ['switch', 'feature/report'], displayCommand: 'git switch feature/report' })
    const result = await repo.executeSwitch('feature/report')
    expect(result.execution.argv).toEqual(['git', 'switch', 'feature/report'])
  })
  it('rejects unsafe branch names before a command is planned', () => {
    expect(isBranchName('feature/ok')).toBe(true)
    expect(isBranchName('--orphan')).toBe(false)
    expect(isBranchName('bad..name')).toBe(false)
  })
})
