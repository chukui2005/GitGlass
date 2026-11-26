// @vitest-environment jsdom
//
// v0.6.10 PR 1「克隆并打开」的真渲染断言：三个入口、预览 → 执行两步、输入改动后
// 计划作废、失败时保留原仓库上下文。真实 Git 克隆在
// tests/integration/clone-repository.integration.test.cjs 里验收。
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp } from '../support/render-app.mjs'
import { OTHER_REPOSITORY_PATH, repositoryState } from '../support/gitglass-fixtures.mjs'

const CLONE_PLAN = {
  ok: true,
  blocked: false,
  source: { kind: 'path', value: 'C:/mirrors/demo.git' },
  parent: 'C:/work',
  name: 'demo',
  target: 'C:/work/demo',
  existingEmpty: false,
  plan: {
    phase: 'planned',
    operationId: 'op-clone-1',
    intent: 'Clone repository',
    argv: ['clone', '--', 'C:/mirrors/demo.git', 'demo'],
    displayCommand: 'git clone -- C:/mirrors/demo.git demo',
    cwd: 'C:/work',
  },
}

function cloneStub(overrides = {}) {
  return {
    getState: vi.fn(async () => repositoryState({ files: [] })),
    getLedger: vi.fn(async () => []),
    getCommits: vi.fn(async () => ({ commits: [] })),
    getBranches: vi.fn(async () => ({ branches: [] })),
    chooseCloneTarget: vi.fn(async () => ({ canceled: false, path: 'C:/work' })),
    prepareClone: vi.fn(async () => CLONE_PLAN),
    ...overrides,
  }
}

async function openCloneDialog(overrides = {}) {
  const view = renderApp(cloneStub(overrides))
  const user = userEvent.setup()
  // 顶栏入口与「打开仓库」同组：这就是首屏的同一个克隆入口。
  await user.click(await screen.findByRole('button', { name: '克隆仓库' }))
  const dialog = await screen.findByRole('dialog', { name: '克隆仓库' })
  return { ...view, user, dialog, stub: view.gitglass }
}

async function fillRequest(user, dialog, { source = 'C:/mirrors/demo.git', parent = 'C:/work', name = '' } = {}) {
  await user.type(within(dialog).getByLabelText('仓库地址'), source)
  await user.type(within(dialog).getByLabelText('目标位置'), parent)
  if (name) await user.type(within(dialog).getByLabelText('仓库文件夹名（可选）'), name)
}

