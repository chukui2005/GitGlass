const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { GitCommandService } = require('../../electron/git-command-service.cjs')
const { RepositoryService } = require('../../electron/repository-service.cjs')
const { openRepositoryPath } = require('../../electron/repository-opener.cjs')

// v0.6.10 PR 2「远程与上游」的真实 Git 验收：远程配置、远程跟踪分支的检出、上游设置
// 与首次推送，全部以实际 Git 配置与远端引用为准。
let workspace
afterEach(() => {
  if (workspace) fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  workspace = null
})

function tempWorkspace() {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-remote-'))
  return workspace
}

const commandsFor = () => new GitCommandService()
const git = async (cwd, argv) => {
  const record = await commandsFor(cwd).run({ argv, intent: 'Fixture', source: 'background', cwd })
  expect(record.ok, `${argv.join(' ')}: ${record.stderr}`).toBe(true)
  return record.stdout.trim()
}
const gitFails = async (cwd, argv) => {
  const record = await commandsFor(cwd).run({ argv, intent: 'Fixture', source: 'background', cwd })
  expect(record.ok, `${argv.join(' ')} 应当失败`).toBe(false)
  return record
}
// `git config --get` exits 1 when the key is absent: read it tolerantly.
const configValue = async (cwd, key) => {
  const record = await commandsFor().run({ argv: ['config', '--get', key], intent: 'Fixture', source: 'background', cwd })
  return record.ok ? record.stdout.trim() : ''
}

// Append entries straight to `.git/config`: a real, large configuration without
// thousands of Git invocations. Duplicate `[remote "…"]` sections merge normally.
const configPath = (dir) => path.join(dir, '.git', 'config')
function appendRemoteSections(dir, count) {
  let block = ''
  for (let index = 0; index < count; index += 1) {
    block += `[remote "bulk-${index}"]\n\turl = https://example.test/team/repository-${index}-with-a-long-name.git\n\tfetch = +refs/heads/*:refs/remotes/bulk-${index}/*\n`
  }
  fs.appendFileSync(configPath(dir), block, 'utf8')
}
function appendPushUrls(dir, count) {
  let block = '[remote "origin"]\n'
  for (let index = 0; index < count; index += 1) {
    block += `\tpushurl = https://push.example.test/team/repository-${index}-target.git\n`
  }
  fs.appendFileSync(configPath(dir), block, 'utf8')
}

// A real bare remote with `main` plus a second branch `feature/report`.
async function createOrigin() {
  const seed = path.join(workspace, 'seed')
  fs.mkdirSync(seed)
  await git(seed, ['init', '-b', 'main'])
  await git(seed, ['config', 'user.name', 'Remote Fixture'])
  await git(seed, ['config', 'user.email', 'remote@test.local'])
  fs.writeFileSync(path.join(seed, 'readme.txt'), 'main\n')
  await git(seed, ['add', '-A'])
  await git(seed, ['commit', '-m', 'chore: seed main'])
  const mainHead = await git(seed, ['rev-parse', 'HEAD'])
  await git(seed, ['switch', '-c', 'feature/report'])
  fs.writeFileSync(path.join(seed, 'report.txt'), 'report\n')
  await git(seed, ['add', '-A'])
  await git(seed, ['commit', '-m', 'feat: report'])
  const featureHead = await git(seed, ['rev-parse', 'HEAD'])
  await git(seed, ['switch', 'main'])
  const bare = path.join(workspace, 'origin.git')
  await commandsFor(workspace).run({ argv: ['clone', '--bare', seed, bare], intent: 'Fixture', source: 'background', cwd: workspace })
  return { bare, seed, mainHead, featureHead }
}

