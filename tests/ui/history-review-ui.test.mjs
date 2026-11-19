// @vitest-environment jsdom
//
// 真渲染断言：历史审查模式的筛选表单、提交列表、Inspector 与比较流程都在真实
// 组件树上验证；底层服务（`electron/repository-service.cjs`）的接线由
// tests/integration/history-review.integration.test.cjs 用真实 git 仓库覆盖。
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { intentLabel } from '../../src/workbench-ledger.js'
import { renderApp } from '../support/render-app.mjs'
import {
  commitDetailFixture,
  commitFixture,
  ledgerRecordFixture,
  minutesAgo,
  repositoryState,
  unifiedDiff,
} from '../support/gitglass-fixtures.mjs'

const HEAD_COMMIT = commitFixture({
  hash: '1111111111111111111111111111111111111111',
  shortHash: '1111111',
  subject: '修复暂存勾选与 Diff 选中互相污染',
  refs: ['HEAD -> main'],
  authoredAt: minutesAgo(3),
})
const PREVIOUS_COMMIT = commitFixture({
  hash: '2222222222222222222222222222222222222222',
  shortHash: '2222222',
  subject: '补上账本的耗时列',
  parents: ['3333333333333333333333333333333333333333'],
  authoredAt: minutesAgo(90),
})

function historyStub(overrides = {}) {
  return {
    getState: async () => repositoryState(),
    getBranches: async () => ({
      branches: [
        { name: 'main', current: true },
        { name: 'release/0.6' },
      ],
    }),
    getCommits: vi.fn(async () => ({ commits: [HEAD_COMMIT, PREVIOUS_COMMIT] })),
    queryHistory: vi.fn(async () => ({ commits: [HEAD_COMMIT] })),
    getCommitDetail: vi.fn(async (hash) =>
      commitDetailFixture({
        hash,
        changedFiles: [
          { status: 'M', path: 'src/main.jsx' },
          { status: 'A', path: 'docs/design.md' },
        ],
      }),
    ),
    getCommitDiff: vi.fn(async () => ({ ok: true, diff: unifiedDiff() })),
    compareCommits: vi.fn(async () => ({ ok: true, diff: unifiedDiff() })),
    getLedger: async () => [],
    getRecentRepositories: async () => [],
    getRemoteOverview: async () => ({
      ok: true,
      remotes: ['origin'],
      remote: { name: 'origin', url: 'https://example.com/demo-repo.git' },
      upstream: null,
      ahead: 0,
      behind: 0,
    }),
    ...overrides,
  }
}

// 挂载 → 等首屏 → 切到历史审查模式。
async function renderHistory(overrides = {}) {
  const stub = historyStub(overrides)
  const view = renderApp(stub)
  const user = userEvent.setup()
  await waitFor(() => {
    expect(screen.getByRole('button', { name: '工作区' })).toBeInTheDocument()
  })
  await user.click(screen.getByRole('button', { name: '历史审查' }))
  await waitFor(() => {
    expect(screen.getByRole('textbox', { name: '搜索提交历史' })).toBeInTheDocument()
  })
  return { ...view, stub, user }
}

// 把两条提交都放进双提交比较（base 是较早的 PREVIOUS_COMMIT）。
async function pinBothCommits(user) {
  await user.click(screen.getByRole('button', { name: `将提交 ${HEAD_COMMIT.shortHash} 加入双提交比较` }))
  await user.click(screen.getByRole('button', { name: `将提交 ${PREVIOUS_COMMIT.shortHash} 加入双提交比较` }))
  await waitFor(() => {
    expect(screen.getByRole('button', { name: '交换基准提交与对比提交' })).toBeInTheDocument()
  })
}

