const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { GitCommandService } = require('../../electron/git-command-service.cjs')
const { RepositoryService } = require('../../electron/repository-service.cjs')
const { openRepositoryPath } = require('../../electron/repository-opener.cjs')
const { prepareClone, executeClone, REASON } = require('../../electron/repository-cloner.cjs')

// The protocol pin every plan carries: only the transport the address was classified as.
const FILE_PROTOCOL = ['-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always']
const HTTPS_PROTOCOL = ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always']

// v0.6.10 PR 1「克隆并打开」的真实 Git 验收。所有断言都以实际磁盘与 Git 输出为准：
// 每个用例都在临时目录里建真实的 bare 远程，克隆后核对 HEAD、origin、工作区文件与
// 命令账本记录；失败用例核对「没有执行命令」「目标目录原样保留」。
let workspace
afterEach(async () => {
  if (workspace) fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  workspace = null
})

function tempWorkspace() {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-clone-'))
  return workspace
}

const gitIn = async (cwd, argv) => {
  const commands = new GitCommandService()
  const record = await commands.run({ argv, intent: 'Fixture', source: 'background', cwd })
  expect(record.ok, `${argv.join(' ')}: ${record.stderr}`).toBe(true)
  return record.stdout.trim()
}

// A real bare remote holding one commit and one file.
async function createBareOrigin() {
  const seed = path.join(workspace, 'seed')
  fs.mkdirSync(seed)
  await gitIn(seed, ['init', '-b', 'main'])
  await gitIn(seed, ['config', 'user.name', 'Clone Fixture'])
  await gitIn(seed, ['config', 'user.email', 'clone@test.local'])
  fs.writeFileSync(path.join(seed, 'readme.txt'), 'first line\n')
  await gitIn(seed, ['add', '-A'])
  await gitIn(seed, ['commit', '-m', 'chore: seed origin'])
  const bare = path.join(workspace, 'origin.git')
  await gitIn(workspace, ['clone', '--bare', seed, bare])
  return { bare, seed, head: await gitIn(seed, ['rev-parse', 'HEAD']) }
}

async function cloneAndOpen({ source, parent, name }) {
  const commands = new GitCommandService()
  const cloned = await executeClone({ source, parent, name, commandService: commands })
  if (!cloned.ok) return { commands, cloned }
  const current = { root: null }
  const remembered = []
  const repository = new RepositoryService(commands, () => current.root)
  const opened = await openRepositoryPath({
    candidate: cloned.target,
    commandService: commands,
    repository,
    remember: (root) => remembered.push(root),
    setRepositoryPath: (root) => { current.root = root },
  })
  return { commands, cloned, opened, remembered, repository }
}

