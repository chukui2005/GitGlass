const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { GitCommandService } = require('../electron/git-command-service.cjs')
const { RepositoryService, HISTORY_QUERY_LIMIT } = require('../electron/repository-service.cjs')

async function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-history-query-'))
  const commands = new GitCommandService()
  const run = (argv) => commands.run({ argv, intent: 'Fixture', source: 'background', cwd })
  await run(['init', '-b', 'main'])
  await run(['config', 'user.name', 'Ada'])
  await run(['config', 'user.email', 'ada@example.test'])
  fs.writeFileSync(path.join(cwd, 'alpha.txt'), 'one\n')
  await run(['add', '--', 'alpha.txt']); await run(['commit', '-m', 'fix: literal [needle] $(safe)'])
  await run(['config', 'user.name', 'Ben']); await run(['config', 'user.email', 'ben@example.test'])
  fs.writeFileSync(path.join(cwd, 'beta.txt'), 'two\n')
  await run(['add', '--', 'beta.txt']); await run(['commit', '-m', 'feat: beta history'])
  await run(['switch', '-c', 'topic/history'])
  fs.appendFileSync(path.join(cwd, 'alpha.txt'), 'topic\n')
  await run(['add', '--', 'alpha.txt']); await run(['commit', '-m', 'topic: author filter'])
  return { cwd, commands, repository: new RepositoryService(commands, () => cwd) }
}

describe('V0.5.6 real history query', () => {
  it('uses fixed argv for default, individual, and combined AND filters', async () => {
    const { commands, repository } = await fixture()
    const defaultResult = await repository.queryHistory({ keyword: '', author: '', branch: '', filePath: '' })
    expect(defaultResult.ok).toBe(true); expect(defaultResult.commits.length).toBeGreaterThan(0)
    expect(defaultResult.record.argv).toContain('-80')
    const keyword = await repository.queryHistory({ keyword: '[needle] $(safe)', author: '', branch: '', filePath: '' })
    expect(keyword.commits.map((commit) => commit.subject)).toContain('fix: literal [needle] $(safe)')
    expect(keyword.record.argv).toContain('--grep=[needle] $(safe)')
    const author = await repository.queryHistory({ keyword: '', author: 'ben@example.test', branch: '', filePath: '' })
    expect(author.commits.every((commit) => commit.authorEmail === 'ben@example.test')).toBe(true)
    const branch = await repository.queryHistory({ keyword: '', author: '', branch: 'main', filePath: '' })
    expect(branch.record.argv).toContain('refs/heads/main')
    const combined = await repository.queryHistory({ keyword: 'literal', author: 'Ada', branch: 'main', filePath: 'alpha.txt' })
    expect(combined.commits).toHaveLength(1)
    expect(combined.record.argv).toEqual(expect.arrayContaining(['--grep=literal', '--author=Ada', 'refs/heads/main', '--', 'alpha.txt']))
    expect(commands.history().filter((record) => record.intent !== 'Fixture').every((record) => record.source === 'background')).toBe(true)
  }, 20_000)

  it('rejects malformed fields, forged branches, and unsafe paths without executing git log', async () => {
    const { commands, repository } = await fixture()
    for (const filters of [
      { keyword: 'x\u0000y', author: '', branch: '', filePath: '' },
      { keyword: 'x'.repeat(161), author: '', branch: '', filePath: '' },
      { keyword: '', author: '', branch: 'forged', filePath: '' },
      { keyword: '', author: '', branch: '', filePath: '../secret' },
      { keyword: '', author: '', branch: '', filePath: 'missing.txt' },
      { keyword: '', author: '', branch: '', filePath: '', extra: 'nope' },
    ]) {
      const before = commands.history().filter((record) => record.intent === 'Query commit history').length
      const result = await repository.queryHistory(filters)
      expect(result.ok).toBe(false)
      expect(commands.history().filter((record) => record.intent === 'Query commit history')).toHaveLength(before)
    }
  }, 20_000)
})