describe('history review UI (rendered)', () => {
  it('offers a query form with the result count, shortcut hint and an explicit apply step', async () => {
    const { stub, user, container } = await renderHistory()

    const search = screen.getByRole('textbox', { name: '搜索提交历史' })
    expect(search).toHaveAttribute('aria-keyshortcuts', 'Control+F')
    expect(search.getAttribute('placeholder')).toContain('Ctrl F')
    expect(await screen.findByText('共 2 个提交')).toBeInTheDocument()

    // 输入不会自己触发查询，必须点“应用筛选”。
    await user.type(search, 'picker')
    expect(stub.queryHistory).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '应用筛选' }))
    await waitFor(() => {
      expect(stub.queryHistory).toHaveBeenCalledTimes(1)
    })
    expect(stub.queryHistory).toHaveBeenCalledWith({
      keyword: 'picker',
      author: '',
      branch: '',
      filePath: '',
    })
    // 应用后：计数跟着新结果走，并显示已应用的筛选摘要。
    expect(await screen.findByText('共 1 个提交')).toBeInTheDocument()
    expect(container.querySelector('.history-filter-summary')).toHaveTextContent(
      '已应用：关键词：picker',
    )
  })

  it('focuses the search box on Ctrl+F and lets Esc clear the applied filter before leaving history mode', async () => {
    const { stub, user, container } = await renderHistory()
    const search = screen.getByRole('textbox', { name: '搜索提交历史' })

    await user.keyboard('{Control>}f{/Control}')
    expect(search).toHaveFocus()

    await user.type(search, 'picker')
    await user.click(screen.getByRole('button', { name: '应用筛选' }))
    await waitFor(() => {
      expect(container.querySelector('.history-filter-summary')).toBeInTheDocument()
    })

    // 焦点不在输入框里时按 Esc：先还原已应用的筛选（不是直接退出历史模式）。
    await user.click(screen.getByRole('heading', { name: '历史审查' }))
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(stub.getCommits).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(container.querySelector('.history-filter-summary')).toBeNull()
    })
    expect(screen.getByRole('textbox', { name: '搜索提交历史' })).toBeInTheDocument()

    // 再按一次 Esc：草稿与已应用一致了，才退出历史模式回到工作区。
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '工作区' })).toBeInTheDocument()
    })
    expect(screen.queryByRole('textbox', { name: '搜索提交历史' })).toBeNull()
  })

  it('renders two-line commit rows with relative time and a lightweight HEAD badge', async () => {
    await renderHistory()

    const row = screen.getByRole('button', { name: `查看提交 ${HEAD_COMMIT.subject}` })
    expect(row).toHaveAttribute('title', HEAD_COMMIT.subject)
    expect(within(row).getByText(HEAD_COMMIT.subject)).toBeInTheDocument()
    expect(within(row).getByText('HEAD')).toHaveClass('head-badge')
    expect(within(row).getByText(HEAD_COMMIT.shortHash)).toHaveAttribute('title', HEAD_COMMIT.hash)

    // 相对时间给人读，完整时间放在 title 里给需要精确时刻的人。
    const relative = within(row).getByText('3 分钟前')
    expect(relative).toHaveAttribute(
      'title',
      expect.stringContaining(String(new Date(HEAD_COMMIT.authoredAt).getFullYear())),
    )

    // 非 HEAD 提交没有徽标。
    const previous = screen.getByRole('button', { name: `查看提交 ${PREVIOUS_COMMIT.subject}` })
    expect(within(previous).queryByText('HEAD')).toBeNull()
  })

  it('shows the complete commit facts, clickable parents and change statistics in the inspector', async () => {
    const { user, container } = await renderHistory()

    await user.click(screen.getByRole('button', { name: `查看提交 ${HEAD_COMMIT.subject}` }))

    const facts = await waitFor(() => {
      const element = container.querySelector('.file-facts')
      expect(element).toBeInTheDocument()
      return element
    })
    expect([...facts.querySelectorAll('dt')].map((node) => node.textContent)).toEqual([
      '完整 SHA',
      '父提交',
      '作者',
      '邮箱',
      '时间',
    ])
    expect(facts).toHaveTextContent(HEAD_COMMIT.hash)
    expect(facts).toHaveTextContent('dev@example.com')
    // 父提交可点，能继续往上追。
    expect(
      within(facts).getByRole('button', { name: `查看父提交 ${HEAD_COMMIT.parents[0]}` }),
    ).toBeInTheDocument()

    const stats = container.querySelector('.commit-stats')
    expect(stats).toHaveTextContent('变更文件 2')
    expect(stats).toHaveTextContent('新增 +12')
    expect(stats).toHaveTextContent('删除 −3')

    expect(screen.getByText('完整提交说明')).toBeInTheDocument()
    expect(container.querySelector('pre.commit-message')).toHaveTextContent(
      '勾选集合改成 Set<area:path>',
    )
    expect(screen.getByRole('button', { name: '查看完整 Diff' })).toBeInTheDocument()
  })

  it('labels the initial commit instead of rendering an empty parent list', async () => {
    const { user } = await renderHistory({
      getCommits: vi.fn(async () => ({ commits: [commitFixture({ parents: [] })] })),
    })

    await user.click(screen.getByRole('button', { name: `查看提交 ${commitFixture().subject}` }))
    expect(await screen.findByText('初始提交（没有父提交）')).toBeInTheDocument()
  })

  it('labels change kinds with a letter and Chinese text, never colour alone', async () => {
    const { user, container } = await renderHistory()

    await user.click(screen.getByRole('button', { name: `查看提交 ${HEAD_COMMIT.subject}` }))
    await waitFor(() => {
      expect(container.querySelectorAll('.file-kind-tag')).toHaveLength(2)
    })
    expect([...container.querySelectorAll('.file-kind-tag')].map((node) => node.textContent.trim())).toEqual([
      'M 修改',
      '+ 新增',
    ])
    // 文件行按钮的 title 说明点下去会发生什么。
    const files = container.querySelector('.history-files')
    const historyFile = files.querySelector('button.history-file')
    expect(historyFile).toHaveAttribute('title', '查看 src/main.jsx 在此提交中的 Diff')
    expect(historyFile).toHaveTextContent('M 修改')
    expect(
      within(files).getByRole('button', { name: '查看 src/main.jsx 的文件历史' }),
    ).toBeInTheDocument()
  })

  it('guides the user to open a repository before the commit list can fill up', async () => {
    await renderHistory({ getState: async () => ({ ok: false, path: '', branch: '', files: [] }) })
    expect(await screen.findByText('打开仓库后可查看提交历史。')).toBeInTheDocument()
  })

  it('reports an applied filter with no matches and offers a reset', async () => {
    const { stub, user } = await renderHistory({
      getCommits: vi.fn(async () => ({ commits: [] })),
      queryHistory: vi.fn(async () => ({ commits: [] })),
    })

    await user.type(screen.getByRole('textbox', { name: '搜索提交历史' }), 'nothing-matches')
    await user.click(screen.getByRole('button', { name: '应用筛选' }))

    expect(await screen.findByText('当前筛选条件下没有匹配的提交。')).toBeInTheDocument()
    expect(screen.getByText('可以调整条件后再次应用，或重置筛选查看最近提交。')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重置筛选' }))
    await waitFor(() => {
      expect(stub.getCommits).toHaveBeenCalledTimes(2)
    })
  })

  it('explains a binary diff instead of printing unreadable content', async () => {
    const { user, container } = await renderHistory({
      compareCommits: vi.fn(async () => ({
        ok: true,
        binary: true,
        diff: 'diff --git a/public/logo.svg b/public/logo.svg\nBinary files a/public/logo.svg and b/public/logo.svg differ',
      })),
    })
    await pinBothCommits(user)
    await user.click(screen.getByRole('button', { name: '读取比较' }))

    // 二进制差异不打印乱码，而是给一句人话说明它为什么没有文本 Diff。
    expect(await screen.findByText('二进制文件差异')).toBeInTheDocument()
    expect(container).toHaveTextContent('Git 无法生成文本内容')
    // 比较结果顶部仍说明读取的方向。
    expect(container.querySelector('.history-notice')).toHaveTextContent(
      `比较方向「基准 → 对比」：${PREVIOUS_COMMIT.shortHash} → ${HEAD_COMMIT.shortHash}`,
    )
  })

  it('reports a failed comparison with a Chinese reason and a way back', async () => {
    const { user } = await renderHistory({
      compareCommits: vi.fn(async () => ({ ok: false, reason: '提交不存在或不是有效提交。' })),
    })
    await pinBothCommits(user)
    await user.click(screen.getByRole('button', { name: '读取比较' }))

    const failure = await waitFor(() => {
      const element = screen.getByRole('alert')
      expect(element).toBeInTheDocument()
      return element
    })
    expect(failure).toHaveTextContent('无法比较这两个提交')
    expect(failure).toHaveTextContent('提交不存在或不是有效提交。')
    expect(failure).toHaveTextContent('失败详情已作为系统读取记录在命令账本中。')
    expect(within(failure).getByRole('button', { name: '返回提交列表' })).toBeInTheDocument()
  })

  it('keeps the compare flow explicit: base, target, direction and swap', async () => {
    const { user, container } = await renderHistory()
    await pinBothCommits(user)

    const direction = () => container.querySelector('.compare-direction')
    // 较早的提交自动成为基准：方向永远读作「基准 → 对比」。
    expect(direction()).toHaveTextContent(
      `比较方向：${PREVIOUS_COMMIT.shortHash} → ${HEAD_COMMIT.shortHash}（基准 → 对比）`,
    )
    expect(container.querySelector('.compare-panel')).toHaveTextContent('双提交比较')

    await user.click(screen.getByRole('button', { name: '交换基准提交与对比提交' }))
    await waitFor(() => {
      expect(direction()).toHaveTextContent(
        `比较方向：${HEAD_COMMIT.shortHash} → ${PREVIOUS_COMMIT.shortHash}（基准 → 对比）`,
      )
    })

    await user.click(screen.getByRole('button', { name: '清除比较选择' }))
    await waitFor(() => {
      expect(direction()).toBeNull()
    })
  })

  it('keeps the commit detail cached while switching files and diffs', async () => {
    const { stub, user } = await renderHistory()

    await user.click(screen.getByRole('button', { name: `查看提交 ${HEAD_COMMIT.subject}` }))
    await waitFor(() => {
      expect(stub.getCommitDetail).toHaveBeenCalledTimes(1)
    })
    await user.click(screen.getByRole('button', { name: `查看提交 ${PREVIOUS_COMMIT.subject}` }))
    await waitFor(() => {
      expect(stub.getCommitDetail).toHaveBeenCalledTimes(2)
    })
    // 回到第一个提交：命中 detailCache，不再执行 Git 命令。
    await user.click(screen.getByRole('button', { name: `查看提交 ${HEAD_COMMIT.subject}` }))
    await waitFor(() => {
      expect(screen.getByText('完整提交说明')).toBeInTheDocument()
    })
    expect(stub.getCommitDetail).toHaveBeenCalledTimes(2)
    expect(stub.getCommitDetail).toHaveBeenLastCalledWith(PREVIOUS_COMMIT.hash)
  })

  it('maps the history intents to Chinese ledger labels', () => {
    // 账本第一行显示的是中文意图；映射由 src/workbench-ledger.js 提供。
    expect(intentLabel({ intent: 'Read commit detail and statistics', source: 'background' })).toBe('读取提交详情')
    expect(intentLabel({ intent: 'Read commit diff', source: 'background' })).toBe('读取提交差异')
    expect(intentLabel({ intent: 'Compare commits', source: 'background' })).toBe('比较两次提交')
    expect(intentLabel({ intent: 'Verify history commit', source: 'background' })).toBe('校验提交存在')
    expect(intentLabel({ intent: 'Verify tracked history file', source: 'background' })).toBe('校验文件是否被跟踪')
    // 没有映射时仍然按来源兜底，不会掉回英文意图。
    expect(intentLabel({ intent: 'Unknown intent', source: 'background' })).toBe('系统读取')
  })

  it('formats structured commit output into readable text before rendering the ledger', async () => {
    const structured = '修复暂存勾选与 Diff 选中互相污染\u001eGitGlass Dev\u001fdev@example.com'
    const { user, container } = await renderHistory({
      getLedger: async () => [ledgerRecordFixture({ stdout: structured })],
    })

    await user.click(screen.getByRole('button', { name: '命令账本' }))
    const output = await waitFor(() => {
      const element = container.querySelector('.ledger-details .output pre')
      expect(element).toBeInTheDocument()
      return element
    })
    // 0x1e 变成换行、0x1f 变成可读分隔符：页面上不允许出现方框或原始控制字符。
    expect(output).toHaveTextContent('修复暂存勾选与 Diff 选中互相污染')
    expect(output).toHaveTextContent('GitGlass Dev · dev@example.com')
    expect(output.textContent).not.toContain('\u001e')
    expect(output.textContent).not.toContain('\u001f')
    expect(output.textContent).not.toContain('\ufffd')
    // 原始 stdout 仍留在技术详情说明里，审计能力不丢。
    expect(container.querySelector('.tech-details')).toHaveTextContent('仍保留原始')
  })
})
