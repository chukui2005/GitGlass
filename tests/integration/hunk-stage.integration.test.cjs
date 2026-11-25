const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { GitCommandService } = require('../../electron/git-command-service.cjs')
const { RepositoryService } = require('../../electron/repository-service.cjs')

let cwd
let secondCwd
afterEach(() => {
  for (const directory of [cwd, secondCwd]) if (directory) fs.rmSync(directory, { recursive: true, force: true })
  cwd = null
  secondCwd = null
})

async function initRepository(directory) {
  const commands = new GitCommandService()
  const run = (argv) => commands.run({ argv, intent: 'Fixture', source: 'background', cwd: directory })
  for (const argv of [['init', '-b', 'main'], ['config', 'user.name', 'Hunk Stage Test'], ['config', 'user.email', 'hunk-stage@test.local'], ['config', 'core.autocrlf', 'false']]) {
    expect((await run(argv)).ok, argv.join(' ')).toBe(true)
  }
  return { commands, run }
}

async function setup() {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-hunk-stage-'))
  const { commands, run } = await initRepository(cwd)
  // The repository root is read on every call, so a test can switch it mid-flight.
  const target = { root: cwd }
  const repository = new RepositoryService(commands, () => target.root)
  return { commands, run, repository, useRepository: (root) => { target.root = root } }
}