describe('clone repository entries (rendered)', () => {
  it('offers the same clone entry on the empty workspace, in the top bar and in the command palette', async () => {
    const { container } = renderApp({ getState: vi.fn(async () => ({ ok: false, path: '', branch: '', files: [] })), getLedger: vi.fn(async () => []) })
    const user = userEvent.setup()

    // 顶栏：与「打开仓库」同一组。
    const topbar = within(container.querySelector('header.topbar'))
    expect(topbar.getByRole('button', { name: '克隆仓库' })).toBeInTheDocument()
    // 首屏左栏空态。
    const emptyRepo = container.querySelector('.empty-repo')
    expect(within(emptyRepo).getByRole('button', { name: '克隆仓库' })).toBeInTheDocument()
    // 右栏引导块。
    const panel = container.querySelector('.context-panel')
    expect(within(panel).getByRole('button', { name: '克隆仓库' })).toBeInTheDocument()

    // 命令面板里也能搜到（「克隆」是关键词）。
    await user.click(topbar.getByRole('button', { name: '命令面板' }))
    const palette = await screen.findByRole('dialog', { name: '命令面板' })
    const search = within(palette).getByRole('textbox', { name: '搜索命令' })
    await user.type(search, '克隆')
    await user.click(within(palette).getByRole('option', { name: /克隆仓库/ }))
    expect(await screen.findByRole('dialog', { name: '克隆仓库' })).toBeInTheDocument()
  })

  it('shows the reviewed target directory and the real command before running anything', async () => {
    const { user, dialog, stub } = await openCloneDialog()
    await fillRequest(user, dialog)

    await user.click(within(dialog).getByRole('button', { name: '预览克隆' }))

    // 预览阶段只读计划，不执行任何 Git 命令。
    expect(stub.prepareClone).toHaveBeenCalledWith({ source: 'C:/mirrors/demo.git', parent: 'C:/work', name: '' })
    expect(stub.executeClone).not.toHaveBeenCalled()
    expect(await within(dialog).findByText('最终目录')).toBeInTheDocument()
    expect(dialog.querySelector('.clone-target-path')).toHaveTextContent('C:/work/demo')
    expect(within(dialog).getByText('计划执行（尚未运行）')).toBeInTheDocument()
    expect(dialog.querySelector('.planned-command')).toHaveTextContent('git clone -- C:/mirrors/demo.git demo')
    expect(within(dialog).getByText(/工作目录/)).toBeInTheDocument()
  })

  it('executes the reviewed plan and opens the cloned repository', async () => {
    let current = repositoryState({ files: [] })
    const { user, dialog, stub } = await openCloneDialog({
      getState: vi.fn(async () => current),
      executeClone: vi.fn(async () => {
        current = repositoryState({ path: OTHER_REPOSITORY_PATH, files: [] })
        return { ok: true, path: OTHER_REPOSITORY_PATH, state: current, target: 'C:/work/demo', execution: { ok: true, exitCode: 0 } }
      }),
    })
    await fillRequest(user, dialog)
    await user.click(within(dialog).getByRole('button', { name: '预览克隆' }))
    await user.click(await within(dialog).findByRole('button', { name: '开始克隆' }))

    await waitFor(() => {
      expect(stub.executeClone).toHaveBeenCalledWith({
        source: 'C:/mirrors/demo.git',
        parent: 'C:/work',
        name: '',
        operationId: 'op-clone-1',
      })
    })
    // 成功后走统一的「打开仓库」收尾：提示里给出真实路径，对话框收起。
    expect(await screen.findByText(`已克隆并打开仓库：${OTHER_REPOSITORY_PATH}`)).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '克隆仓库' })).toBeNull()
    })
    expect(stub.getRecentRepositories).toHaveBeenCalled()
  })

  it('drops the reviewed plan as soon as a field changes, so the confirmed command is the reviewed one', async () => {
    const { user, dialog } = await openCloneDialog()
    await fillRequest(user, dialog)
    await user.click(within(dialog).getByRole('button', { name: '预览克隆' }))
    await within(dialog).findByRole('button', { name: '开始克隆' })

    await user.type(within(dialog).getByLabelText('仓库文件夹名（可选）'), 'x')

    await waitFor(() => {
      expect(within(dialog).queryByRole('button', { name: '开始克隆' })).toBeNull()
    })
    expect(within(dialog).getByRole('button', { name: '预览克隆' })).toBeInTheDocument()
    expect(within(dialog).queryByText('计划执行（尚未运行）')).toBeNull()
  })

  it('fills the target position from the system picker', async () => {
    const { user, dialog, stub } = await openCloneDialog()
    await user.click(within(dialog).getByRole('button', { name: '选择目录…' }))
    await waitFor(() => {
      expect(stub.chooseCloneTarget).toHaveBeenCalledTimes(1)
    })
    expect(within(dialog).getByLabelText('目标位置')).toHaveValue('C:/work')
  })

  it('blocks an address with embedded credentials and keeps the dialog open for a new one', async () => {
    const reason = '地址中包含内嵌的用户名或令牌，GitGlass 不会执行或记录这类地址。请移除后重试；认证请使用本机 Git 凭据。'
    const { user, dialog, stub } = await openCloneDialog({
      prepareClone: vi.fn(async () => ({ ok: false, blocked: true, reason, plan: null, target: null })),
    })
    await fillRequest(user, dialog, { source: 'https://user:token@example.com/owner/repo.git' })
    await user.click(within(dialog).getByRole('button', { name: '预览克隆' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(reason)
    // 拒绝发生在主进程校验里：没有计划，也没有执行入口。
    expect(within(dialog).queryByRole('button', { name: '开始克隆' })).toBeNull()
    expect(stub.executeClone).not.toHaveBeenCalled()
    expect(within(dialog).getByLabelText('仓库地址')).toBeEnabled()
  })

  it('shows a real Git failure and leaves the previously opened repository in place', async () => {
    const reason = '认证失败：请确认本机 Git 已配置可用的凭据（凭据管理器或 SSH 密钥）。GitGlass 不会代你输入密码。'
    const { user, dialog, stub } = await openCloneDialog({
      executeClone: vi.fn(async () => ({ ok: false, target: 'C:/work/demo', plan: CLONE_PLAN.plan, execution: { ok: false, exitCode: 128 }, reason })),
    })
    await fillRequest(user, dialog)
    await user.click(within(dialog).getByRole('button', { name: '预览克隆' }))
    await user.click(await within(dialog).findByRole('button', { name: '开始克隆' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(reason)
    // 对话框留着（可以换地址重试），仓库上下文没有被切换。
    expect(screen.getByRole('dialog', { name: '克隆仓库' })).toBeInTheDocument()
    expect(screen.queryByText(/^已克隆并打开仓库/)).toBeNull()
    expect(stub.openRepository).not.toHaveBeenCalled()
  })

  it('closes without running anything when the user cancels', async () => {
    const { user, dialog, stub } = await openCloneDialog()
    await fillRequest(user, dialog)
    await user.click(within(dialog).getByRole('button', { name: '取消' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '克隆仓库' })).toBeNull()
    })
    expect(stub.prepareClone).not.toHaveBeenCalled()
    expect(stub.executeClone).not.toHaveBeenCalled()
  })

  it('drops a preview response that arrives after a field changed while it was pending', async () => {
    let resolvePrepare
    const pending = new Promise((resolve) => { resolvePrepare = resolve })
    const { user, dialog, stub } = await openCloneDialog({ prepareClone: vi.fn(() => pending) })
    await fillRequest(user, dialog)
    await user.click(within(dialog).getByRole('button', { name: '预览克隆' }))
    await waitFor(() => {
      expect(stub.prepareClone).toHaveBeenCalledTimes(1)
    })

    // The inputs stay editable while the plan is being read back.
    await user.type(within(dialog).getByLabelText('仓库文件夹名（可选）'), 'late')
    await act(async () => {
      resolvePrepare(CLONE_PLAN)
    })

    // The stale plan must never appear, so it cannot be confirmed either.
    await waitFor(() => {
      expect(within(dialog).queryByRole('button', { name: '开始克隆' })).toBeNull()
    })
    expect(within(dialog).queryByText('最终目录')).toBeNull()
    expect(within(dialog).queryByText('计划执行（尚未运行）')).toBeNull()
    expect(within(dialog).getByRole('button', { name: '预览克隆' })).toBeEnabled()
  })

  it('does not restore a plan when the response lands after closing and reopening the dialog', async () => {
    let resolvePrepare
    const pending = new Promise((resolve) => { resolvePrepare = resolve })
    const { user, dialog, stub } = await openCloneDialog({ prepareClone: vi.fn(() => pending) })
    await fillRequest(user, dialog)
    await user.click(within(dialog).getByRole('button', { name: '预览克隆' }))
    await waitFor(() => {
      expect(stub.prepareClone).toHaveBeenCalledTimes(1)
    })

    await user.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '克隆仓库' })).toBeNull()
    })

    // A new session starts clean, and the old response cannot fill it in afterwards.
    await user.click(screen.getByRole('button', { name: '克隆仓库' }))
    const reopened = await screen.findByRole('dialog', { name: '克隆仓库' })
    expect(within(reopened).getByLabelText('仓库地址')).toHaveValue('')
    await act(async () => {
      resolvePrepare(CLONE_PLAN)
    })

    await waitFor(() => {
      expect(within(reopened).queryByRole('button', { name: '开始克隆' })).toBeNull()
    })
    expect(within(reopened).queryByText('最终目录')).toBeNull()
    expect(within(reopened).getByRole('button', { name: '预览克隆' })).toBeDisabled()
  })
})