describe('v0.6.10 clone and open (real Git)', () => {
  it('clones a real remote into a new folder, opens the real worktree root and remembers it', async () => {
    tempWorkspace()
    const { bare, head } = await createBareOrigin()

    const { commands, cloned, opened, remembered } = await cloneAndOpen({ source: bare, parent: workspace, name: 'cloned' })
    expect(cloned.ok, cloned.reason).toBe(true)
    expect(cloned.target).toBe(path.join(workspace, 'cloned'))
    expect(fs.readFileSync(path.join(cloned.target, 'readme.txt'), 'utf8').trim()).toBe('first line')

    // 真实 Git 结果：HEAD 与 origin 都来自刚克隆下来的仓库，而不是界面自己拼的。
    expect(await gitIn(cloned.target, ['rev-parse', 'HEAD'])).toBe(head)
    expect(await gitIn(cloned.target, ['remote', 'get-url', 'origin'])).toBe(bare)

    // 打开流程仍然以 rev-parse 的真实根目录为准，并把解析后的根目录写进最近仓库。
    expect(opened.ok).toBe(true)
    expect(opened.path).toBe(cloned.target)
    expect(opened.state.branch).toBe('main')
    expect(remembered).toEqual([cloned.target])

    // 账本：一条用户操作记录，argv 就是真实执行的参数，cwd 是用户选择的父目录。
    const ledger = commands.history()
    const cloneRecord = ledger.find((record) => record.intent === 'Clone repository')
    expect(cloneRecord).toBeDefined()
    expect(cloneRecord.source).toBe('user')
    expect(cloneRecord.ok).toBe(true)
    expect(cloneRecord.argv).toEqual(['git', ...FILE_PROTOCOL, 'clone', '--', bare, 'cloned'])
    expect(cloneRecord.cwd).toBe(workspace)
    expect(cloneRecord.displayCommand).toContain('clone')
  })

  it('clones into an existing empty folder and into a folder whose name has CJK characters and spaces', async () => {
    tempWorkspace()
    const { bare, head } = await createBareOrigin()
    // 中文目录 + 空格：Git 收到的是独立参数，实际路径与工作台标题一致。
    fs.mkdirSync(path.join(workspace, '已有 空目录'))

    const existing = await cloneAndOpen({ source: bare, parent: workspace, name: '已有 空目录' })
    expect(existing.cloned.ok, existing.cloned.reason).toBe(true)
    expect(existing.cloned.plan.argv).toEqual([...FILE_PROTOCOL, 'clone', '--', bare, '已有 空目录'])
    expect(await gitIn(existing.cloned.target, ['rev-parse', 'HEAD'])).toBe(head)
    expect(existing.opened.path).toBe(path.join(workspace, '已有 空目录'))

    const withCjk = await cloneAndOpen({ source: bare, parent: workspace, name: '中文 仓库' })
    expect(withCjk.cloned.ok, withCjk.cloned.reason).toBe(true)
    expect(fs.existsSync(path.join(withCjk.cloned.target, '.git'))).toBe(true)
    expect(withCjk.opened.path).toBe(path.join(workspace, '中文 仓库'))
  })

  it('uses the repository name from the address when the name is left empty', async () => {
    tempWorkspace()
    const { bare } = await createBareOrigin()
    const commands = new GitCommandService()
    const prepared = prepareClone({ source: bare, parent: workspace, name: '', commandService: commands })
    expect(prepared.ok).toBe(true)
    // `origin.git` → `origin`：与 Git 自己的默认目录同名。
    expect(prepared.name).toBe('origin')
    expect(prepared.target).toBe(path.join(workspace, 'origin'))
  })

  it('strips a URL fragment before Git and the ledger, and keeps a # inside a local path', async () => {
    tempWorkspace()
    const { bare, head } = await createBareOrigin()
    const parent = path.join(workspace, 'fragments')
    fs.mkdirSync(parent)
    const url = `file:///${bare.replace(/\\/g, '/')}`

    const commands = new GitCommandService()
    const prepared = prepareClone({ source: `${url}#ignored-fragment`, parent, name: 'from-url', commandService: commands })
    expect(prepared.ok).toBe(true)
    // Preview and argv carry the same fragment-free address.
    expect(prepared.plan.argv[prepared.plan.argv.length - 2]).toBe(url)
    expect(prepared.plan.displayCommand).not.toContain('#')
    expect(prepared.plan.displayCommand).toContain(url)

    const result = await executeClone({ source: `${url}#ignored-fragment`, parent, name: 'from-url', commandService: commands })
    expect(result.ok, result.reason).toBe(true)
    expect(await gitIn(path.join(parent, 'from-url'), ['rev-parse', 'HEAD'])).toBe(head)
    const record = commands.history().find((entry) => entry.intent === 'Clone repository')
    expect(record.argv.join(' ')).not.toContain('#')
    expect(record.displayCommand).not.toContain('#')
    expect(record.argv[record.argv.length - 2]).toBe(url)

    // '#' is an ordinary filename character in a local path: it must survive untouched.
    const hashed = path.join(workspace, 'hash#origin.git')
    await gitIn(workspace, ['clone', '--bare', bare, hashed])
    const local = await executeClone({ source: hashed, parent, name: 'from-path', commandService: new GitCommandService() })
    expect(local.ok, local.reason).toBe(true)
    expect(await gitIn(path.join(parent, 'from-path'), ['rev-parse', 'HEAD'])).toBe(head)
    expect(local.plan.argv[local.plan.argv.length - 2]).toBe(hashed)
  })

  it('refuses a non-empty target without running any Git command and leaves the folder intact', async () => {
    tempWorkspace()
    const { bare } = await createBareOrigin()
    const target = path.join(workspace, 'busy')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'keep.txt'), 'user data\n')

    const commands = new GitCommandService()
    const result = await executeClone({ source: bare, parent: workspace, name: 'busy', commandService: commands })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe(REASON.targetNotEmpty)
    expect(result.execution).toBeNull()
    expect(commands.history()).toHaveLength(0)
    expect(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8')).toBe('user data\n')
    expect(fs.existsSync(path.join(target, '.git'))).toBe(false)
  })

  it('intercepts addresses with embedded credentials before the command and the ledger', async () => {
    tempWorkspace()
    const commands = new GitCommandService()
    const result = await executeClone({ source: 'https://user:token@example.com/owner/repo.git', parent: workspace, name: 'leaky', commandService: commands })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe(REASON.embeddedCredential)
    // 既没有执行，也没有任何记录可以泄漏那段凭据。
    expect(commands.history()).toHaveLength(0)
    expect(fs.existsSync(path.join(workspace, 'leaky'))).toBe(false)
  })

  it('pins the clone to the validated transport: an insteadOf rewrite onto the file protocol is refused', async () => {
    tempWorkspace()
    const { bare, head } = await createBareOrigin()
    const parent = path.join(workspace, 'relocated')
    fs.mkdirSync(parent)
    // A real local mirror behind a rewritten HTTPS prefix: without the protocol pin the
    // rewrite would silently move a validated HTTPS address onto the file transport.
    const mirror = path.join(workspace, 'mirror')
    fs.mkdirSync(mirror)
    await gitIn(workspace, ['clone', '--bare', bare, path.join(mirror, 'repo.git')])
    // The user's own configuration explicitly allows the file transport — exactly the
    // case the `-c` flags alone cannot cover, because a per-protocol allow wins over
    // `protocol.allow=never`. GIT_ALLOW_PROTOCOL is the whitelist that overrides both.
    const configFile = path.join(workspace, 'gitconfig')
    fs.writeFileSync(
      configFile,
      `[protocol "file"]\n\tallow = always\n[url "file:///${mirror.replace(/\\/g, '/')}/"]\n\tinsteadOf = https://rewrite.invalid/\n`,
    )

    const previousGlobal = process.env.GIT_CONFIG_GLOBAL
    const previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM
    process.env.GIT_CONFIG_GLOBAL = configFile
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    try {
      // Control: with the user's config and no pin, the rewrite is live (the clone
      // succeeds from the local mirror). This keeps the assertion below honest.
      const control = new GitCommandService()
      const rewritten = await control.run({ argv: ['clone', '--', 'https://rewrite.invalid/repo.git', 'control'], intent: 'Fixture', source: 'background', cwd: parent, timeoutMs: 60_000 })
      expect(rewritten.ok, `insteadOf 改写没有生效，本用例会失去意义：${rewritten.stderr}`).toBe(true)
      expect(await gitIn(path.join(parent, 'control'), ['rev-parse', 'HEAD'])).toBe(head)

      const commands = new GitCommandService()
      const prepared = prepareClone({ source: 'https://rewrite.invalid/repo.git', parent, name: 'pinned', commandService: commands })
      expect(prepared.ok).toBe(true)
      expect(prepared.plan.argv).toEqual([...HTTPS_PROTOCOL, 'clone', '--', 'https://rewrite.invalid/repo.git', 'pinned'])

      // Control 2: with the user's `protocol.file.allow=always`, the `-c` flags alone
      // are not enough — the child-process allow-list is what refuses the rewrite.
      const pinnedOnly = await new GitCommandService().run({
        argv: [...HTTPS_PROTOCOL, 'clone', '--', 'https://rewrite.invalid/repo.git', 'pinned-only'],
        intent: 'Fixture',
        source: 'background',
        cwd: parent,
        timeoutMs: 60_000,
      })
      expect(pinnedOnly.ok, '用户配置显式允许 file 时，单靠 -c 固定挡不住 insteadOf 改写').toBe(true)
      expect(await gitIn(path.join(parent, 'pinned-only'), ['rev-parse', 'HEAD'])).toBe(head)

      const result = await executeClone({ source: 'https://rewrite.invalid/repo.git', parent, name: 'pinned', commandService: commands })
      expect(result.ok).toBe(false)
      expect(result.execution.stderr).toMatch(/transport 'file' not allowed/i)
      expect(result.reason).toContain('传输协议')
      // Nothing was created from the local mirror.
      expect(fs.existsSync(path.join(parent, 'pinned', '.git'))).toBe(false)

      // The absolute local path stays a supported source under the same isolated config.
      const local = await executeClone({ source: bare, parent, name: 'local-copy', commandService: new GitCommandService() })
      expect(local.ok, local.reason).toBe(true)
      expect(await gitIn(path.join(parent, 'local-copy'), ['rev-parse', 'HEAD'])).toBe(head)
      expect(await gitIn(path.join(parent, 'local-copy'), ['remote', 'get-url', 'origin'])).toBe(bare)
    } finally {
      if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = previousGlobal
      if (previousNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
      else process.env.GIT_CONFIG_NOSYSTEM = previousNoSystem
    }
  })

  it('records a real Git failure and keeps the user folders exactly as they were', async () => {
    tempWorkspace()
    const parent = path.join(workspace, 'targets')
    fs.mkdirSync(parent)
    fs.mkdirSync(path.join(parent, 'existing'))
    fs.writeFileSync(path.join(parent, 'existing', 'keep.txt'), 'keep me\n')
    // 一个真实存在但尚未初始化的地址：Git 会自己失败，界面必须返回真实原因。
    const missing = path.join(workspace, 'missing-origin.git')

    const commands = new GitCommandService()
    const prepared = prepareClone({ source: missing, parent, name: 'denied', commandService: commands })
    expect(prepared.ok).toBe(true)
    const result = await executeClone({ source: missing, parent, name: 'denied', commandService: commands })

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('远程仓库不存在')
    // 真实失败仍在账本里：退出码与 stderr 都保留，界面据此恢复可操作状态。
    const record = commands.history().find((entry) => entry.intent === 'Clone repository')
    expect(record.ok).toBe(false)
    expect(record.exitCode).not.toBe(0)
    expect(record.stderr.length).toBeGreaterThan(0)
    // 用户原有的文件夹与其中内容原样保留；失败的目标里没有留下可用仓库。
    expect(fs.readFileSync(path.join(parent, 'existing', 'keep.txt'), 'utf8')).toBe('keep me\n')
    expect(fs.existsSync(path.join(parent, 'denied', '.git'))).toBe(false)
  })

  it('keeps the currently open repository untouched when a clone fails', async () => {
    tempWorkspace()
    const { bare, seed } = await createBareOrigin()
    const commands = new GitCommandService()
    const current = { root: null }
    const repository = new RepositoryService(commands, () => current.root)
    const opened = await openRepositoryPath({
      candidate: seed,
      commandService: commands,
      repository,
      remember: () => {},
      setRepositoryPath: (root) => { current.root = root },
    })
    expect(opened.ok).toBe(true)
    fs.writeFileSync(path.join(current.root, 'scratch.txt'), 'draft\n')
    const before = await gitIn(current.root, ['status', '--porcelain=v1'])

    // 目标目录非空 → 克隆在本地即被拒绝；已打开的仓库不能因此变化。
    fs.mkdirSync(path.join(workspace, 'busy'))
    fs.writeFileSync(path.join(workspace, 'busy', 'keep.txt'), 'x')
    const failed = await executeClone({ source: bare, parent: workspace, name: 'busy', commandService: commands })
    expect(failed.ok).toBe(false)

    expect(current.root).toBe(opened.path)
    expect(await gitIn(current.root, ['status', '--porcelain=v1'])).toBe(before)
    expect(fs.readFileSync(path.join(current.root, 'scratch.txt'), 'utf8')).toBe('draft\n')
  })
})
