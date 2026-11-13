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

// 批量暂存真正执行过的 git add 记录（排除夹具种子与本地校验拒绝记录）。
function executedStageAdds(commands) {
  return commands.history().filter((entry) => entry.argv[1] === 'add' && entry.intent !== 'Fixture' && !entry.rejected)
}

describe('V0.5.3 batch stage integration (real Git)', () => {
  it('stages two selected files with a single git add -- fileA fileB command', async () => {
    const { commands, repository } = await setup()
    seedUnstaged({ 'a.txt': 'edit a\n', 'b.txt': 'edit b\n', 'c.txt': 'edit c\n' })
    const record = await repository.stageSelected(['a.txt', 'b.txt'])
    expect(record).toMatchObject({ ok: true, source: 'user', intent: 'Stage selected files' })
    expect(record.argv).toEqual(['git', 'add', '--', 'a.txt', 'b.txt'])
    // 一次批量暂存只产生一条 add 命令记录。
    const adds = executedStageAdds(commands)
    expect(adds).toHaveLength(1)
    expect(adds[0].argv).toEqual(['git', 'add', '--', 'a.txt', 'b.txt'])
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

  it('deduplicates repeats and records syntax rejections as user operations without executing Git', async () => {
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
      expect(record).toMatchObject({ ok: false, rejected: true, source: 'user', intent: 'Stage selected files', exitCode: null })
      // 校验被拒：账本明确标注未执行 Git 命令，绝不伪装成已执行的命令。
      expect(record.displayCommand).toContain('本地校验拒绝，未执行 Git 命令')
      expect(typeof record.stderr).toBe('string')
      expect(record.stderr.length).toBeGreaterThan(0)
    }
    // 每次拒绝都如实进入命令账本，作为一条用户操作。
    expect(commands.history().length).toBe(before + invalid.length)
    // 没有任何 git add 被执行：可执行 add 记录仍只有夹具种子那一条。
    expect(executedStageAdds(commands)).toHaveLength(0)
    // 重复项被去重：只保留一个路径，命令仍会执行且只传一次。
    const deduped = await repository.stageSelected(['a.txt', 'a.txt'])
    expect(deduped.argv).toEqual(['git', 'add', '--', 'a.txt'])
    expect(deduped.ok).toBe(true)
    expect(executedStageAdds(commands)).toHaveLength(1)
  }, 20_000)

  it('caps the batch size and total path length with Chinese reasons and no command', async () => {
    const { commands, repository } = await setup()
    const before = commands.history().length
    const tooMany = Array.from({ length: 201 }, (_, index) => `file-${index}.txt`)
    const tooManyRecord = await repository.stageSelected(tooMany)
    expect(tooManyRecord).toMatchObject({ ok: false, rejected: true, exitCode: null })
    expect(tooManyRecord.stderr).toContain('单次最多暂存 200 个文件')
    // 每个路径都不同（去重后仍超出总长度上限）。
    const tooLong = Array.from({ length: 30 }, (_, index) => `${'d'.repeat(400)}-${index}.txt`)
    const tooLongRecord = await repository.stageSelected(tooLong)
    expect(tooLongRecord).toMatchObject({ ok: false, rejected: true, exitCode: null })
    expect(tooLongRecord.stderr).toContain('总长度过长')
    // 两次拒绝都进入账本且未执行任何真实命令。
    expect(commands.history().length).toBe(before + 2)
    expect(executedStageAdds(commands)).toHaveLength(0)
  }, 20_000)

  it('rejects ".", "..", absolute, staged-only, stale, and unselected paths against the unstaged whitelist', async () => {
    const { commands, repository } = await setup()
    // staged-only.txt：先暂存，制造“仅已暂存”路径。
    fs.writeFileSync(path.join(cwd, 'staged-only.txt'), 'staged\n')
    const run = (argv) => commands.run({ argv, intent: 'Fixture', source: 'background', cwd })
    expect((await run(['add', '--', 'staged-only.txt'])).ok).toBe(true)
    seedUnstaged({ 'a.txt': 'edit a\n' })
    const rejections = [
      ['.'],
      ['..'],
      ['a.txt', '.'],
      ['../outside.txt'],
      ['src/../../escape.txt'],
      [path.resolve(cwd, 'a.txt')],
      ['staged-only.txt'],
      ['ghost-deleted.txt'],
      ['a.txt', 'ghost-deleted.txt'],
      ['keep.txt'],
    ]
    for (const input of rejections) {
      const record = await repository.stageSelected(input)
      expect(record, JSON.stringify(input)).toMatchObject({ ok: false, rejected: true, exitCode: null })
      expect(record.displayCommand, JSON.stringify(input)).toContain('本地校验拒绝，未执行 Git 命令')
      // 目录、路径穿越、绝对路径、已暂存、过期与未选中路径统一给出中文原因。
      expect(record.stderr).toContain('所选文件已不在未暂存区，请刷新后重试。')
      expect(record.argv.slice(0, 3)).toEqual(['git', 'add', '--'])
    }
    // 每次整批拒绝都如实进入命令账本（state() 的后台读取不计入拒绝数）。
    expect(commands.history().filter((entry) => entry.rejected && entry.intent === 'Stage selected files').length).toBe(rejections.length)
    // 绝不出现 git add -- . 或任何批量 add 执行。
    expect(executedStageAdds(commands)).toHaveLength(0)
    const state = await repository.state()
    const areas = Object.fromEntries(state.files.map((file) => [file.path, file.area]))
    expect(areas['a.txt']).toBe('unstaged')
    expect(areas['staged-only.txt']).toBe('staged')
    // 合法路径在拒绝之后仍可正常整批暂存：白名单不是永久阻断。
    const valid = await repository.stageSelected(['a.txt'])
    expect(valid.ok).toBe(true)
    expect(valid.argv).toEqual(['git', 'add', '--', 'a.txt'])
    expect(executedStageAdds(commands)).toHaveLength(1)
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

  it('refreshes state after a real git failure and keeps the exit code and stderr in the ledger', async () => {
    const { commands, repository } = await setup()
    seedUnstaged({ 'a.txt': 'edit a\n', 'b.txt': 'edit b\n' })
    // 两个路径都通过白名单，但用真实的 index.lock 让 git add 失败。
    fs.writeFileSync(path.join(cwd, '.git', 'index.lock'), '')
    const failed = await repository.stageSelected(['a.txt', 'b.txt'])
    expect(failed.ok).toBe(false)
    // 不是本地校验拒绝：是一次真实执行的 Git 命令失败。
    expect(failed.rejected).toBeFalsy()
    expect(failed.argv).toEqual(['git', 'add', '--', 'a.txt', 'b.txt'])
    expect(failed.exitCode).not.toBe(0)
    expect(failed.stderr).toContain('index.lock')
    fs.rmSync(path.join(cwd, '.git', 'index.lock'))
    // 失败后仍然刷新工作区状态：文件保留在未暂存区，界面可据此重新对齐选择。
    const state = await repository.state()
    expect(state.ok).toBe(true)
    const areas = Object.fromEntries(state.files.map((file) => [file.path, file.area]))
    expect(areas['a.txt']).toBe('unstaged')
    expect(areas['b.txt']).toBe('unstaged')
    expect(executedStageAdds(commands)).toHaveLength(1)
  }, 20_000)
})
