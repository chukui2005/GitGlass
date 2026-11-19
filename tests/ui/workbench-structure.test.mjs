// @vitest-environment jsdom
//
// 真渲染断言：用假的 `window.gitglass` 桥挂载真实 <App />，断言渲染出来的 DOM、
// 可访问名称与交互结果，而不是断言 `src/main.jsx` 里出现了哪段源码字符串。
// 样式契约（CSS 声明本身）见 tests/ui/style-contracts.test.cjs。
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp } from '../support/render-app.mjs'
import {
  commitFixture,
  ledgerRecordFixture,
  repositoryState,
  unifiedDiff,
} from '../support/gitglass-fixtures.mjs'

// 一个“已打开仓库、有改动、有一条命令记录”的工作区。
function workspaceStub(overrides = {}) {
  return {
    getState: async () => repositoryState(),
    getBranches: async () => ({
      branches: [
        { name: 'main', current: true },
        { name: 'feature/ledger' },
      ],
    }),
    getCommits: async () => ({ commits: [commitFixture()] }),
    getRemoteOverview: async () => ({
      ok: true,
      remotes: ['origin'],
      remote: { name: 'origin', url: 'https://example.com/demo-repo.git' },
      upstream: null,
      ahead: 0,
      behind: 0,
    }),
    getDiff: async () => ({ ok: true, stdout: unifiedDiff() }),
    getLedger: async () => [ledgerRecordFixture()],
    getRecentRepositories: async () => [],
    ...overrides,
  }
}

// 等到首屏 effect 全部落地：未暂存列表渲染出来，且中央工作区已经有差异内容。
async function renderWorkspace(overrides = {}) {
  const view = renderApp(workspaceStub(overrides))
  await waitFor(() => {
    expect(screen.getByRole('button', { name: '选择文件 src/main.jsx' })).toBeInTheDocument()
  })
  await waitFor(() => {
    expect(view.container.querySelector('.diff-content')).toBeInTheDocument()
  })
  return view
}

async function expandLedger(user, container) {
  await user.click(screen.getByRole('button', { name: '命令账本' }))
  await waitFor(() => {
    expect(container.querySelector('.ledger-list')).toBeInTheDocument()
  })
  return container.querySelector('.ledger-list')
}

