const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { GitCommandService } = require('../../electron/git-command-service.cjs')
const { RepositoryService } = require('../../electron/repository-service.cjs')

let cwd
afterEach(() => { if (cwd) fs.rmSync(cwd, { recursive: true, force: true }); cwd = null })

async function repositoryWithCommit() {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-operation-state-'))
  const commands = new GitCommandService()
  const run = (argv) => commands.run({ argv, intent: 'Fixture', source: 'background', cwd })
  for (const argv of [['init', '-b', 'main'], ['config', 'user.name', 'Operation Test'], ['config', 'user.email', 'operation@test.local']]) {
    expect((await run(argv)).ok).toBe(true)
  }
  fs.writeFileSync(path.join(cwd, 'seed.txt'), 'seed\n')
  expect((await run(['add', '--', 'seed.txt'])).ok).toBe(true)
  expect((await run(['commit', '-m', 'chore: seed'])).ok).toBe(true)
  return new RepositoryService(commands, () => cwd)
}

describe('in-progress repository operations (real Git)', () => {
  it('reports no operation for a normal repository', async () => {
    const repository = await repositoryWithCommit()
    expect((await repository.state()).operation).toBeNull()
  })

  it('detects a merge in progress from MERGE_HEAD', async () => {
    const repository = await repositoryWithCommit()
    const mergeHead = path.join(cwd, '.git', 'MERGE_HEAD')
    fs.writeFileSync(mergeHead, '0'.repeat(40) + '\n')
    expect((await repository.state()).operation).toBe('merge')
    fs.rmSync(mergeHead)
    expect((await repository.state()).operation).toBeNull()
  })

  it('detects rebase, cherry-pick and revert markers', async () => {
    const repository = await repositoryWithCommit()
    const gitDir = path.join(cwd, '.git')
    const cases = [['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']]
    for (const [marker, expected] of cases) {
      const target = path.join(gitDir, marker)
      if (marker.startsWith('rebase')) fs.mkdirSync(target)
      else fs.writeFileSync(target, '0'.repeat(40))
      expect((await repository.state()).operation).toBe(expected)
      fs.rmSync(target, { recursive: true, force: true })
    }
  })
})
