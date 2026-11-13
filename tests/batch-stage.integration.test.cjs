const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { GitCommandService } = require('../electron/git-command-service.cjs')
const { RepositoryService } = require('../electron/repository-service.cjs')

let cwd
afterEach(() => { if (cwd) fs.rmSync(cwd, { recursive: true, force: true }); cwd = null })

async function setup() {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-batch-stage-'))
  const commands = new GitCommandService()
  const run = (argv) => commands.run({ argv, intent: 'Fixture', source: 'background', cwd })
  for (const argv of [['init', '-b', 'main'], ['config', 'user.name', 'Batch Test'], ['config', 'user.email', 'batch@test.local']]) expect((await run(argv)).ok).toBe(true)
  fs.writeFileSync(path.join(cwd, 'base.txt'), 'base\n')
  fs.writeFileSync(path.join(cwd, 'keep.txt'), 'keep\n')
  expect((await run(['add', '--', 'base.txt', 'keep.txt'])).ok).toBe(true)
  expect((await run(['commit', '-m', 'chore: seed repository'])).ok).toBe(true)
  return { commands, repository: new RepositoryService(commands, () => cwd) }
}

function seedUnstaged(files) {
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(cwd, name), content)
}

describe('V0.5.3 batch stage integration (real Git)', () => {
  it('stages two selected files with a single git add -- fileA fileB command', async () => {
    const { commands, repository } = await setup()
    seedUnstaged({ 'a.txt': 'edit a\n', 'b.txt': 'edit b\n', 'c.txt': 'edit c\n' })
    const record = await repository.stageSelected(['a.txt', 'b.txt'])
    expect(record).toMatchObject({ ok: true, source: 'user', intent: 'Stage selected files' })
    expect(record.argv).toEqual(['git', 'add', '--', 'a.txt', 'b.txt'])
    // 一次批量暂存只产生一条 add 命令记录（夹具种子命令除外）。
    const addRecords = commands.history().filter((entry) => entry.argv[1] === 'add' && entry.intent !== 'Fixture')
    expect(addRecords).toHaveLength(1)
    expect(addRecords[0].argv).toEqual(['git', 'add', '--', 'a.txt', 'b.txt'])
    // 真实 Git 语义：a、b 已暂存，c 仍在未暂存区。
    const state = await repository.state()
    const areas = Object.fromEntries(state.files.map((file) => [file.path, file.area]))
    expect(areas['a.txt']).toBe('staged')
    expect(areas['b.txt']).toBe('staged')
    expect(areas['c.txt']).toBe('unstaged')
  }, 20_000)

  it('passes spaces, Chinese characters, and leading hyphens through argv verbatim', async () => {
    const { repository } = await setup()
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true })
    seedUnstaged({
      'src/app with space.js': 'space\n',
      '中文说明.txt': 'zh\n',
      '-leading-hyphen.txt': 'hyphen\n',
    })
    const record = await repository.stageSelected(['src/app with space.js', '中文说明.txt', '-leading-hyphen.txt'])
    expect(record.ok).toBe(true)
    // argv 逐项原样传递：-- 之后的内容不会被 Git 当作选项，也不会经过 shell 拼接。
    expect(record.argv).toEqual(['git', 'add', '--', 'src/app with space.js', '中文说明.txt', '-leading-hyphen.txt'])
    const state = await repository.state()
    expect(state.files.filter((file) => file.area === 'unstaged')).toHaveLength(0)
    expect(state.files.filter((file) => file.area === 'staged')).toHaveLength(3)
  }, 20_000)

  it('deduplicates repeats and rejects invalid input without running any git command', async () => {
    const { commands, repository } = await setup()
    seedUnstaged({ 'a.txt': 'edit a\n' })
    const before = commands.history().length
    const invalid = [
      null,
      'a.txt',
      [],
      [''],
      [42],
      ['ok.txt', 'bad\0path'],
    ]
    for (const input of invalid) {
      const record = await repository.stageSelected(input)
      expect(record).toMatchObject({ ok: false, source: 'user', intent: 'Stage selected files', exitCode: -1 })
      // 校验被拒时 argv 只有 ['git']：说明没有执行任何真实 Git 命令。
      expect(record.argv).toEqual(['git'])
      expect(typeof record.stderr).toBe('string')
      expect(record.stderr.length).toBeGreaterThan(0)
    }
    // 校验被拒不会执行任何 git add：账本中 add 记录数量保持不变。
    expect(commands.history().length).toBe(before)
    expect(commands.history().filter((entry) => entry.argv[1] === 'add').length).toBe(1)
    // 重复项被去重：只保留一个路径，命令仍会执行且只传一次。
    const deduped = await repository.stageSelected(['a.txt', 'a.txt'])
    expect(deduped.argv).toEqual(['git', 'add', '--', 'a.txt'])
    expect(deduped.ok).toBe(true)
  }, 20_000)

  it('caps the batch size and total path length with Chinese reasons and no command', async () => {
    const { commands, repository } = await setup()
    const before = commands.history().length
    const tooMany = Array.from({ length: 201 }, (_, index) => `file-${index}.txt`)
    const tooManyRecord = await repository.stageSelected(tooMany)
    expect(tooManyRecord.ok).toBe(false)
    expect(tooManyRecord.stderr).toContain('单次最多暂存 200 个文件')
    // 每个路径都不同（去重后仍超出总长度上限）。
    const tooLong = Array.from({ length: 30 }, (_, index) => `${'d'.repeat(400)}-${index}.txt`)
    const tooLongRecord = await repository.stageSelected(tooLong)
    expect(tooLongRecord.ok).toBe(false)
    expect(tooLongRecord.stderr).toContain('总长度过长')
    // 两次拒绝都没有执行任何真实命令：账本长度不变。
    expect(commands.history().length).toBe(before)
  }, 20_000)

  it('keeps real git add semantics for a file with both staged and unstaged changes', async () => {
    const { commands, repository } = await setup()
    const run = (argv) => commands.run({ argv, intent: 'Fixture', source: 'background', cwd })
    fs.writeFileSync(path.join(cwd, 'shared.txt'), 'line one\n')
    expect((await run(['add', '--', 'shared.txt'])).ok).toBe(true)
    fs.appendFileSync(path.join(cwd, 'shared.txt'), 'line two\n')
    const stateBefore = await repository.state()
    expect(stateBefore.files.filter((file) => file.path === 'shared.txt')).toHaveLength(2)
    const record = await repository.stageSelected(['shared.txt'])
    expect(record.ok).toBe(true)
    expect(record.argv).toEqual(['git', 'add', '--', 'shared.txt'])
    // git add 之后，工作区内容与暂存区一致：该文件只剩已暂存一项，未暂存项消失。
    const stateAfter = await repository.state()
    const entries = stateAfter.files.filter((file) => file.path === 'shared.txt')
    expect(entries).toHaveLength(1)
    expect(entries[0].area).toBe('staged')
  }, 20_000)

  it('refreshes state after a failed batch and keeps the real exit code and stderr in the ledger', async () => {
    const { commands, repository } = await setup()
    seedUnstaged({ 'a.txt': 'edit a\n' })
    // git add -- 不存在的路径会真实失败（pathspec 未匹配），退出码非 0。
    const failed = await repository.stageSelected(['a.txt', 'missing-file.txt'])
    expect(failed.ok).toBe(false)
    expect(failed.exitCode).not.toBe(0)
    expect(failed.stderr).toContain('pathspec')
    // 失败后仍然刷新工作区状态：a.txt 保留在未暂存区，界面可据此重新对齐选择。
    const state = await repository.state()
    expect(state.ok).toBe(true)
    const areas = Object.fromEntries(state.files.map((file) => [file.path, file.area]))
    expect(areas['a.txt']).toBe('unstaged')
    expect(areas['missing-file.txt']).toBeUndefined()
  }, 20_000)
})
