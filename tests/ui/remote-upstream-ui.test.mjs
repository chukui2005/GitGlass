// @vitest-environment jsdom
//
// v0.6.10 PR 2「远程与上游」的真渲染断言：远程列表与配置表单、远程跟踪分支的检出、
// 上游设置、首次推送的预览与确认，以及被阻断时的提示。真实 Git 语义由
// tests/integration/remote-upstream.integration.test.cjs 覆盖。
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp } from '../support/render-app.mjs'
import { repositoryState } from '../support/gitglass-fixtures.mjs'

const OVERVIEW = {
  ok: true,
  remotes: ['origin'],
  details: [{ name: 'origin', url: 'git@example.test:team/repo.git' }],
  remote: { name: 'origin', url: 'git@example.test:team/repo.git' },
  upstream: null,
  ahead: 0,
  behind: 0,
  state: { branch: 'main' },
  reason: '当前分支尚未配置上游分支。',
  suggestion: '',
}

const REMOTE_BRANCHES = [
  { full: 'refs/remotes/origin/feature/report', short: 'origin/feature/report', hash: 'abc1234', remote: 'origin', branch: 'feature/report' },
  { full: 'refs/remotes/origin/main', short: 'origin/main', hash: 'def5678', remote: 'origin', branch: 'main' },
]

const CONFIG_PLAN = {
  ok: true,
  blocked: false,
  kind: 'add',
  name: 'upstream',
  url: 'https://example.test/team/repo.git',
  plan: { operationId: 'op-remote-config', displayCommand: 'git remote add upstream https://example.test/team/repo.git' },
}

const CHECKOUT_PLAN = {
  ok: true,
  blocked: false,
  kind: 'checkout',
  local: 'feature/report',
  remoteBranch: 'refs/remotes/origin/feature/report',
  remoteBranchShort: 'origin/feature/report',
  branch: 'feature/report',
  plan: { operationId: 'op-checkout', displayCommand: 'git switch --track -c feature/report origin/feature/report' },
}

const UPSTREAM_PLAN = {
  ok: true,
  blocked: false,
  kind: 'set-upstream',
  branch: 'main',
  remoteBranch: 'refs/remotes/origin/main',
  remoteBranchShort: 'origin/main',
  plan: { operationId: 'op-upstream', displayCommand: 'git branch --set-upstream-to origin/main main' },
}

const FIRST_PUSH_PLAN = {
  ok: true,
  blocked: false,
  kind: 'first-push',
  branch: 'main',
  remote: 'origin',
  remoteUrl: 'git@example.test:team/repo.git',
  remoteBranch: 'main',
  targetRef: 'refs/heads/main',
  plan: { operationId: 'op-first-push', displayCommand: 'git push --set-upstream origin main:refs/heads/main' },
}

async function renderRemote(overrides = {}) {
  const view = renderApp({
    getState: async () => repositoryState(),
    getLedger: async () => [],
    getCommits: async () => ({ commits: [] }),
    getBranches: async () => ({ branches: [{ name: 'main', current: true, hash: 'abc1234' }] }),
    getRemoteOverview: async () => OVERVIEW,
    getRemoteBranches: async () => ({ branches: REMOTE_BRANCHES }),
    prepareRemoteConfig: vi.fn(async () => CONFIG_PLAN),
    executeRemoteConfig: vi.fn(async () => ({
      ok: true,
      execution: { ok: true, operationId: 'op-remote-config' },
      remotes: [{ name: 'origin', url: 'git@example.test:team/repo.git' }, { name: 'upstream', url: 'https://example.test/team/repo.git' }],
      overview: OVERVIEW,
    })),
    prepareRemoteBranch: vi.fn(async (kind) => (kind === 'set-upstream' ? UPSTREAM_PLAN : CHECKOUT_PLAN)),
    executeRemoteBranch: vi.fn(async () => ({ ok: true, execution: { ok: true }, remoteBranch: 'refs/remotes/origin/feature/report', upstream: { ref: 'origin/main', remote: 'origin', branch: 'main' } })),
    prepareFirstPush: vi.fn(async () => FIRST_PUSH_PLAN),
    executeFirstPush: vi.fn(async () => ({ ok: true, execution: { ok: true }, upstream: { ref: 'origin/main', remote: 'origin', branch: 'main' }, targetRef: 'refs/heads/main', overview: OVERVIEW })),
    ...overrides,
  })
  const user = userEvent.setup()
  await waitFor(() => {
    expect(screen.getByText('远程跟踪分支')).toBeInTheDocument()
  })
  return { ...view, user, stub: view.gitglass }
}

const contextPanel = () => document.querySelector('.context-panel')
// 侧栏的远程区块：`.section-label` 里是纯文本标签，不是标题元素。
const sidebar = () => screen.getByText('远程跟踪分支').closest('section')

