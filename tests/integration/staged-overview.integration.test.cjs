const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { GitCommandService } = require('../../electron/git-command-service.cjs')
const { RepositoryService } = require('../../electron/repository-service.cjs')

let cwd
afterEach(() => { if (cwd) fs.rmSync(cwd, { recursive: true, force: true }); cwd = null })

async function setup() {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-staged-overview-'))
  const commands = new GitCommandService()
  const run = (argv) => commands.run({ argv, intent: 'Fixture', source: 'background', cwd })
  for (const argv of [['init', '-b', 'main'], ['config', 'user.name', 'Staged Overview Test'], ['config', 'user.email', 'overview@test.local'], ['config', 'core.autocrlf', 'false']]) {
    expect((await run(argv)).ok, argv.join(' ')).toBe(true)
  }
  return { commands, run, repository: new RepositoryService(commands, () => cwd) }
}

const write = (name, content) => {
  const file = path.join(cwd, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

describe('v0.6.9 staged overview (real Git)', () => {
  it('reports the real staged files with per-file counts and totals', async () => {
    const { commands, run, repository } = await setup()
    write('app.js', 'one\ntwo\n')
    write('other.txt', 'unused\n')
    await run(['add', '--', 'app.js', 'other.txt'])
    await run(['commit', '-m', 'chore: seed repository'])

    // 只暂存 app.js 的两处改动，other.txt 保持未暂存。
    write('app.js', 'one\ntwo\nthree\nfour\n')
    write('other.txt', 'unstaged only\n')
    await run(['add', '--', 'app.js'])

    const overview = await repository.stagedOverview()
    expect(overview.ok).toBe(true)
    expect(overview.files).toEqual([
      { path: 'app.js', oldPath: null, status: 'modified', insertions: 2, deletions: 0, binary: false, statUnavailable: false },
    ])
    expect(overview.totals).toEqual({ files: 1, insertions: 2, deletions: 0, binary: 0, unavailable: 0 })
    // 数据来自真实命令，账本里能查到统计读取。
    expect(overview.record.argv).toEqual(['git', 'diff', '--cached', '--numstat', '-z'])
    expect(commands.history().some((record) => record.intent === 'Read staged overview')).toBe(true)
  }, 20_000)

  it('marks binary files and missing statistics instead of showing zero', async () => {
    const { run, repository } = await setup()
    write('bin.dat', Buffer.from([0, 1, 2]))
    await run(['add', '--', 'bin.dat'])
    await run(['commit', '-m', 'chore: seed binary'])
    write('bin.dat', Buffer.from([0, 9, 2]))
    await run(['add', '--', 'bin.dat'])

    // 二进制文件：numstat 两列都是 `-`。
    const binary = await repository.stagedOverview()
    expect(binary.files).toEqual([
      { path: 'bin.dat', oldPath: null, status: 'modified', insertions: null, deletions: null, binary: true, statUnavailable: false },
    ])
    expect(binary.totals).toMatchObject({ files: 1, binary: 1, unavailable: 0, insertions: 0, deletions: 0 })

    // 未跟踪文件在暂存前不属于暂存区；暂存后作为新文件出现并带统计。
    write('fresh.txt', 'new\n')
    await run(['add', '--', 'fresh.txt'])
    const withNew = await repository.stagedOverview()
    expect(withNew.files.map((file) => [file.path, file.status, file.insertions])).toEqual([
      ['bin.dat', 'modified', null],
      ['fresh.txt', 'added', 1],
    ])
    expect(withNew.totals).toMatchObject({ files: 2, binary: 1, insertions: 1 })
  }, 20_000)

  it('returns an empty overview for a clean index and a reason when the repository cannot be read', async () => {
    const { run, repository } = await setup()
    write('a.txt', 'a\n')
    await run(['add', '--', 'a.txt'])
    await run(['commit', '-m', 'chore: seed repository'])
    const clean = await repository.stagedOverview()
    expect(clean).toMatchObject({ ok: true, files: [], reason: '' })
    expect(clean.totals).toEqual({ files: 0, insertions: 0, deletions: 0, binary: 0, unavailable: 0 })
    // 干净索引不执行统计命令。
    expect(clean.record).toBeNull()

    const missing = new RepositoryService(new GitCommandService(), () => path.join(cwd, 'does-not-exist'))
    const failed = await missing.stagedOverview()
    expect(failed.ok).toBe(false)
    expect(failed.files).toEqual([])
    expect(failed.reason).toBe('无法读取工作区状态。请确认仓库仍可访问后刷新。')
  }, 20_000)

  it('never reports statistics for a file that is only unstaged', async () => {
    const { run, repository } = await setup()
    write('a.txt', 'a\n')
    await run(['add', '--', 'a.txt'])
    await run(['commit', '-m', 'chore: seed repository'])
    write('a.txt', 'a changed\n')
    const overview = await repository.stagedOverview()
    expect(overview.ok).toBe(true)
    expect(overview.files).toEqual([])
    expect(overview.totals.files).toBe(0)
  }, 20_000)
})