describe('workbench structure (rendered)', () => {
  it('renders the left, center and right panes in order, with the top bar above and the ledger below', async () => {
    const { container } = await renderWorkspace()

    const workspace = container.querySelector('#workspace-main')
    expect(workspace).toHaveClass('workspace')
    expect(
      [...workspace.children].map((child) => child.className.split(' ')[0]),
    ).toEqual([
      'status-panel',
      'panel-splitter',
      'main-panel',
      'panel-splitter',
      'context-panel',
    ])

    // 三栏的容器是 .app-shell；顶栏与命令账本是它的直接子节点，不在任何一栏里。
    const shell = container.querySelector('.app-shell')
    expect(shell.querySelector(':scope > header.topbar')).toBeInTheDocument()
    expect(shell.querySelector(':scope > section.command-ledger')).toBeInTheDocument()
    expect(workspace.contains(shell.querySelector('header.topbar'))).toBe(false)
    expect(workspace.contains(shell.querySelector('section.command-ledger'))).toBe(false)
  })

  it('keeps the selected file diff inside a two-row diff view with review line numbers', async () => {
    const { container } = await renderWorkspace()

    const view = container.querySelector('.diff-view')
    expect(view.querySelector('.diff-meta')).toHaveTextContent('工作区差异')
    expect(view.querySelector('.diff-meta')).toHaveTextContent('src/main.jsx')
    expect(view.querySelector('.diff-content')).toBeInTheDocument()

    // 行号槽带读屏用的定位：删掉的那行只有原文件行号，新增的那行只有新文件行号。
    expect(screen.getByLabelText('原文件第 1 行')).toHaveTextContent('1')
    expect(screen.getByLabelText('新文件第 1 行')).toHaveTextContent('1')
    expect(view.querySelectorAll('.diff-line.plus')).toHaveLength(1)
    expect(view.querySelectorAll('.diff-line.minus')).toHaveLength(1)
  })

  it('keeps the ledger bar outside of the only scrolling ledger list', async () => {
    const user = userEvent.setup()
    const { container } = await renderWorkspace()
    const list = await expandLedger(user, container)

    const ledger = container.querySelector('section.command-ledger')
    expect(ledger).toHaveAccessibleName('命令账本')
    const bar = ledger.querySelector('.ledger-bar')
    expect(bar).toBeInTheDocument()
    expect(bar.contains(list)).toBe(false)
    expect(ledger.querySelector('.ledger-body').contains(list)).toBe(true)
    expect(screen.getByRole('button', { name: '命令账本' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('keeps the collapsed ledger glance on one line and never shows the raw command there', async () => {
    const { container } = await renderWorkspace()

    const glance = await waitFor(() => {
      const element = container.querySelector('.ledger-glance')
      expect(element).toBeInTheDocument()
      return element
    })
    expect(glance).toHaveTextContent('最近：暂存文件')
    expect(glance).toHaveTextContent('成功')
    expect(glance.querySelector('.ledger-glance-text')).toHaveTextContent('最近：暂存文件')
    // 收起态只给人话摘要：原始命令与 argv 只出现在展开后的技术详情里。
    expect(glance).not.toHaveTextContent('git add -- src/main.jsx')
    expect(glance).not.toHaveTextContent('"add"')
    expect(glance).toHaveAttribute('title', '最近：暂存文件 · 成功')
  })

  it('explains a command record in Chinese and hides raw protocol fields in tech details', async () => {
    const user = userEvent.setup()
    const { container } = await renderWorkspace()
    await expandLedger(user, container)

    const details = await waitFor(() => {
      const element = container.querySelector('.ledger-details')
      expect(element).toBeInTheDocument()
      return element
    })
    // 中文信息层级：操作 / 类型 / 工作目录 / 状态。
    const facts = details.querySelector('.ledger-facts')
    expect([...facts.querySelectorAll('dt')].map((node) => node.textContent)).toEqual([
      '操作',
      '类型',
      '工作目录',
      '状态',
    ])
    expect(details).toHaveTextContent('实际执行命令')
    expect(details).toHaveTextContent('git add -- src/main.jsx')

    // 输出区标题是中文，且只在真有内容时渲染。
    expect(details.querySelector('.output-heading')).toHaveTextContent('命令结果')
    expect(details).not.toHaveTextContent('（无输出）')
    expect(details.querySelector('[title="stdout"]')).toBeNull()
    expect(details.querySelector('[title="stderr"]')).toBeNull()
    // 空 stderr 不渲染诊断信息。
    expect(details).not.toHaveTextContent('诊断信息')

    // argv 与退出代码在默认折叠的技术详情里，审计能力还在。
    const tech = details.querySelector('details.tech-details')
    expect(tech).toBeInTheDocument()
    expect(tech).not.toHaveAttribute('open')
    expect(tech.querySelector('summary')).toHaveTextContent('技术详情')
    expect(tech).toHaveTextContent('argv')
    expect(tech).toHaveTextContent('"add"')
    expect(tech).toHaveTextContent('原始输出')
    expect(tech).toHaveTextContent('仍保留原始')
  })

  it('gives each expanded ledger record two lines: intent plus command, then result metadata', async () => {
    const user = userEvent.setup()
    const { container } = await renderWorkspace()
    await expandLedger(user, container)

    const summary = await waitFor(() => {
      const element = container.querySelector('.ledger-summary')
      expect(element).toBeInTheDocument()
      return element
    })
    expect(summary).toHaveAttribute('aria-expanded', 'true')

    // 第一行：意图 + 等宽命令；命令单行省略，全文放在 title 里。
    const line = summary.querySelector('.ledger-entry-line')
    expect(line.querySelector('.ledger-intent')).toHaveTextContent('暂存文件')
    const command = line.querySelector('code.ledger-command')
    expect(command).toHaveTextContent('git add -- src/main.jsx')
    expect(command).toHaveAttribute('title', 'git add -- src/main.jsx')

    // 第二行：结果 · 退出码 · 耗时 · 时间 · 来源。
    const meta = summary.querySelector('.ledger-entry-meta')
    expect(meta).toHaveTextContent('成功')
    expect(meta).toHaveTextContent('退出码 0')
    expect(meta).toHaveTextContent('耗时 1.2s')
    expect(meta.querySelector('time')).toHaveAttribute('datetime')
    expect(meta).toHaveTextContent('用户执行')

    // 收起后详情消失，aria-expanded 回到 false。
    await user.click(summary)
    await waitFor(() => {
      expect(container.querySelector('.ledger-details')).toBeNull()
    })
    expect(summary).toHaveAttribute('aria-expanded', 'false')
  })

  it('names every top bar action for assistive tech and reflects the active mode', async () => {
    const user = userEvent.setup()
    const { container } = await renderWorkspace()
    const topbar = within(container.querySelector('header.topbar'))

    for (const name of [
      '检查更新',
      '命令面板',
      '工作区',
      '历史审查',
      '恢复',
      '打开仓库',
      '获取远程更新（先查看计划）',
    ]) {
      expect(topbar.getByRole('button', { name }), name).toBeInTheDocument()
    }

    // 当前模式用 aria-pressed 表达，而不是靠颜色。
    expect(topbar.getByRole('button', { name: '工作区' })).toHaveAttribute('aria-pressed', 'true')
    expect(topbar.getByRole('button', { name: '历史审查' })).toHaveAttribute('aria-pressed', 'false')

    await user.click(topbar.getByRole('button', { name: '历史审查' }))
    await waitFor(() => {
      expect(topbar.getByRole('button', { name: '历史审查' })).toHaveAttribute('aria-pressed', 'true')
    })
    expect(topbar.getByRole('button', { name: '工作区' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('shows the clean workspace and the commit form when nothing is changed', async () => {
    renderApp({
      ...workspaceStub(),
      getState: async () => repositoryState({ files: [] }),
      getLedger: async () => [],
    })

    await waitFor(() => {
      // 未暂存区的空态与下方的 clean-state 各渲染一次同样的说明。
      expect(screen.getAllByText('工作区干净，没有待暂存的改动。')).toHaveLength(2)
    })
    expect(screen.getByRole('heading', { name: '创建提交' })).toBeInTheDocument()
    // “暂存全部”能力仍在，只是没有未暂存文件时禁用。
    expect(screen.getByRole('button', { name: '暂存全部' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '提交' })).toBeDisabled()
    // 没有命令记录时，收起态显示“尚无命令记录”。
    await waitFor(() => {
      expect(screen.getByText('尚无命令记录')).toBeInTheDocument()
    })
  })
})
