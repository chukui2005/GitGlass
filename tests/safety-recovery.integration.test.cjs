const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { GitCommandService } = require('../electron/git-command-service.cjs')
const { RepositoryService, rescueBranchName } = require('../electron/repository-service.cjs')

const temporaryRepositories = []

async function createRepository(commands) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-safety-'))
  temporaryRepositories.push(cwd)
  const run = (argv, intent) => commands.run({ argv, intent, source: 'background', cwd })
  expect((await run(['init', '-b', 'main'], 'Initialize safety repository')).ok).toBe(true)
  expect((await run(['config', 'user.name', 'GitGlass Safety Test'], 'Configure safety author')).ok).toBe(true)
  expect((await run(['config', 'user.email', 'safety@gitglass.local'], 'Configure safety email')).ok).toBe(true)
  fs.writeFileSync(path.join(cwd, 'note.txt'), 'base\n')
  expect((await run(['add', '--', 'note.txt'], 'Stage safety seed')).ok).toBe(true)
  expect((await run(['commit', '-m', 'chore: seed safety repository'], 'Commit safety seed')).ok).toBe(true)
  return { cwd, run }
}

afterEach(() => {
  while (temporaryRepositories.length) fs.rmSync(temporaryRepositories.pop(), { recursive: true, force: true })
})

describe('real safety and recovery integration', () => {
  it('uses reviewed plans to discard one file, delete only a merged branch, and create a reflog rescue branch', async () => {
    const commands = new GitCommandService()
    const { cwd, run } = await createRepository(commands)
    const repository = new RepositoryService(commands, () => cwd)

    fs.appendFileSync(path.join(cwd, 'note.txt'), 'discard this line\n')
    const discardPlan = await repository.prepareDiscard('note.txt')
    expect(discardPlan.plan).toMatchObject({ phase: 'planned', operationId: expect.any(String), argv: ['restore', '--worktree', '--', 'note.txt'] })
    expect(fs.readFileSync(path.join(cwd, 'note.txt'), 'utf8')).toContain('discard this line')
    const discard = await repository.executeDiscard('note.txt', discardPlan.plan.operationId)
    expect(discard.execution).toMatchObject({ ok: true, argv: ['git', 'restore', '--worktree', '--', 'note.txt'], operationId: discardPlan.plan.operationId, source: 'user' })
    expect(fs.readFileSync(path.join(cwd, 'note.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('base\n')

    fs.writeFileSync(path.join(cwd, 'untracked.txt'), 'do not delete\n')
    expect((await repository.prepareDiscard('untracked.txt')).blocked).toBe(true)
    fs.appendFileSync(path.join(cwd, 'note.txt'), 'stage this line\n')
    expect((await repository.stage('note.txt')).ok).toBe(true)
    expect((await repository.prepareDiscard('note.txt')).blocked).toBe(true)
    expect((await repository.unstage('note.txt')).ok).toBe(true)
    fs.writeFileSync(path.join(cwd, 'note.txt'), 'base\n')

    expect((await run(['branch', 'feature/merged'], 'Create merged branch fixture')).ok).toBe(true)
    const deletePlan = await repository.prepareDeleteMergedBranch('feature/merged')
    expect(deletePlan.plan).toMatchObject({ argv: ['branch', '-d', 'feature/merged'], operationId: expect.any(String) })
    const deleted = await repository.executeDeleteMergedBranch('feature/merged', deletePlan.plan.operationId)
    expect(deleted.execution).toMatchObject({ ok: true, argv: ['git', 'branch', '-d', 'feature/merged'], operationId: deletePlan.plan.operationId, source: 'user' })

    expect((await run(['switch', '-c', 'feature/unmerged'], 'Create unmerged branch fixture')).ok).toBe(true)
    fs.appendFileSync(path.join(cwd, 'note.txt'), 'unmerged branch commit\n')
    expect((await run(['add', '--', 'note.txt'], 'Stage unmerged branch fixture')).ok).toBe(true)
    expect((await run(['commit', '-m', 'feat: unmerged branch'], 'Commit unmerged branch fixture')).ok).toBe(true)
    expect((await run(['switch', 'main'], 'Return to main after unmerged fixture')).ok).toBe(true)
    const unmerged = await repository.prepareDeleteMergedBranch('feature/unmerged')
    expect(unmerged).toMatchObject({ ok: false, blocked: true, plan: null })
    expect(unmerged.reason).toContain('不会使用 -D')

    const reflog = await repository.reflog()
    expect(reflog.entries.length).toBeGreaterThan(0)
    const entry = reflog.entries[0]
    const rescueBranch = rescueBranchName(entry.occurredAt, entry.shortHash)
    const rescuePlan = await repository.prepareRescueBranch(entry.hash, rescueBranch)
    expect(rescuePlan.plan).toMatchObject({ argv: ['branch', rescueBranch, entry.hash], operationId: expect.any(String) })
    const rescue = await repository.executeRescueBranch(entry.hash, rescueBranch, rescuePlan.plan.operationId)
    expect(rescue.execution).toMatchObject({ ok: true, argv: ['git', 'branch', rescueBranch, entry.hash], operationId: rescuePlan.plan.operationId, source: 'user' })
    const rescueRef = await run(['rev-parse', rescueBranch], 'Read rescue branch target')
    expect(rescueRef.stdout.trim()).toBe(entry.hash)

    const ledger = commands.history()
    expect(ledger.some((record) => record.argv.join(' ') === 'git restore --worktree -- note.txt' && record.operationId === discardPlan.plan.operationId)).toBe(true)
    expect(ledger.some((record) => record.argv.join(' ') === 'git branch -d feature/merged' && record.operationId === deletePlan.plan.operationId)).toBe(true)
    expect(ledger.some((record) => record.argv.join(' ') === `git branch ${rescueBranch} ${entry.hash}` && record.operationId === rescuePlan.plan.operationId)).toBe(true)
    expect(ledger.some((record) => record.argv.includes('-D'))).toBe(false)
  }, 20_000)
})
