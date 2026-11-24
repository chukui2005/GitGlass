const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { GitCommandService } = require('../../electron/git-command-service.cjs')
const { RepositoryService } = require('../../electron/repository-service.cjs')
const { displayGitCommand } = require('../../electron/command-display.mjs')

// 用**真实 Git** 复现路径引号问题：中文文件名在 patch 头里会被写成八进制转义，
// 空格属于文件名的一部分，仓库里真实存在的 a/ 目录不能被当成协议前缀。
// 展示层（src/diff-presentation.js 是 ESM）在用例里动态导入，与渲染层用同一份实现。
const NAMES = ['配置.md', 'guide for project.md', 'new note.md', 'new  note.md', 'a/real-a.md']

const temporaryRepositories = []
let presentDiff

beforeAll(async () => {
  ;({ presentDiff } = await import('../../src/diff-presentation.js'))
})

afterEach(() => {
  while (temporaryRepositories.length) fs.rmSync(temporaryRepositories.pop(), { recursive: true, force: true })
})

async function createRepository() {
  const commands = new GitCommandService()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-paths-'))
  temporaryRepositories.push(cwd)
  const run = (argv, intent) => commands.run({ argv, intent, source: 'background', cwd })
  expect((await run(['init', '-b', 'main'], 'Initialize test repository')).ok).toBe(true)
  expect((await run(['config', 'user.name', 'GitGlass Integration'], 'Configure test author')).ok).toBe(true)
  expect((await run(['config', 'user.email', 'integration@gitglass.local'], 'Configure test email')).ok).toBe(true)
  // 固定成 Git 的默认行为，避免本机全局配置里 core.quotePath=false 让用例失效。
  expect((await run(['config', 'core.quotePath', 'true'], 'Pin quotePath')).ok).toBe(true)
  for (const name of NAMES) {
    const target = path.join(cwd, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'base\n')
  }
  expect((await run(['add', '-A'], 'Seed test files')).ok).toBe(true)
  expect((await run(['commit', '-m', 'chore: seed paths'], 'Seed test repository')).ok).toBe(true)
  // 全部改成「已修改」，状态里就是 5 个未暂存文件。
  for (const name of NAMES) fs.appendFileSync(path.join(cwd, name), 'edited\n')
  return { commands, cwd, repository: new RepositoryService(commands, () => cwd) }
}

const stagedPaths = (state) => state.files.filter((file) => file.area === 'staged').map((file) => file.path).sort()

describe('真实 Git 的路径引号与空白（integration）', () => {
  it('keeps every path verbatim in the worktree state', async () => {
    const { repository } = await createRepository()
    const state = await repository.state()
    const unstaged = state.files.filter((file) => file.area === 'unstaged').map((file) => file.path).sort()
    expect(unstaged).toEqual([...NAMES].sort())
  }, 30_000)

  it('decodes the octal-quoted patch header of a Chinese file into the real repository path', async () => {
    const { repository } = await createRepository()
    const chinese = await repository.diff({ path: '配置.md', area: 'unstaged' })
    expect(chinese.ok).toBe(true)
    // 前提：Git 真的用了 C 风格引号 + 八进制转义（否则这条用例就没有复现到问题）。
    expect(chinese.stdout).toMatch(/diff --git "a\/\\351/)

    const rows = presentDiff(chinese.stdout)
    expect(rows.filter((row) => row.type === 'file')).toHaveLength(1)
    expect(rows[0].content).toBe('配置.md')
    // 标题与文件头指向同一路径：工作区单文件视图只剩一条标题。
    expect(presentDiff(chinese.stdout, { dropFileHeaderFor: '配置.md' }).some((row) => row.type === 'file')).toBe(false)
  }, 30_000)

  it('treats spaces as part of the name and strips the a/ b/ prefix only once', async () => {
    const { repository } = await createRepository()

    const spaced = await repository.diff({ path: 'guide for project.md', area: 'unstaged' })
    expect(spaced.stdout).toContain('diff --git a/guide for project.md b/guide for project.md')
    expect(presentDiff(spaced.stdout)[0]).toMatchObject({ type: 'file', content: 'guide for project.md' })
    expect(presentDiff(spaced.stdout, { dropFileHeaderFor: 'guide for project.md' }).some((row) => row.type === 'file')).toBe(false)

    // 只差一个空格的两个文件各有自己的文件头，不会互相去重。
    const doubleSpaced = await repository.diff({ path: 'new  note.md', area: 'unstaged' })
    expect(presentDiff(doubleSpaced.stdout)[0]).toMatchObject({ type: 'file', content: 'new  note.md' })
    expect(presentDiff(doubleSpaced.stdout, { dropFileHeaderFor: 'new note.md' }).some((row) => row.type === 'file')).toBe(true)

    // 真实存在的 a/ 目录：协议前缀只剥一层，路径仍是 a/real-a.md。
    const underA = await repository.diff({ path: 'a/real-a.md', area: 'unstaged' })
    expect(underA.stdout).toContain('--- a/a/real-a.md')
    expect(presentDiff(underA.stdout)[0]).toMatchObject({ type: 'file', content: 'a/real-a.md' })
    expect(presentDiff(underA.stdout, { dropFileHeaderFor: 'a/real-a.md' }).some((row) => row.type === 'file')).toBe(false)
    expect(presentDiff(underA.stdout, { dropFileHeaderFor: 'real-a.md' }).some((row) => row.type === 'file')).toBe(true)
  }, 30_000)

  it('stages only the clicked path and records the same quoted command the preview shows', async () => {
    const { commands, repository } = await createRepository()

    const first = await repository.stage('guide for project.md')
    expect(first).toMatchObject({ ok: true, argv: ['git', 'add', '--', 'guide for project.md'] })
    // 展示命令与预览用的是同一套格式化规则：含空格的参数加引号。
    expect(first.displayCommand).toBe('git add -- "guide for project.md"')
    expect(first.displayCommand).toBe(displayGitCommand(['add', '--', 'guide for project.md']))
    // 只命中这一个文件：另一个只差空格的同族文件仍在未暂存区。
    let state = await repository.state()
    expect(stagedPaths(state)).toEqual(['guide for project.md'])

    const second = await repository.stage('new  note.md')
    expect(second.argv).toEqual(['git', 'add', '--', 'new  note.md'])
    expect(second.displayCommand).toBe('git add -- "new  note.md"')
    state = await repository.state()
    expect(stagedPaths(state)).toEqual(['guide for project.md', 'new  note.md'])
    // 单空格的那个文件没有被一起暂存。
    expect(state.files.some((file) => file.path === 'new note.md' && file.area === 'unstaged')).toBe(true)

    // 账本里记录的就是真实执行的那条命令（账本按时间倒序，用 argv 精确找回那一条）。
    const ledger = commands.history()
    const stagedRecord = ledger.filter((record) => record.argv.join(' ') === 'git add -- new  note.md')
    expect(stagedRecord).toHaveLength(1)
    expect(stagedRecord[0]).toMatchObject({ source: 'user', displayCommand: 'git add -- "new  note.md"' })
    expect(ledger.some((record) => record.argv.join(' ') === 'git add -- guide for project.md')).toBe(true)
  }, 30_000)
})