// A repository opened through the product opener, with local identity configured.
async function setup() {
  tempWorkspace()
  const origin = await createOrigin()
  const work = path.join(workspace, 'work')
  const commands = new GitCommandService()
  const cloned = await commands.run({ argv: ['clone', '--', origin.bare, work], intent: 'Fixture', source: 'background', cwd: workspace })
  expect(cloned.ok, cloned.stderr).toBe(true)
  await git(work, ['config', 'user.name', 'Remote Fixture'])
  await git(work, ['config', 'user.email', 'remote@test.local'])
  const current = { root: work }
  const repository = new RepositoryService(commands, () => current.root)
  const opened = await openRepositoryPath({ candidate: work, commandService: commands, repository, remember: () => {}, setRepositoryPath: (root) => { current.root = root } })
  expect(opened.ok).toBe(true)
  return { ...origin, work, commands, repository }
}

const cloneRecords = (commands, intent) => commands.history().filter((record) => record.intent === intent)

describe('v0.6.10 remote configuration (real Git)', () => {
  it('previews, executes and re-reads an added and an edited remote', async () => {
    const { work, repository } = await setup()
    const prepared = await repository.prepareRemoteConfig('add', { name: 'upstream', url: 'https://example.invalid/team/repo.git' })
    expect(prepared.ok).toBe(true)
    expect(prepared.plan.argv).toEqual(['remote', 'add', 'upstream', 'https://example.invalid/team/repo.git'])

    const added = await repository.executeRemoteConfig('add', { name: 'upstream', url: 'https://example.invalid/team/repo.git' }, prepared.plan.operationId)
    expect(added.execution.ok).toBe(true)
    // 成功后有重新读取的 Git 配置，界面的列表来自这里而不是计划里的值。
    expect(added.remotes.map((entry) => entry.name).sort()).toEqual(['origin', 'upstream'])
    expect(added.remotes.find((entry) => entry.name === 'upstream').url).toBe('https://example.invalid/team/repo.git')
    expect(await git(work, ['remote', 'get-url', 'upstream'])).toBe('https://example.invalid/team/repo.git')

    const edited = await repository.prepareRemoteConfig('set-url', { name: 'upstream', url: 'https://example.invalid/team/renamed.git' })
    expect(edited.ok).toBe(true)
    expect(edited.previousUrl).toBe('https://example.invalid/team/repo.git')
    const result = await repository.executeRemoteConfig('set-url', { name: 'upstream', url: 'https://example.invalid/team/renamed.git' }, edited.plan.operationId)
    expect(result.execution.ok).toBe(true)
    expect(await git(work, ['remote', 'get-url', 'upstream'])).toBe('https://example.invalid/team/renamed.git')
    expect(result.remotes.find((entry) => entry.name === 'upstream').url).toBe('https://example.invalid/team/renamed.git')
  })

  it('refuses a duplicate name and a credential-bearing address without running Git', async () => {
    const { repository, commands } = await setup()
    const duplicate = await repository.prepareRemoteConfig('add', { name: 'origin', url: 'https://example.invalid/other.git' })
    expect(duplicate).toMatchObject({ ok: false, blocked: true, plan: null })
    expect(duplicate.reason).toContain('已存在')

    const credential = await repository.prepareRemoteConfig('add', { name: 'leaky', url: 'https://user:tok3n@example.invalid/other.git' })
    expect(credential).toMatchObject({ ok: false, blocked: true, plan: null })
    expect(credential.reason).not.toContain('tok3n')
    expect(cloneRecords(commands, 'Add remote')).toHaveLength(0)

    // 名称规则同样由主进程守：`..`、空格与以连字符开头的名称都不接受。
    for (const name of ['bad name', '-leading', 'a/b']) {
      const invalid = await repository.prepareRemoteConfig('add', { name, url: 'https://example.invalid/x.git' })
      expect(invalid.ok, name).toBe(false)
    }
    expect(cloneRecords(commands, 'Add remote')).toHaveLength(0)
  })

  it('refuses an execute whose preview no longer matches the repository configuration', async () => {
    const { work, repository, commands } = await setup()
    const prepared = await repository.prepareRemoteConfig('add', { name: 'stale', url: 'https://example.invalid/stale.git' })
    expect(prepared.ok).toBe(true)

    // 预览之后配置被别人改了（例如终端里 git remote add）。
    await git(work, ['remote', 'add', 'other', 'https://example.invalid/other.git'])
    const stale = await repository.executeRemoteConfig('add', { name: 'stale', url: 'https://example.invalid/stale.git' }, prepared.plan.operationId)
    expect(stale).toMatchObject({ ok: false, blocked: true, execution: null })
    expect(stale.reason).toContain('发生了变化')
    expect(await git(work, ['remote'])).not.toContain('stale')
    expect(cloneRecords(commands, 'Add remote')).toHaveLength(0)

    // 预览是一次性的：同一个 operationId 不会被第二次执行。
    const repeat = await repository.executeRemoteConfig('add', { name: 'stale', url: 'https://example.invalid/stale.git' }, prepared.plan.operationId)
    expect(repeat).toMatchObject({ ok: false, blocked: true })
    expect(repeat.reason).toContain('过期')
  })
})

