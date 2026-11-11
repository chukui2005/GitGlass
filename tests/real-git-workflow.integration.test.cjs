const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { GitCommandService } = require('../electron/git-command-service.cjs')
const { RepositoryService } = require('../electron/repository-service.cjs')

const temporaryRepositories = []

async function createRepository(commands) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-integration-'))
  temporaryRepositories.push(cwd)
  const run = (argv, intent) => commands.run({ argv, intent, source: 'background', cwd })
  expect((await run(['init', '-b', 'main'], 'Initialize test repository')).ok).toBe(true)
  expect((await run(['config', 'user.name', 'GitGlass Integration'], 'Configure test author')).ok).toBe(true)
  expect((await run(['config', 'user.email', 'integration@gitglass.local'], 'Configure test email')).ok).toBe(true)
  fs.writeFileSync(path.join(cwd, 'note.txt'), 'base\n')
  expect((await run(['add', '--', 'note.txt'], 'Seed test file')).ok).toBe(true)
  expect((await run(['commit', '-m', 'chore: seed repository'], 'Seed test repository')).ok).toBe(true)
  return cwd
}

afterEach(() => {
  while (temporaryRepositories.length) fs.rmSync(temporaryRepositories.pop(), { recursive: true, force: true })
})

describe('real Git workflow integration', () => {
  it('records stage, commit, branch creation, clean switch, dirty switch block, and a shared plan/execution operation ID', async () => {
    const commands = new GitCommandService()
    const cwd = await createRepository(commands)
    const repository = new RepositoryService(commands, () => cwd)

    fs.appendFileSync(path.join(cwd, 'note.txt'), 'edited through GitGlass\n')
    const diff = await repository.diff({ path: 'note.txt', area: 'unstaged' })
    expect(diff.ok).toBe(true)
    expect(diff.stdout).toContain('+edited through GitGlass')

    const stage = await repository.stage('note.txt')
    expect(stage).toMatchObject({ ok: true, argv: ['git', 'add', '--', 'note.txt'], source: 'user' })
    const commit = await repository.commit('feat: record a real workflow')
    expect(commit).toMatchObject({ ok: true, argv: ['git', 'commit', '-m', 'feat: record a real workflow'], source: 'user' })

    for (const invalidBranch of ['@{}', 'feature/.hidden', 'main.lock']) {
      const rejected = await repository.prepareSwitch(invalidBranch)
      expect(rejected).toMatchObject({ ok: false, blocked: true, plan: null })
      expect(rejected.validation).toMatchObject({ ok: false, argv: ['git', 'check-ref-format', '--branch', invalidBranch] })
    }

    const createPlan = await repository.prepareSwitch('feature/ledger', true)
    expect(createPlan.plan).toMatchObject({ phase: 'planned', operationId: expect.any(String), argv: ['switch', '-c', 'feature/ledger'] })
    const createExecution = await repository.executeSwitch('feature/ledger', true, createPlan.plan.operationId)
    expect(createExecution.execution).toMatchObject({ ok: true, argv: ['git', 'switch', '-c', 'feature/ledger'], operationId: createPlan.plan.operationId })

    const switchPlan = await repository.prepareSwitch('main')
    const switchExecution = await repository.executeSwitch('main', false, switchPlan.plan.operationId)
    expect(switchExecution.execution).toMatchObject({ ok: true, argv: ['git', 'switch', 'main'], operationId: switchPlan.plan.operationId })

    fs.appendFileSync(path.join(cwd, 'note.txt'), 'left dirty\n')
    const blocked = await repository.prepareSwitch('feature/ledger')
    expect(blocked).toMatchObject({ ok: false, blocked: true, plan: null })
    expect(blocked.reason).toContain('不会自动 stash')

    const ledger = commands.history()
    expect(ledger.some((record) => record.operationId === createPlan.plan.operationId && record.argv.join(' ') === 'git switch -c feature/ledger')).toBe(true)
    expect(ledger.some((record) => record.operationId === switchPlan.plan.operationId && record.argv.join(' ') === 'git switch main')).toBe(true)
    expect(ledger.some((record) => record.argv.join(' ') === 'git diff -- note.txt')).toBe(true)
    expect(ledger.some((record) => record.argv.join(' ') === 'git status --porcelain=v1 -z')).toBe(true)
  })
})