describe('remote configuration in the workbench (rendered)', () => {
  it('lists the configured remotes and previews an added remote before running it', async () => {
    const { user, stub } = await renderRemote()

    expect(within(sidebar()).getByText('origin')).toBeInTheDocument()
    expect(within(sidebar()).getByText('git@example.test:team/repo.git')).toBeInTheDocument()

    await user.click(within(sidebar()).getByRole('button', { name: '添加远程仓库' }))
    const panel = within(contextPanel())
    expect(panel.getByRole('heading', { name: '添加远程仓库' })).toBeInTheDocument()
    await user.type(panel.getByLabelText('远程名称'), 'upstream')
    await user.type(panel.getByLabelText('仓库地址'), 'https://example.test/team/repo.git')

    // 表单本身不执行任何命令：先预览命令。
    expect(stub.prepareRemoteConfig).not.toHaveBeenCalled()
    await user.click(panel.getByRole('button', { name: '预览命令' }))
    await waitFor(() => {
      expect(stub.prepareRemoteConfig).toHaveBeenCalledWith('add', { name: 'upstream', url: 'https://example.test/team/repo.git' })
    })
    expect(stub.executeRemoteConfig).not.toHaveBeenCalled()
    expect(panel.getByText('计划执行（尚未运行）')).toBeInTheDocument()
    expect(contextPanel().querySelector('.planned-command')).toHaveTextContent('git remote add upstream https://example.test/team/repo.git')

    await user.click(panel.getByRole('button', { name: '确认添加远程' }))
    await waitFor(() => {
      expect(stub.executeRemoteConfig).toHaveBeenCalledWith('add', { name: 'upstream', url: 'https://example.test/team/repo.git' }, 'op-remote-config')
    })
    expect(await screen.findByText('已添加远程：upstream')).toBeInTheDocument()
  })

  it('prefills the existing address when editing a remote', async () => {
    const { user } = await renderRemote({
      prepareRemoteConfig: vi.fn(async () => ({ ...CONFIG_PLAN, kind: 'set-url', plan: { operationId: 'op-edit', displayCommand: 'git remote set-url origin https://example.test/team/renamed.git' } })),
    })
    await user.click(within(sidebar()).getByRole('button', { name: '编辑远程 origin 的地址' }))

    const panel = within(contextPanel())
    expect(panel.getByLabelText('远程名称')).toHaveValue('origin')
    expect(panel.getByLabelText('仓库地址')).toHaveValue('git@example.test:team/repo.git')
    expect(panel.getByRole('heading', { name: '编辑远程地址' })).toBeInTheDocument()
  })

  it('shows the main-process reason when a remote change is blocked', async () => {
    const reason = '远程「origin」已存在。请换一个名称，或编辑现有远程的地址。'
    const { user } = await renderRemote({
      prepareRemoteConfig: vi.fn(async () => ({ ok: false, blocked: true, reason, plan: null })),
    })
    await user.click(within(sidebar()).getByRole('button', { name: '添加远程仓库' }))
    const panel = within(contextPanel())
    await user.type(panel.getByLabelText('远程名称'), 'origin')
    await user.type(panel.getByLabelText('仓库地址'), 'https://example.test/other.git')
    await user.click(panel.getByRole('button', { name: '预览命令' }))

    expect(await panel.findByRole('alert')).toHaveTextContent(reason)
    expect(panel.queryByRole('button', { name: '确认添加远程' })).toBeNull()
  })
})