const lines = (count, prefix = 'line') => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`)
const hunkHeaders = (raw) => raw.split('\n').filter((line) => line.startsWith('@@'))
const readBytes = (name) => fs.readFileSync(path.join(cwd, name))
const writeFile = (name, content) => writeFileIn(cwd, name, content)
const writeFileIn = (directory, name, content) => {
  const file = path.join(directory, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}
const git = async (run, argv) => {
  const record = await run(argv)
  expect(record.ok, `${argv.join(' ')}: ${record.stderr}`).toBe(true)
  return record.stdout
}

// 一个 40 行的种子文件 + 两处相距 28 行的改动 → 两个独立 Diff 块。
async function seedTwoHunks(run) {
  const base = lines(40)
  writeFile('app.txt', `${base.join('\n')}\n`)
  await git(run, ['add', '--', 'app.txt'])
  await git(run, ['commit', '-m', 'chore: seed repository'])
  const edited = [...base]
  edited[2] = 'line 3 first edit'
  edited[30] = 'line 31 second edit'
  writeFile('app.txt', `${edited.join('\n')}\n`)
  return { base, edited }
}

describe('v0.6.9 hunk staging (real Git)', () => {
  it('stages only the selected hunk and leaves the worktree bytes untouched', async () => {
    const { commands, run, repository } = await setup()
    await seedTwoHunks(run)
    const before = readBytes('app.txt')

    const read = await repository.diff({ path: 'app.txt', area: 'unstaged' })
    expect(read.ok).toBe(true)
    // 展示读取的补丁参数是固定的：操作重读必须得到同一份输出。
    expect(read.argv).toEqual(['git', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '-U3', '--inter-hunk-context=0', '--', 'app.txt'])
    expect(read.snapshot).toMatch(/^[0-9a-f]{64}$/)
    expect(read.hunkSupport.ok).toBe(true)
    expect(read.hunkSupport.hunks).toHaveLength(2)
    const [first, second] = read.hunkSupport.hunks
    expect(hunkHeaders(read.stdout)).toEqual([first.header, second.header])

    const staged = await repository.stageHunk({ path: 'app.txt', snapshot: read.snapshot, hunk: second })
    expect(staged.ok).toBe(true)
    expect(staged.execution).toMatchObject({ ok: true, argv: ['git', 'apply', '--cached', '-'], intent: 'Stage diff hunk', source: 'user', target: 'app.txt', hunk: second.header })
    // 补丁是输入，不是命令：argv 里既没有文件路径也没有块内容。
    expect(staged.execution.argv.join(' ')).toBe('git apply --cached -')

    const cached = await git(run, ['diff', '--cached', '--', 'app.txt'])
    expect(hunkHeaders(cached)).toEqual([second.header])
    expect(cached).toContain('+line 31 second edit')
    expect(cached).not.toContain('+line 3 first edit')
    // 未选中的块仍在未暂存区。
    expect(hunkHeaders(await git(run, ['diff', '--', 'app.txt']))).toEqual([first.header])
    // 工作区文件字节与操作前完全一致。
    expect(Buffer.compare(before, readBytes('app.txt'))).toBe(0)

    // 账本里只有一条真实执行的 apply，没有整文件 add。
    const applies = commands.history().filter((record) => record.argv[1] === 'apply')
    expect(applies).toHaveLength(1)
    expect(applies[0].rejected).toBeFalsy()
    expect(applies[0].operationId).toBe(staged.execution.operationId)
    expect(applies[0].intent).toBe('Stage diff hunk')
    expect(commands.history().some((record) => record.argv[1] === 'add' && record.intent !== 'Fixture')).toBe(false)
    // 执行后返回的工作区状态已经反映新的暂存内容。
    expect(staged.state.files.filter((file) => file.path === 'app.txt').map((file) => file.area).sort()).toEqual(['staged', 'unstaged'])
  }, 20_000)

  it('stages one hunk of a file that already has staged content', async () => {
    const { run, repository } = await setup()
    const base = lines(40)
    writeFile('app.txt', `${base.join('\n')}\n`)
    await git(run, ['add', '--', 'app.txt'])
    await git(run, ['commit', '-m', 'chore: seed repository'])

    // 先暂存一处改动，再留下两处未暂存改动：同一路径同时有已暂存与未暂存内容。
    const stagedEdit = [...base]
    stagedEdit[2] = 'line 3 already staged'
    writeFile('app.txt', `${stagedEdit.join('\n')}\n`)
    await git(run, ['add', '--', 'app.txt'])
    const bothAreas = [...stagedEdit]
    bothAreas[20] = 'line 21 unstaged first'
    bothAreas[35] = 'line 36 unstaged second'
    writeFile('app.txt', `${bothAreas.join('\n')}\n`)
    const before = readBytes('app.txt')

    const read = await repository.diff({ path: 'app.txt', area: 'unstaged' })
    expect(read.hunkSupport.hunks).toHaveLength(2)
    const stagedNow = await repository.stageHunk({ path: 'app.txt', snapshot: read.snapshot, hunk: read.hunkSupport.hunks[1] })
    expect(stagedNow.ok).toBe(true)

    // 索引里既有原来的已暂存改动，也有刚刚选中的那一块；没选中的块仍在工作区。
    const cached = await git(run, ['diff', '--cached', '--', 'app.txt'])
    expect(cached).toContain('+line 3 already staged')
    expect(cached).toContain('+line 36 unstaged second')
    expect(cached).not.toContain('+line 21 unstaged first')
    const unstaged = await git(run, ['diff', '--', 'app.txt'])
    expect(unstaged).toContain('+line 21 unstaged first')
    expect(unstaged).not.toContain('+line 36 unstaged second')
    // 工作区文件字节没有被补丁改写。
    expect(Buffer.compare(before, readBytes('app.txt'))).toBe(0)
  }, 20_000)

  it('unstages one staged hunk while other staged content and unstaged content stay put', async () => {
    const { commands, run, repository } = await setup()
    const base = lines(40)
    writeFile('app.txt', `${base.join('\n')}\n`)
    writeFile('other.txt', 'other\n')
    await git(run, ['add', '--', 'app.txt', 'other.txt'])
    await git(run, ['commit', '-m', 'chore: seed repository'])

    const staged = [...base]
    staged[2] = 'line 3 staged first'
    staged[30] = 'line 31 staged second'
    writeFile('app.txt', `${staged.join('\n')}\n`)
    writeFile('other.txt', 'other staged\n')
    await git(run, ['add', '--', 'app.txt', 'other.txt'])
    // 同一文件再留一处未暂存改动：取消暂存只能影响被选中的那一块。
    const withUnstaged = [...staged]
    withUnstaged[20] = 'line 21 still unstaged'
    writeFile('app.txt', `${withUnstaged.join('\n')}\n`)
    const before = readBytes('app.txt')

    const read = await repository.diff({ path: 'app.txt', area: 'staged' })
    expect(read.hunkSupport.hunks).toHaveLength(2)
    const [firstStaged, secondStaged] = read.hunkSupport.hunks

    const unstage = await repository.unstageHunk({ path: 'app.txt', snapshot: read.snapshot, hunk: firstStaged })
    expect(unstage.ok).toBe(true)
    expect(unstage.execution).toMatchObject({ ok: true, argv: ['git', 'apply', '--cached', '-R', '-'], intent: 'Unstage diff hunk', source: 'user', target: 'app.txt' })

    // 另一块仍是已暂存内容。
    expect(hunkHeaders(await git(run, ['diff', '--cached', '--', 'app.txt']))).toEqual([secondStaged.header])
    // 其他文件的已暂存内容不受影响。
    expect(await git(run, ['diff', '--cached', '--', 'other.txt'])).toContain('+other staged')
    // 被取消的块回到未暂存 Diff，同时原有的未暂存改动还在。
    const unstagedHeaders = hunkHeaders(await git(run, ['diff', '--', 'app.txt']))
    expect(unstagedHeaders).toHaveLength(2)
    expect(unstagedHeaders[0]).toBe(firstStaged.header)
    expect(unstagedHeaders[1].startsWith('@@ -18,7 +18,7 @@')).toBe(true)
    expect(await git(run, ['diff', '--', 'app.txt'])).toContain('+line 3 staged first')
    expect(Buffer.compare(before, readBytes('app.txt'))).toBe(0)

    const intents = commands.history().filter((record) => record.argv[1] === 'apply').map((record) => record.intent)
    expect(intents).toEqual(['Unstage diff hunk'])
  }, 20_000)

  it('rejects a request whose file was staged by another Git process', async () => {
    const { commands, run, repository } = await setup()
    await seedTwoHunks(run)
    const read = await repository.diff({ path: 'app.txt', area: 'unstaged' })
    const cachedBefore = await git(run, ['diff', '--cached', '--', 'app.txt'])

    // 另一个 Git 进程先把整个文件暂存了。
    await git(run, ['add', '--', 'app.txt'])
    const cachedAfterExternal = await git(run, ['diff', '--cached', '--', 'app.txt'])
    const attempt = await repository.stageHunk({ path: 'app.txt', snapshot: read.snapshot, hunk: read.hunkSupport.hunks[1] })

    expect(attempt.ok).toBe(false)
    expect(attempt.reason).toContain('已不在未暂存区')
    expect(attempt.execution).toBeNull()
    expect(attempt.record).toMatchObject({ rejected: true, exitCode: null, intent: 'Stage diff hunk', target: 'app.txt', argv: ['git', 'apply', '--cached', '-'] })
    expect(attempt.record.displayCommand).toContain('本地校验拒绝，未执行 Git 命令')
    // 拒绝时不执行 Git：外部进程留下的索引内容原样保留。
    expect(await git(run, ['diff', '--cached', '--', 'app.txt'])).toBe(cachedAfterExternal)
    expect(cachedAfterExternal).not.toBe(cachedBefore)
    expect(commands.history().filter((record) => record.argv[1] === 'apply' && !record.rejected)).toHaveLength(0)
  }, 20_000)

  it('rejects a stale snapshot when an editor changed the worktree', async () => {
    const { run, repository } = await setup()
    await seedTwoHunks(run)
    const read = await repository.diff({ path: 'app.txt', area: 'unstaged' })

    writeFile('app.txt', 'completely rewritten\nby an editor\n')
    const attempt = await repository.stageHunk({ path: 'app.txt', snapshot: read.snapshot, hunk: read.hunkSupport.hunks[1] })

    expect(attempt.ok).toBe(false)
    expect(attempt.reason).toContain('Diff 已过期')
    expect(attempt.record).toMatchObject({ rejected: true, target: 'app.txt', hunk: read.hunkSupport.hunks[1].header })
    // 索引没有任何改动，工作区保留编辑器写入的内容。
    expect(await git(run, ['diff', '--cached', '--', 'app.txt'])).toBe('')
    expect(readBytes('app.txt').toString()).toBe('completely rewritten\nby an editor\n')

    // 重新读取之后同一块可以正常暂存。
    const refreshed = await repository.diff({ path: 'app.txt', area: 'unstaged' })
    expect(refreshed.snapshot).not.toBe(read.snapshot)
    const retry = await repository.stageHunk({ path: 'app.txt', snapshot: refreshed.snapshot, hunk: refreshed.hunkSupport.hunks[0] })
    expect(retry.ok).toBe(true)
  }, 20_000)

  it('rejects a request built against a repository that is no longer open', async () => {
    const { run, repository, useRepository } = await setup()
    await seedTwoHunks(run)
    const read = await repository.diff({ path: 'app.txt', area: 'unstaged' })

    secondCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-hunk-stage-other-'))
    const other = await initRepository(secondCwd)
    writeFileIn(secondCwd, 'app.txt', 'line 1\nline 2\n')
    await git(other.run, ['add', '--', 'app.txt'])
    await git(other.run, ['commit', '-m', 'chore: other repository'])
    writeFileIn(secondCwd, 'app.txt', 'line 1 changed\nline 2\n')
    useRepository(secondCwd)

    const attempt = await repository.stageHunk({ path: 'app.txt', snapshot: read.snapshot, hunk: read.hunkSupport.hunks[1] })
    expect(attempt.ok).toBe(false)
    expect(attempt.reason).toContain('Diff 已过期')
    // 新仓库没有被旧请求改动。
    expect(await git(other.run, ['diff', '--cached', '--', 'app.txt'])).toBe('')
    expect(await git(other.run, ['diff', '--', 'app.txt'])).toContain('+line 1 changed')
  }, 20_000)

  it('handles Chinese names, spaces, a real a/ directory, CRLF and a missing final newline', async () => {
    const { run, repository } = await setup()
    const cases = [
      { name: '配置 说明.txt', before: 'x\ny\n', after: 'x\nY 中文说明\n', expect: '+Y 中文说明' },
      { name: 'a/inner.txt', before: 'p\nq\n', after: 'p\nQ\n', expect: '+Q' },
      { name: 'crlf.txt', before: 'one\r\ntwo\r\nthree\r\n', after: 'one\r\ntwo changed\r\nthree\r\n', expect: '+two changed' },
      { name: 'no-eol.txt', before: 'alpha\nbeta', after: 'alpha\nBETA', expect: '+BETA' },
    ]
    for (const item of cases) {
      writeFile(item.name, item.before)
      await git(run, ['add', '--', item.name])
      await git(run, ['commit', '-m', `chore: seed ${item.name}`])
      writeFile(item.name, item.after)
      const before = readBytes(item.name)

      const read = await repository.diff({ path: item.name, area: 'unstaged' })
      expect(read.ok, item.name).toBe(true)
      expect(read.path, item.name).toBe(item.name)
      expect(read.hunkSupport.ok, `${item.name}: ${read.hunkSupport.reason}`).toBe(true)
      expect(read.hunkSupport.hunks).toHaveLength(1)

      const staged = await repository.stageHunk({ path: item.name, snapshot: read.snapshot, hunk: read.hunkSupport.hunks[0] })
      expect(staged.ok, `${item.name}: ${staged.reason}`).toBe(true)
      expect(staged.execution.target).toBe(item.name)
      const cached = await git(run, ['diff', '--cached', '--', item.name])
      expect(cached, item.name).toContain(item.expect)
      if (item.name === 'crlf.txt') expect(cached).toContain('\r\n')
      if (item.name === 'no-eol.txt') expect(cached).toContain('\\ No newline at end of file')
      // 真实命中的路径与工作区字节都正确：补丁没有改写文件。
      expect(Buffer.compare(before, readBytes(item.name)), item.name).toBe(0)
      expect((await repository.state()).files.some((file) => file.path === item.name && file.area === 'staged'), item.name).toBe(true)
    }
  }, 30_000)

  it('rejects binary, new, deleted, renamed and mode-changing files while whole-file staging still works', async () => {
    const { run, repository } = await setup()
    writeFile('binary.dat', Buffer.from([0, 1, 2, 3]))
    writeFile('gone.txt', 'gone\n')
    writeFile('mode.txt', 'mode\n')
    writeFile('tracked.txt', 'tracked\n')
    await git(run, ['add', '--', 'binary.dat', 'gone.txt', 'mode.txt', 'tracked.txt'])
    await git(run, ['commit', '-m', 'chore: seed files'])

    // 二进制：Diff 只说明「无法按文本显示」，没有块可用。
    writeFile('binary.dat', Buffer.from([0, 9, 2, 3]))
    const binary = await repository.diff({ path: 'binary.dat', area: 'unstaged' })
    expect(binary.hunkSupport.ok).toBe(false)
    expect(binary.hunkSupport.reason).toContain('二进制')
    const binaryAttempt = await repository.stageHunk({ path: 'binary.dat', snapshot: binary.snapshot, hunk: { index: 0, header: '@@ -1 +1 @@', contentHash: 'a'.repeat(64) } })
    expect(binaryAttempt.ok).toBe(false)
    expect(binaryAttempt.reason).toContain('二进制')
    // 整文件流程仍然可用。
    expect((await repository.stage('binary.dat')).ok).toBe(true)

    // 未跟踪的新文件。
    writeFile('brand-new.txt', 'new\n')
    const added = await repository.diff({ path: 'brand-new.txt', area: 'unstaged' })
    const addedAttempt = await repository.stageHunk({ path: 'brand-new.txt', snapshot: added.snapshot, hunk: { index: 0, header: '@@ -0,0 +1 @@', contentHash: 'a'.repeat(64) } })
    expect(addedAttempt.reason).toContain('新增、删除或重命名')
    expect((await repository.stage('brand-new.txt')).ok).toBe(true)

    // 删除。
    fs.rmSync(path.join(cwd, 'gone.txt'))
    const deleted = await repository.diff({ path: 'gone.txt', area: 'unstaged' })
    const deletedAttempt = await repository.stageHunk({ path: 'gone.txt', snapshot: deleted.snapshot, hunk: { index: 0, header: '@@ -1 +0,0 @@', contentHash: 'a'.repeat(64) } })
    expect(deletedAttempt.reason).toContain('新增、删除或重命名')
    expect((await repository.stage('gone.txt')).ok).toBe(true)

    // 重命名（已暂存）：状态不是「修改」，不能按块取消暂存。
    await git(run, ['mv', 'tracked.txt', 'renamed.txt'])
    const renamed = await repository.diff({ path: 'renamed.txt', area: 'staged' })
    const renamedAttempt = await repository.unstageHunk({ path: 'renamed.txt', snapshot: renamed.snapshot, hunk: { index: 0, header: '@@ -1 +1 @@', contentHash: 'a'.repeat(64) } })
    expect(renamedAttempt.reason).toContain('新增、删除或重命名')
    // 其他已暂存内容仍按原来的入口处理。
    expect(await git(run, ['diff', '--cached', '--', 'binary.dat'])).toContain('Binary files')

    // 权限变化（Windows 上通过索引修改模式）：只有 old/new mode，没有可应用的块。
    await git(run, ['update-index', '--chmod=+x', '--', 'mode.txt'])
    const mode = await repository.diff({ path: 'mode.txt', area: 'staged' })
    expect(mode.hunkSupport.ok).toBe(false)
    expect(mode.hunkSupport.reason).toContain('没有可操作的文本块')
    const modeAttempt = await repository.unstageHunk({ path: 'mode.txt', snapshot: mode.snapshot, hunk: { index: 0, header: '@@ -1 +1 @@', contentHash: 'a'.repeat(64) } })
    expect(modeAttempt.ok).toBe(false)
    expect(modeAttempt.record).toMatchObject({ rejected: true, intent: 'Unstage diff hunk', target: 'mode.txt' })
  }, 25_000)

  it('rejects an unmerged path in both areas until the conflict is resolved', async () => {
    const { run, repository } = await setup()
    writeFile('conf.txt', 'one\ntwo\nthree\n')
    await git(run, ['add', '--', 'conf.txt'])
    await git(run, ['commit', '-m', 'chore: seed conflict base'])
    await git(run, ['checkout', '-b', 'side'])
    writeFile('conf.txt', 'one\nSIDE\nthree\n')
    await git(run, ['commit', '-am', 'side change'])
    await git(run, ['checkout', 'main'])
    writeFile('conf.txt', 'one\nMAIN\nthree\n')
    await git(run, ['commit', '-am', 'main change'])
    const merge = await run(['merge', 'side'])
    expect(merge.ok).toBe(false)
    expect((await repository.state()).operation).toBe('merge')

    for (const area of ['unstaged', 'staged']) {
      const read = await repository.diff({ path: 'conf.txt', area })
      expect(read.hunkSupport.ok, area).toBe(false)
      expect(read.hunkSupport.reason).toContain('未合并')
      const attempt = area === 'unstaged'
        ? await repository.stageHunk({ path: 'conf.txt', snapshot: read.snapshot, hunk: { index: 0, header: '@@ -1,3 +1,7 @@', contentHash: 'a'.repeat(64) } })
        : await repository.unstageHunk({ path: 'conf.txt', snapshot: read.snapshot, hunk: { index: 0, header: '@@ -1,3 +1,7 @@', contentHash: 'a'.repeat(64) } })
      expect(attempt.ok).toBe(false)
      expect(attempt.reason).toContain('未合并')
      expect(attempt.record).toMatchObject({ rejected: true, target: 'conf.txt' })
    }
    // 未合并状态保留：按块操作没有碰索引。
    expect((await repository.state()).operation).toBe('merge')
  }, 25_000)

  it('refuses a truncated diff instead of guessing the last hunk boundary', async () => {
    const { run, repository } = await setup()
    const base = Array.from({ length: 8000 }, (_, index) => `line ${index} ${'x'.repeat(80)}`)
    writeFile('big.txt', `${base.join('\n')}\n`)
    await git(run, ['add', '--', 'big.txt'])
    await git(run, ['commit', '-m', 'chore: seed large file'])
    writeFile('big.txt', `${base.map((line) => `${line} edited`).join('\n')}\n`)

    const read = await repository.diff({ path: 'big.txt', area: 'unstaged' })
    expect(read.outputTruncated).toBe(true)
    expect(read.hunkSupport.ok).toBe(false)
    expect(read.hunkSupport.reason).toContain('截断')
    const attempt = await repository.stageHunk({ path: 'big.txt', snapshot: read.snapshot, hunk: { index: 0, header: '@@ -1,4 +1,4 @@', contentHash: 'a'.repeat(64) } })
    expect(attempt.ok).toBe(false)
    expect(attempt.reason).toContain('截断')
    // 整文件暂存照旧可用。
    expect((await repository.stage('big.txt')).ok).toBe(true)
  }, 30_000)

  it('returns the real Git failure for a locked index and keeps the repository usable', async () => {
    const { commands, run, repository } = await setup()
    await seedTwoHunks(run)
    const before = readBytes('app.txt')
    const read = await repository.diff({ path: 'app.txt', area: 'unstaged' })

    const lock = path.join(cwd, '.git', 'index.lock')
    fs.writeFileSync(lock, '')
    const blocked = await repository.stageHunk({ path: 'app.txt', snapshot: read.snapshot, hunk: read.hunkSupport.hunks[1] })
    expect(blocked.ok).toBe(false)
    expect(blocked.reason).toContain('无法应用')
    // 不是本地校验拒绝：这是一次真实执行的 Git 命令失败，保留退出码与原始 stderr。
    expect(blocked.execution).toMatchObject({ ok: false, intent: 'Stage diff hunk', target: 'app.txt' })
    expect(blocked.execution.rejected).toBeFalsy()
    expect(blocked.execution.exitCode).not.toBe(0)
    expect(blocked.execution.stderr).toContain('index.lock')
    expect(await git(run, ['diff', '--cached', '--', 'app.txt'])).toBe('')
    expect(Buffer.compare(before, readBytes('app.txt'))).toBe(0)
    fs.rmSync(lock)

    // 解锁后重新读取即可继续，无需重启应用。
    const refreshed = await repository.diff({ path: 'app.txt', area: 'unstaged' })
    const retry = await repository.stageHunk({ path: 'app.txt', snapshot: refreshed.snapshot, hunk: refreshed.hunkSupport.hunks[1] })
    expect(retry.ok).toBe(true)
    expect(hunkHeaders(await git(run, ['diff', '--cached', '--', 'app.txt']))).toHaveLength(1)
    expect(commands.history().some((record) => record.rejected)).toBe(false)
  }, 25_000)

  it('surfaces a patch Git refuses to apply and leaves the index untouched', async () => {
    const { run, repository } = await setup()
    writeFile('ws.txt', 'a\nb\n')
    await git(run, ['add', '--', 'ws.txt'])
    await git(run, ['commit', '-m', 'chore: seed whitespace file'])
    writeFile('ws.txt', 'a\nb with trailing spaces   \n')
    await git(run, ['config', 'apply.whitespace', 'error'])
    const before = readBytes('ws.txt')

    const read = await repository.diff({ path: 'ws.txt', area: 'unstaged' })
    const refused = await repository.stageHunk({ path: 'ws.txt', snapshot: read.snapshot, hunk: read.hunkSupport.hunks[0] })
    expect(refused.ok).toBe(false)
    // 真实失败：Git 拒绝这次应用，索引与工作区都没变。
    expect(refused.execution).toMatchObject({ ok: false, intent: 'Stage diff hunk' })
    expect(refused.execution.exitCode).not.toBe(0)
    expect(refused.execution.stderr).toContain('whitespace')
    expect(await git(run, ['diff', '--cached', '--', 'ws.txt'])).toBe('')
    expect(Buffer.compare(before, readBytes('ws.txt'))).toBe(0)

    // 去掉这条本机配置后，同一块可以重新暂存。
    await git(run, ['config', '--unset', 'apply.whitespace'])
    const refreshed = await repository.diff({ path: 'ws.txt', area: 'unstaged' })
    expect((await repository.stageHunk({ path: 'ws.txt', snapshot: refreshed.snapshot, hunk: refreshed.hunkSupport.hunks[0] })).ok).toBe(true)
  }, 25_000)
})