describe('v0.6.10 remote-tracked branches and upstream (real Git)', () => {
  it('checks out a remote-tracking branch as a local tracking branch', async () => {
    const { work, repository, featureHead } = await setup()
    const remoteBranches = await repository.remoteBranches()
    expect(remoteBranches.branches.map((entry) => entry.full).sort()).toEqual(['refs/remotes/origin/feature/report', 'refs/remotes/origin/main'])

    const prepared = await repository.prepareCheckoutRemote('refs/remotes/origin/feature/report', 'report-work')
    expect(prepared.ok).toBe(true)
    expect(prepared.plan.argv).toEqual(['switch', '--track', '-c', 'report-work', 'origin/feature/report'])
    const result = await repository.executeCheckoutRemote('refs/remotes/origin/feature/report', 'report-work', prepared.plan.operationId)
    expect(result.execution.ok).toBe(true)

    // 本地分支、HEAD 与上游都以 Git 的实际状态为准。
    expect(await git(work, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('report-work')
    expect(await git(work, ['rev-parse', 'HEAD'])).toBe(featureHead)
    expect(await git(work, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).toBe('origin/feature/report')
    expect(result.state.branch).toBe('report-work')
  })

  it('refuses a checkout when a local branch has the same name or the worktree has changes', async () => {
    const { work, repository } = await setup()
    // 本地同名分支：先建一个同名的，再试检出。
    await git(work, ['branch', 'report-work', 'origin/feature/report'])
    const sameName = await repository.prepareCheckoutRemote('refs/remotes/origin/feature/report', 'report-work')
    expect(sameName).toMatchObject({ ok: false, blocked: true, plan: null })
    expect(sameName.reason).toContain('同名分支')

    // 工作区有改动：不 stash、不覆盖，直接阻断。
    fs.writeFileSync(path.join(work, 'readme.txt'), 'dirty\n')
    const dirty = await repository.prepareCheckoutRemote('refs/remotes/origin/feature/report', 'another-name')
    expect(dirty).toMatchObject({ ok: false, blocked: true, plan: null })
    expect(dirty.reason).toContain('工作区存在未提交或未暂存的变更')
    expect(await git(work, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main')
    expect(fs.readFileSync(path.join(work, 'readme.txt'), 'utf8')).toBe('dirty\n')
  })

  it('sets the upstream and reports the tracking relation Git actually saved', async () => {
    const { work, repository } = await setup()
    await git(work, ['switch', '-c', 'local-topic'])
    const prepared = await repository.prepareSetUpstream('refs/remotes/origin/feature/report')
    expect(prepared.ok).toBe(true)
    expect(prepared.plan.argv).toEqual(['branch', '--set-upstream-to', 'origin/feature/report', 'local-topic'])

    const result = await repository.executeSetUpstream('refs/remotes/origin/feature/report', prepared.plan.operationId)
    expect(result.execution.ok).toBe(true)
    expect(result.upstream).toMatchObject({ ref: 'origin/feature/report', remote: 'origin', branch: 'feature/report' })
    expect(await git(work, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).toBe('origin/feature/report')
    expect(await git(work, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', 'local-topic@{upstream}'])).toBe('origin/feature/report')
  })
})

describe('v0.6.10 first push with upstream (real Git)', () => {
  it('runs clone, checkout, new branch, commit and first push against a temporary bare remote', async () => {
    const { bare, work, repository } = await setup()

    // 1. 检出已有的远程跟踪分支。
    const checkout = await repository.prepareCheckoutRemote('refs/remotes/origin/feature/report')
    const checkedOut = await repository.executeCheckoutRemote('refs/remotes/origin/feature/report', undefined, checkout.plan.operationId)
    expect(checkedOut.execution.ok).toBe(true)
    expect(checkedOut.state.branch).toBe('feature/report')

    // 2. 新建本地分支并提交。
    const branch = await repository.prepareSwitch('my-feature', true)
    expect(branch.ok).toBe(true)
    const switched = await repository.executeSwitch('my-feature', true, branch.plan.operationId)
    expect(switched.execution.ok).toBe(true)
    fs.writeFileSync(path.join(work, 'my-feature.txt'), 'work\n')
    expect((await repository.stage('my-feature.txt')).ok).toBe(true)
    expect((await repository.commit('feat: my feature')).ok).toBe(true)
    const head = await git(work, ['rev-parse', 'HEAD'])

    // 3. 首次推送：预览里写清本地分支、实际推送目标与目标 refs/heads/…。
    const prepared = await repository.prepareFirstPush({})
    expect(prepared.ok).toBe(true)
    expect(prepared.branch).toBe('my-feature')
    expect(prepared.remote).toBe('origin')
    expect(prepared.targetRef).toBe('refs/heads/my-feature')
    expect(prepared.remoteBranch).toBe('my-feature')
    // 源与目标都是完整引用，并且显式关掉 followTags。
    expect(prepared.plan.argv).toEqual([
      'push',
      '--set-upstream',
      '--no-follow-tags',
      'origin',
      'refs/heads/my-feature:refs/heads/my-feature',
    ])
    expect(prepared.plan.displayCommand).toBe('git push --set-upstream --no-follow-tags origin refs/heads/my-feature:refs/heads/my-feature')
    // 预览里的 push 地址来自实际配置（这里与 fetch 地址相同）。
    expect(prepared.pushUrls).toEqual([bare])

    const pushed = await repository.executeFirstPush({}, prepared.plan.operationId)
    expect(pushed.execution.ok, pushed.execution.stderr).toBe(true)
    // 远端提交 ID、实际上游与同步状态。
    expect(await git(bare, ['rev-parse', 'refs/heads/my-feature'])).toBe(head)
    expect(await git(work, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).toBe('origin/my-feature')
    expect(pushed.upstream).toMatchObject({ ref: 'origin/my-feature', remote: 'origin', branch: 'my-feature' })
    expect(pushed.overview).toMatchObject({ ok: true, ahead: 0, behind: 0 })
    // 本地分支的配置也记下了跟踪关系。
    expect(await configValue(work, 'branch.my-feature.remote')).toBe('origin')
    expect(await configValue(work, 'branch.my-feature.merge')).toBe('refs/heads/my-feature')
  })

  it('reports a rejected non-fast-forward push and leaves the upstream and remote ref untouched', async () => {
    const { bare, work, repository } = await setup()
    await git(work, ['switch', '-c', 'clash'])
    fs.writeFileSync(path.join(work, 'clash.txt'), 'local\n')
    await git(work, ['add', '-A'])
    await git(work, ['commit', '-m', 'feat: local clash'])

    // 另一个人先把同名分支推到了远端，历史与本地互不相同。
    const other = path.join(workspace, 'other')
    await commandsFor(workspace).run({ argv: ['clone', '--', bare, other], intent: 'Fixture', source: 'background', cwd: workspace })
    await git(other, ['config', 'user.name', 'Other'])
    await git(other, ['config', 'user.email', 'other@test.local'])
    await git(other, ['switch', '-c', 'clash'])
    fs.writeFileSync(path.join(other, 'other.txt'), 'remote\n')
    await git(other, ['add', '-A'])
    await git(other, ['commit', '-m', 'feat: remote clash'])
    await git(other, ['push', 'origin', 'clash'])
    const remoteHead = await git(bare, ['rev-parse', 'refs/heads/clash'])

    const prepared = await repository.prepareFirstPush({})
    expect(prepared.ok).toBe(true)
    const pushed = await repository.executeFirstPush({}, prepared.plan.operationId)
    expect(pushed.execution.ok).toBe(false)
    expect(pushed.execution.stderr).toMatch(/rejected|non-fast-forward|fetch first/i)

    // 上游仍然没有配置，远端引用也保持原值。
    expect(pushed.upstream).toBeNull()
    await gitFails(work, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    expect(await configValue(work, 'branch.clash.remote')).toBe('')
    expect(await git(bare, ['rev-parse', 'refs/heads/clash'])).toBe(remoteHead)
  })
})

describe('v0.6.10 first push uses the actual push URL (real Git)', () => {
  const bareClone = async (from, to) => {
    const record = await commandsFor().run({ argv: ['clone', '--bare', from, to], intent: 'Fixture', source: 'background', cwd: workspace })
    expect(record.ok, record.stderr).toBe(true)
  }

  it('previews the configured push URL, pushes there, and refuses the plan after the push URL changes', async () => {
    const { bare, work, repository } = await setup()
    const pushTarget = path.join(workspace, 'push-target.git')
    await bareClone(bare, pushTarget)
    // fetch 地址仍是第一个 bare；push 地址改成第二个。
    await git(work, ['remote', 'set-url', '--add', '--push', 'origin', pushTarget])
    expect((await git(work, ['remote', 'get-url', '--push', '--all', 'origin'])).split(/\r?\n/)).toEqual([pushTarget])

    await git(work, ['switch', '-c', 'split-push'])
    fs.writeFileSync(path.join(work, 'split.txt'), 'split\n')
    await git(work, ['add', '-A'])
    await git(work, ['commit', '-m', 'feat: split push'])
    const head = await git(work, ['rev-parse', 'HEAD'])

    const prepared = await repository.prepareFirstPush({})
    expect(prepared.ok).toBe(true)
    // 预览读的是实际 push 地址，而不是 fetch 地址。
    expect(prepared.pushUrls).toEqual([pushTarget])
    expect(prepared.plan.argv[prepared.plan.argv.length - 2]).toBe('origin')

    // 预览之后 push 地址被改了：旧计划必须失效，两个远端都不能出现这次推送。
    await git(work, ['remote', 'set-url', '--push', 'origin', bare])
    const stale = await repository.executeFirstPush({}, prepared.plan.operationId)
    expect(stale).toMatchObject({ ok: false, blocked: true, execution: null })
    expect(stale.reason).toContain('推送地址')
    await gitFails(pushTarget, ['rev-parse', '--verify', 'refs/heads/split-push'])
    await gitFails(bare, ['rev-parse', '--verify', 'refs/heads/split-push'])

    // 重新预览后，推送落到现在的实际 push 地址（fetch 地址那个 bare）。
    const retry = await repository.prepareFirstPush({})
    expect(retry.pushUrls).toEqual([bare])
    const pushed = await repository.executeFirstPush({}, retry.plan.operationId)
    expect(pushed.execution.ok, pushed.execution.stderr).toBe(true)
    expect(await git(bare, ['rev-parse', 'refs/heads/split-push'])).toBe(head)
    expect(await git(work, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).toBe('origin/split-push')
  })

  it('blocks the first push when several push URLs are configured, without touching either remote', async () => {
    const { bare, work, repository, commands } = await setup()
    const accepting = path.join(workspace, 'push-accepting.git')
    const rejecting = path.join(workspace, 'push-rejecting.git')
    await bareClone(bare, accepting)
    await bareClone(bare, rejecting)

    // rejecting 上先放一个同名分支且历史分叉：真推过去一定会被 Git 拒绝。
    const rival = path.join(workspace, 'rival')
    const rivalClone = await commandsFor().run({ argv: ['clone', '--', rejecting, rival], intent: 'Fixture', source: 'background', cwd: workspace })
    expect(rivalClone.ok, rivalClone.stderr).toBe(true)
    await git(rival, ['config', 'user.name', 'Rival'])
    await git(rival, ['config', 'user.email', 'rival@test.local'])
    await git(rival, ['switch', '-c', 'multi-push'])
    fs.writeFileSync(path.join(rival, 'rival.txt'), 'rival\n')
    await git(rival, ['add', '-A'])
    await git(rival, ['commit', '-m', 'feat: rival branch'])
    await git(rival, ['push', 'origin', 'multi-push'])
    const rivalHead = await git(rejecting, ['rev-parse', 'refs/heads/multi-push'])

    await git(work, ['remote', 'set-url', '--push', 'origin', accepting])
    await git(work, ['remote', 'set-url', '--add', '--push', 'origin', rejecting])
    expect((await git(work, ['remote', 'get-url', '--push', '--all', 'origin'])).split(/\r?\n/)).toEqual([accepting, rejecting])

    await git(work, ['switch', '-c', 'multi-push'])
    fs.writeFileSync(path.join(work, 'local.txt'), 'local\n')
    await git(work, ['add', '-A'])
    await git(work, ['commit', '-m', 'feat: local branch'])

    const prepared = await repository.prepareFirstPush({})
    expect(prepared).toMatchObject({ ok: false, blocked: true, plan: null })
    // 预览阶段把所有地址列出来，并说明 Beta 的限制。
    expect(prepared.pushUrls).toEqual([accepting, rejecting])
    expect(prepared.reason).toContain('只支持一个')

    // 一条命令都没执行：accepting 上没有新分支，rejecting 的引用保持原值，上游未设置。
    await gitFails(accepting, ['rev-parse', '--verify', 'refs/heads/multi-push'])
    expect(await git(rejecting, ['rev-parse', 'refs/heads/multi-push'])).toBe(rivalHead)
    await gitFails(work, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    expect(await configValue(work, 'branch.multi-push.remote')).toBe('')
    expect(commands.history().filter((record) => record.intent === 'Push branch and set upstream')).toHaveLength(0)
  })

  it('pushes only the branch when a tag shares its name and push.followTags is enabled', async () => {
    const { bare, work, repository } = await setup()
    await git(work, ['switch', '-c', 'shared-name'])
    fs.writeFileSync(path.join(work, 'shared.txt'), 'shared\n')
    await git(work, ['add', '-A'])
    await git(work, ['commit', '-m', 'feat: same name'])
    // 同名注解标签 + 全局 followTags：没有 `--no-follow-tags` 时 Git 会顺带推标签。
    await git(work, ['tag', '-a', 'shared-name', '-m', 'release tag'])
    await git(work, ['config', 'push.followTags', 'true'])
    const head = await git(work, ['rev-parse', 'HEAD'])

    const prepared = await repository.prepareFirstPush({})
    expect(prepared.plan.argv).toContain('--no-follow-tags')
    expect(prepared.plan.argv[prepared.plan.argv.length - 1]).toBe('refs/heads/shared-name:refs/heads/shared-name')
    const pushed = await repository.executeFirstPush({}, prepared.plan.operationId)
    expect(pushed.execution.ok, pushed.execution.stderr).toBe(true)
    expect(await git(bare, ['rev-parse', 'refs/heads/shared-name'])).toBe(head)
    // 标签没有被推到远端；本地标签仍在。
    await gitFails(bare, ['rev-parse', '--verify', 'refs/tags/shared-name'])
    expect(await git(work, ['rev-parse', '--verify', 'refs/tags/shared-name'])).toBeTruthy()
  })
})

describe('v0.6.10 remote URLs keep credentials out of the renderer and the ledger (real Git)', () => {
  it('redacts a percent-encoded token query parameter in every response and every new ledger record', async () => {
    const { work, repository, commands } = await setup()
    const token = 'placeholder-token-7f3a'
    // 已有的远程地址里带一个占位令牌（直接改配置，不经过应用）。
    await git(work, ['remote', 'set-url', 'origin', `https://example.test/team/repo.git?access%5Ftoken=${token}&ref=main`])

    const overview = await repository.remoteOverview()
    const details = await repository.remotesDetailed()
    const pushUrls = await repository.pushUrlsFor('origin')
    const digest = await repository.remoteConfigDigest()

    // 渲染层能拿到的每一份响应都不含令牌原文。
    for (const payload of [overview, details, pushUrls]) {
      expect(JSON.stringify(payload)).not.toContain(token)
    }
    expect(overview.details.find((entry) => entry.name === 'origin').url).toContain('<redacted>')
    expect(overview.details.find((entry) => entry.name === 'origin').url).toContain('ref=main')
    expect(pushUrls.urls[0]).toContain('<redacted>')

    // 配置版本读取只留执行元数据：账本里没有 stdout/stderr。
    expect(digest.record).toMatchObject({ intent: 'Read remote configuration version', outputRetained: false, stdout: '', stderr: '' })

    // 这些读取新增的每一条账本记录都已脱敏。
    const reads = commands.history().filter((record) =>
      ['Read remote configuration', 'Read remote push URL', 'Read remote configuration version'].includes(record.intent),
    )
    expect(reads.length).toBeGreaterThanOrEqual(3)
    for (const record of reads) {
      expect(JSON.stringify(record)).not.toContain(token)
    }
  })
})

describe('v0.6.10 remote configuration version (real Git)', () => {
  it('invalidates a reviewed plan when only the credential part of a remote URL changes', async () => {
    const { work, repository, commands } = await setup()
    // 先让 origin 带内嵌凭据（直接改配置，不经过应用）。
    await git(work, ['remote', 'set-url', 'origin', 'https://user:first@example.test/team/repo.git'])
    const prepared = await repository.prepareRemoteConfig('add', { name: 'upstream', url: 'https://example.test/team/repo.git' })
    expect(prepared.ok).toBe(true)

    // 只改凭据：界面与账本里的地址已经脱敏（共享的凭据过滤器会抹掉 userinfo），
    // 两次读取看起来一样，但实际配置已经变了。
    await git(work, ['remote', 'set-url', 'origin', 'https://user:second@example.test/team/repo.git'])
    const details = await repository.remotesDetailed()
    const shownUrl = details.remotes.find((entry) => entry.name === 'origin').url
    expect(shownUrl).toBe('https://example.test/team/repo.git')
    expect(shownUrl).not.toContain('second')

    const stale = await repository.executeRemoteConfig('add', { name: 'upstream', url: 'https://example.test/team/repo.git' }, prepared.plan.operationId)
    expect(stale).toMatchObject({ ok: false, blocked: true, execution: null })
    expect(stale.reason).toContain('变化')
    expect(await git(work, ['remote'])).not.toContain('upstream')
    expect(cloneRecords(commands, 'Add remote')).toHaveLength(0)
  })
})

describe('v0.6.10 real remote failures are redacted before the ledger and the renderer (real Git)', () => {
  it('redacts an encoded token echoed by a local HTTP 403 during the first push', async () => {
    const { work, repository, commands } = await setup()
    const token = 'placeholder-token-9c1'
    const server = http.createServer((request, response) => {
      response.writeHead(403)
      response.end('forbidden')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    try {
      // 已有的 origin 指向本地 403 服务，地址里带占位令牌（直接改配置，不经过应用）。
      await git(work, ['remote', 'set-url', 'origin', `http://127.0.0.1:${port}/team/repo.git?access%5Ftoken=${token}`])
      await git(work, ['switch', '-c', 'rejected-by-http'])
      fs.writeFileSync(path.join(work, 'http.txt'), 'http\n')
      await git(work, ['add', '-A'])
      await git(work, ['commit', '-m', 'feat: rejected by http'])

      const prepared = await repository.prepareFirstPush({})
      expect(prepared.ok, prepared.reason).toBe(true)
      // 预览响应里也没有令牌原文。
      expect(JSON.stringify(prepared)).not.toContain(token)

      const pushed = await repository.executeFirstPush({}, prepared.plan.operationId)
      expect(pushed.execution.ok).toBe(false)
      // Git 回显的 403 失败输出在进入账本与渲染层之前已经脱敏。
      expect(pushed.execution.stderr).toContain('403')
      expect(pushed.execution.stderr).not.toContain(token)
      expect(pushed.execution.stderr).toContain('<redacted>')
      expect(JSON.stringify(pushed)).not.toContain(token)

      const record = commands.history().find((entry) => entry.intent === 'Push branch and set upstream')
      expect(record).toBeDefined()
      expect(record.ok).toBe(false)
      expect(JSON.stringify(record)).not.toContain(token)
      // 推送失败没有设置上游。
      await gitFails(work, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

describe('v0.6.10 truncated reads block write plans (real Git)', () => {
  it('refuses both the old preview and a new one when the configuration read is truncated', async () => {
    const { work, repository, commands } = await setup()
    const prepared = await repository.prepareRemoteConfig('add', { name: 'upstream', url: 'https://example.test/team/repo.git' })
    expect(prepared.ok).toBe(true)

    // 外部把配置撑到超过默认 64 KiB 读取上限。
    appendRemoteSections(work, 2000)
    const digest = await repository.remoteConfigDigest()
    expect(digest.truncated).toBe(true)
    expect(digest.ok).toBe(false)
    expect(digest.record.outputTruncated).toBe(true)
    // 版本读取仍然不把配置内容写进账本。
    expect(digest.record.stdout).toBe('')

    // 旧预览不能覆盖外部修改：执行被拒，理由指向截断，而不是“配置没变”。
    const stale = await repository.executeRemoteConfig('add', { name: 'upstream', url: 'https://example.test/team/repo.git' }, prepared.plan.operationId)
    expect(stale).toMatchObject({ ok: false, blocked: true, execution: null })
    expect(stale.reason).toContain('截断')
    expect((await git(work, ['remote'])).split(/\r?\n/)).not.toContain('upstream')
    expect(cloneRecords(commands, 'Add remote')).toHaveLength(0)

    // 新预览同样被阻断：不生成计划，也就没有可确认的写入。
    const blocked = await repository.prepareRemoteConfig('add', { name: 'another', url: 'https://example.test/team/repo.git' })
    expect(blocked).toMatchObject({ ok: false, blocked: true, plan: null })
    expect(blocked.reason).toContain('截断')
  })

  it('refuses the first push when the push-URL read is truncated', async () => {
    const { work, repository, commands } = await setup()
    await git(work, ['switch', '-c', 'many-pushes'])
    fs.writeFileSync(path.join(work, 'many.txt'), 'many\n')
    await git(work, ['add', '-A'])
    await git(work, ['commit', '-m', 'feat: many pushes'])
    // 2000 个 push 地址：`git remote get-url --push --all` 的输出远超 64 KiB。
    appendPushUrls(work, 2000)

    const pushUrls = await repository.pushUrlsFor('origin')
    expect(pushUrls.truncated).toBe(true)
    expect(pushUrls.ok).toBe(false)

    const prepared = await repository.prepareFirstPush({})
    expect(prepared).toMatchObject({ ok: false, blocked: true, plan: null })
    expect(prepared.reason).toContain('截断')
    expect(commands.history().filter((record) => record.intent === 'Push branch and set upstream')).toHaveLength(0)
    await gitFails(work, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  })
})
