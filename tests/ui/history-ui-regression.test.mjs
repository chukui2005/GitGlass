// @vitest-environment jsdom
//
// V0.4 工作区与 V0.5 历史模式共存的入口回归：真渲染后断言按钮、提示条与容器结构。
// 样式契约（`.main-content` 的 grid 行、`.history-view` 的滚动）见
// tests/ui/style-contracts.test.cjs。
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp } from '../support/render-app.mjs'
import { commitFixture, repositoryState, unifiedDiff } from '../support/gitglass-fixtures.mjs'

const REMOTE_OVERVIEW = {
  ok: true,
  remotes: ['origin'],
  remote: { name: 'origin', url: 'https://example.com/demo-repo.git' },
  upstream: null,
  ahead: 0,
  behind: 0,
}

function regressionStub(overrides = {}) {
  return {
    getState: async () => repositoryState(),
    getBranches: async () => ({ branches: [{ name: 'main', current: true }] }),
    getCommits: async () => ({ commits: [commitFixture()] }),
    getRemoteOverview: async () => REMOTE_OVERVIEW,
    getDiff: async () => ({ ok: true, stdout: unifiedDiff() }),
    getLedger: async () => [],
    getRecentRepositories: async () => [],
    ...overrides,
  }
}

async function renderRegression(overrides = {}) {
  const view = renderApp(regressionStub(overrides))
  const user = userEvent.setup()
  await waitFor(() => {
    expect(screen.getByRole('button', { name: '选择文件 src/main.jsx' })).toBeInTheDocument()
  })
  // 合并后的假桥：默认方法（例如 executeRemote）也在，才能断言“没有被调用”。
  return { ...view, stub: view.gitglass, user }
}

describe('workbench and history entry points (rendered)', () => {
  it('keeps the V0.4 entry points alongside the history mode entry', async () => {
    const { container } = await renderRegression()
    const topbar = within(container.querySelector('header.topbar'))

    for (const name of ['工作区', '历史审查', '恢复', '打开仓库', '命令面板']) {
      expect(topbar.getByRole('button', { name }), name).toBeInTheDocument()
    }
    // 「获取…」是可见文案，工具提示与可访问名称写明了它只生成计划。
    expect(topbar.getByRole('button', { name: '获取远程更新（先查看计划）' })).toHaveTextContent('获取…')

    // 侧栏两个分区、底部账本都在首屏上。
    expect(screen.getByText('未暂存改动')).toBeInTheDocument()
    expect(screen.getByText('已暂存改动')).toBeInTheDocument()
    expect(container.querySelector('section.command-ledger')).toHaveAccessibleName('命令账本')
  })

  it('makes the remote entry point announce that it only opens a plan', async () => {
    const { container, stub, user } = await renderRegression({
      prepareRemote: vi.fn(async () => ({
        overview: REMOTE_OVERVIEW,
        plan: { operationId: 'op-fetch-1', displayCommand: 'git fetch --prune origin' },
      })),
    })
    const topbar = within(container.querySelector('header.topbar'))

    await user.click(topbar.getByRole('button', { name: '获取远程更新（先查看计划）' }))
    expect(await screen.findByText('这一步不会执行任何命令。')).toBeInTheDocument()

    // 计划面板给出真实命令与确认入口；点「获取…」本身绝不执行 Git 命令。
    expect(stub.prepareRemote).toHaveBeenCalledWith('fetch')
    expect(stub.executeRemote).not.toHaveBeenCalled()
    expect(screen.getByText('计划执行（尚未运行）')).toBeInTheDocument()
    expect(container.querySelector('.planned-command')).toHaveTextContent('git fetch --prune origin')
    expect(screen.getByRole('button', { name: '确认获取远程更新' })).toBeInTheDocument()
    // 旧措辞「同步远程状态」不再出现在界面上。
    expect(screen.queryByText('同步远程状态')).toBeNull()
  })

  it('places the history notice and the scrolling history view inside main-content', async () => {
    const { container, user } = await renderRegression()
    await user.click(screen.getByRole('button', { name: '历史审查' }))

    const mainContent = await waitFor(() => {
      const element = container.querySelector('.main-content')
      expect(element).toBeInTheDocument()
      return element
    })
    expect(mainContent.querySelector('.history-notice')).toHaveAttribute('role', 'status')
    expect(mainContent.querySelector('.history-view')).toBeInTheDocument()
    // 提示条在滚动区之外：它是 main-content 的第一个子节点。
    expect(mainContent.firstElementChild).toHaveClass('history-notice')
    // 空提示条不占位成一条假消息。
    expect(mainContent.querySelector('.history-notice').textContent).toBe('')
  })
})
