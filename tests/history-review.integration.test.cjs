const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { GitCommandService } = require('../electron/git-command-service.cjs')
const { RepositoryService } = require('../electron/repository-service.cjs')

let cwd
afterEach(() => { if (cwd) fs.rmSync(cwd, { recursive: true, force: true }); cwd = null })

async function setup() {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-history-'))
  const commands = new GitCommandService()
  const run = (argv) => commands.run({ argv, intent: 'Fixture', source: 'background', cwd })
  for (const argv of [['init', '-b', 'main'], ['config', 'user.name', 'History Test'], ['config', 'user.email', 'history@test.local']]) expect((await run(argv)).ok).toBe(true)
  fs.writeFileSync(path.join(cwd, 'before.txt'), 'one\n')
  expect((await run(['add', '--', 'before.txt'])).ok).toBe(true); expect((await run(['commit', '-m', 'feat: first history commit'])).ok).toBe(true)
  fs.appendFileSync(path.join(cwd, 'before.txt'), 'two\n')
  expect((await run(['add', '--', 'before.txt'])).ok).toBe(true); expect((await run(['commit', '-m', 'feat: amend tracked file'])).ok).toBe(true)
  expect((await run(['mv', 'before.txt', 'very-long-renamed-history-file.txt'])).ok).toBe(true)
  expect((await run(['commit', '-m', 'refactor: rename history file'])).ok).toBe(true)
  return { commands, repository: new RepositoryService(commands, () => cwd) }
}

describe('real history and review integration', () => {
  it('reads commits, commit details, comparisons, and followed file history as background records', async () => {
    const { commands, repository } = await setup()
    const history = await repository.commits()
    expect(history.commits).toHaveLength(3)
    expect(history.commits[0]).toMatchObject({ hash: expect.stringMatching(/^[0-9a-f]{40}$/), parents: [expect.any(String)], subject: 'refactor: rename history file' })
    const detail = await repository.commitDetail(history.commits[0].hash)
    expect(detail.ok).toBe(true); expect(detail.detail.argv).toEqual(['git', 'show', '--no-ext-diff', '--format=fuller', '--stat', '--find-renames', history.commits[0].hash])
    expect(detail.changedFiles.some((file) => file.path === 'very-long-renamed-history-file.txt')).toBe(true)
    const diff = await repository.commitDiff(history.commits[0].hash)
    expect(diff.record.argv).toEqual(['git', 'show', '--no-ext-diff', '--format=', '--find-renames', history.commits[0].hash])
    const comparison = await repository.compareCommits(history.commits[2].hash, history.commits[0].hash)
    expect(comparison.record.argv).toEqual(['git', 'diff', '--no-ext-diff', '--find-renames', history.commits[2].hash, history.commits[0].hash])
    const fileHistory = await repository.fileHistory('very-long-renamed-history-file.txt')
    expect(fileHistory.entries.length).toBeGreaterThanOrEqual(2)
    expect(fileHistory.record.argv).toEqual(['git', 'log', '-50', '--follow', '--date=iso-strict', '--pretty=format:%H%x1f%h%x1f%P%x1f%s%x1f%an%x1f%aI%x1f%D', '--', 'very-long-renamed-history-file.txt'])
    const fileDiff = await repository.fileCommitDiff(history.commits[0].hash, 'very-long-renamed-history-file.txt')
    expect(fileDiff.record.argv).toEqual(['git', 'show', '--no-ext-diff', '--format=', history.commits[0].hash, '--', 'very-long-renamed-history-file.txt'])
    expect((await repository.commitDiff('not-a-sha')).ok).toBe(false)
    expect((await repository.fileHistory('missing.txt')).ok).toBe(false)
    expect(commands.history().filter((record) => record.intent !== 'Fixture').every((record) => record.source === 'background')).toBe(true)
  }, 20_000)
})

  it('caps large diff collection without changing the Git command', async () => {
    const { repository } = await setup()
    fs.writeFileSync(path.join(cwd, 'large.txt'), `${'x'.repeat(220)}\n`.repeat(5_000))
    const commands = repository.commands
    const run = (argv) => commands.run({ argv, intent: 'Fixture', source: 'background', cwd })
    await run(['add', '--', 'large.txt']); await run(['commit', '-m', 'test: large diff'])
    const history = await repository.commits()
    const result = await repository.commitDiff(history.commits[0].hash)
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.diff)).toBeLessThanOrEqual(1024 * 1024)
  }, 20_000)