describe('remote-tracked branches in the workbench (rendered)', () => {
  it('checks out a remote-tracking branch through its preview, keeping the reviewed local name', async () => {
    const { user, stub } = await renderRemote()

    await user.click(within(sidebar()).getByRole('button', { name: '检出远程分支 origin/feature/report' }))
    await waitFor(() => {
      expect(stub.prepareRemoteBranch).toHaveBeenCalledWith('checkout', 'refs/remotes/origin/feature/report', undefined)
    })
    const panel = within(contextPanel())
    expect(panel.getByRole('heading', { name: '检出远程跟踪分支' })).toBeInTheDocument()
    expect(panel.getByLabelText('本地分支名')).toHaveValue('feature/report')
    expect(contextPanel().querySelector('.planned-command')).toHaveTextContent('git switch --track -c feature/report origin/feature/report')

    await user.click(panel.getByRole('button', { name: '确认检出并跟踪' }))
    await waitFor(() => {
      expect(stub.executeRemoteBranch).toHaveBeenCalledWith('checkout', 'refs/remotes/origin/feature/report', 'feature/report', 'op-checkout')
    })
    expect(await screen.findByText(/已检出并跟踪/)).toBeInTheDocument()
  })

  it('drops the reviewed plan when the local branch name changes', async () => {
    const { user, stub } = await renderRemote()
    await user.click(within(sidebar()).getByRole('button', { name: '检出远程分支 origin/feature/report' }))
    const panel = within(contextPanel())
    await screen.findByRole('button', { name: '确认检出并跟踪' })
    await user.type(panel.getByLabelText('本地分支名'), '-copy')

    await waitFor(() => {
      expect(panel.queryByRole('button', { name: '确认检出并跟踪' })).toBeNull()
    })
    expect(contextPanel().querySelector('.planned-command')).toBeNull()
    // 重新预览时带上新的本地分支名。
    await user.click(panel.getByRole('button', { name: '预览命令' }))
    await waitFor(() => {
      expect(stub.prepareRemoteBranch).toHaveBeenLastCalledWith('checkout', 'refs/remotes/origin/feature/report', 'feature/report-copy')
    })
  })

  it('shows the block reason when a local branch with the same name exists', async () => {
    const reason = '本地已存在同名分支「feature/report」。请换一个本地分支名，或先切换到该分支再设置上游。'
    const { user } = await renderRemote({
      prepareRemoteBranch: vi.fn(async () => ({ ok: false, blocked: true, reason, plan: null })),
    })
    await user.click(within(sidebar()).getByRole('button', { name: '检出远程分支 origin/feature/report' }))

    expect(await within(contextPanel()).findByRole('alert')).toHaveTextContent(reason)
    expect(within(contextPanel()).queryByRole('button', { name: '确认检出并跟踪' })).toBeNull()
  })

  it('sets the upstream of the current branch and reports the saved relation', async () => {
    const { user, stub } = await renderRemote()
    await user.click(within(sidebar()).getByRole('button', { name: '把 origin/main 设为当前分支上游' }))
    await waitFor(() => {
      expect(stub.prepareRemoteBranch).toHaveBeenCalledWith('set-upstream', 'refs/remotes/origin/main')
    })
    const panel = within(contextPanel())
    expect(panel.getByRole('heading', { name: '设置上游分支' })).toBeInTheDocument()
    expect(contextPanel().querySelector('.planned-command')).toHaveTextContent('git branch --set-upstream-to origin/main main')

    await user.click(panel.getByRole('button', { name: '确认设置上游' }))
    await waitFor(() => {
      expect(stub.executeRemoteBranch).toHaveBeenCalledWith('set-upstream', 'refs/remotes/origin/main', undefined, 'op-upstream')
    })
    expect(await screen.findByText('已设置上游：origin/main。')).toBeInTheDocument()
  })
})

describe('first push with upstream in the workbench (rendered)', () => {
  it('previews the local branch, the push target and the target ref before pushing', async () => {
    const { user, stub } = await renderRemote()
    await user.click(within(sidebar()).getByRole('button', { name: '首次推送并设置上游…' }))
    await waitFor(() => {
      expect(stub.prepareFirstPush).toHaveBeenCalledWith({})
    })

    const panel = within(contextPanel())
    expect(panel.getByRole('heading', { name: '首次推送并设置上游' })).toBeInTheDocument()
    // 三个值必须在预览里明确显示。
    expect(panel.getByText('本地分支')).toBeInTheDocument()
    expect(panel.getByText('main')).toBeInTheDocument()
    expect(panel.getByText('推送目标')).toBeInTheDocument()
    expect(panel.getByText('目标引用')).toBeInTheDocument()
    expect(panel.getByText('refs/heads/main')).toBeInTheDocument()
    expect(contextPanel().querySelector('.planned-command')).toHaveTextContent('git push --set-upstream origin main:refs/heads/main')

    await user.click(panel.getByRole('button', { name: '确认首次推送并设置上游' }))
    await waitFor(() => {
      expect(stub.executeFirstPush).toHaveBeenCalledWith({}, 'op-first-push')
    })
    expect(await screen.findByText('已推送并设置上游：origin/main。')).toBeInTheDocument()
  })

  it('keeps the task open with the failure reason when Git rejects the push', async () => {
    const { user } = await renderRemote({
      executeFirstPush: vi.fn(async () => ({ ok: false, execution: { ok: false }, reason: 'Git 拒绝了这次推送，请查看命令账本中的真实命令与错误输出。' })),
    })
    await user.click(within(sidebar()).getByRole('button', { name: '首次推送并设置上游…' }))
    const panel = within(contextPanel())
    await user.click(await panel.findByRole('button', { name: '确认首次推送并设置上游' }))

    expect(await panel.findByRole('alert')).toHaveTextContent('Git 拒绝了这次推送')
    // 预览是一次性的：失败后计划清空，必须重新预览才能再确认。
    expect(panel.queryByRole('button', { name: '确认首次推送并设置上游' })).toBeNull()
    expect(screen.getByRole('heading', { name: '首次推送并设置上游' })).toBeInTheDocument()
  })
})
