// @vitest-environment jsdom
//
// 真渲染断言：用假的 `window.gitglass` 桥挂载真实 <App />，断言渲染出来的 DOM、
// 可访问名称与交互结果，而不是断言 `src/main.jsx` 里出现了哪段源码字符串。
// 样式契约（CSS 声明本身）见 tests/ui/style-contracts.test.cjs。
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp } from '../support/render-app.mjs'
import {
  OTHER_REPOSITORY_PATH,
  REPOSITORY_PATH,
  commitFixture,
  fileFixture,
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

  it('keeps the selected file diff inside a scrolling diff view with review line numbers', async () => {
    const { container } = await renderWorkspace()

    // 中央只有一条标题：面包屑给路径，右侧给差异范围与文件状态，不再有第二行完整路径。
    const title = container.querySelector('.diff-title')
    expect(title).toHaveTextContent('src/main.jsx')
    expect(title).toHaveTextContent('未暂存差异')
    expect(title).toHaveTextContent('修改')
    expect(title.querySelector('h2')).toHaveTextContent('文件差异')
    expect(container.querySelector('.diff-meta')).toBeNull()
    expect(container.querySelector('.diff-content')).toBeInTheDocument()

    // 行号槽带读屏用的定位：删掉的那行只有原文件行号，新增的那行只有新文件行号。
    expect(screen.getByLabelText('原文件第 1 行')).toHaveTextContent('1')
    expect(screen.getByLabelText('新文件第 1 行')).toHaveTextContent('1')
    const view = container.querySelector('.diff-view')
    expect(view.querySelectorAll('.diff-line.plus')).toHaveLength(1)
    expect(view.querySelectorAll('.diff-line.minus')).toHaveLength(1)
  })

  it('drops the patch file header when the single-file title already carries the path', async () => {
    const { container } = await renderWorkspace()

    // 工作区普通单文件：标题里的面包屑已经指向同一个路径，patch 的文件头不再重复渲染。
    expect(container.querySelectorAll('.diff-line.file')).toHaveLength(0)
    expect(container.querySelector('.diff-content')).toHaveTextContent('const modern = true')
  })

  it('renders a rename as one「旧 → 新」breadcrumb row', async () => {
    const { container } = renderApp(workspaceStub({
      getState: async () => repositoryState({ files: [fileFixture({ path: 'src/old-name.js', status: 'renamed' })] }),
      getDiff: async () => ({
        ok: true,
        stdout: [
          'diff --git a/src/old-name.js b/src/new-name.js',
          'similarity index 96%',
          'rename from src/old-name.js',
          'rename to src/new-name.js',
          'index 1111111..2222222 100644',
          '--- a/src/old-name.js',
          '+++ b/src/new-name.js',
          '@@ -1 +1 @@',
          '-export function oldName() {',
          '+export function newName() {',
        ].join('\n'),
      }),
    }))

    const headers = await waitFor(() => {
      const rows = container.querySelectorAll('.diff-line.file')
      expect(rows).toHaveLength(1)
      return rows
    })
    expect(headers[0]).toHaveTextContent('src/old-name.js → src/new-name.js')
    // 重命名信息已经在面包屑里，不再单独渲染「重命名前 / 重命名后」两行。
    expect(container.querySelector('.diff-content')).not.toHaveTextContent('重命名前')
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
    // 摘要四要素：来源 · 意图 · 结果 · 时间。
    expect(glance.querySelector('.ledger-glance-source')).toHaveTextContent('用户执行')
    expect(glance.querySelector('.ledger-glance-text')).toHaveTextContent('暂存文件')
    expect(glance).toHaveTextContent('成功')
    expect(glance.querySelector('time')).toBeInTheDocument()
    // 收起态只给人话摘要：原始命令与 argv 只出现在展开后的技术详情里。
    expect(glance).not.toHaveTextContent('git add -- src/main.jsx')
    expect(glance).not.toHaveTextContent('"add"')
    expect(glance).toHaveAttribute('title', '最近：暂存文件 · 成功')
  })

  it('prefers the newest user action for the glance even when system reads arrived later', async () => {
    const { container } = await renderWorkspace({
      getLedger: async () => [
        ledgerRecordFixture({
          id: 'bg-latest',
          source: 'background',
          intent: 'Read working tree status',
          displayCommand: 'git status --porcelain=v1 -z',
          startedAt: new Date().toISOString(),
        }),
        ledgerRecordFixture({ id: 'user-older' }),
      ],
    })
    const glance = await waitFor(() => {
      const element = container.querySelector('.ledger-glance')
      expect(element).toBeInTheDocument()
      return element
    })
    expect(glance.querySelector('.ledger-glance-text')).toHaveTextContent('暂存文件')
    expect(glance.querySelector('.ledger-glance-source')).toHaveTextContent('用户执行')
    expect(glance).not.toHaveTextContent('读取工作区状态')
  })

  it('keeps the collapsed summary on the newest user action across filter switches and background refreshes', async () => {
    const user = userEvent.setup()
    // 场景复现：首次打开（只有系统读取）→ 切到「系统读取」→ 收起 → 暂存一个文件 → 外部 Git 刷新。
    let records = [
      ledgerRecordFixture({
        id: 'bg-initial',
        source: 'background',
        intent: 'Read working tree status',
        displayCommand: 'git status --porcelain=v1 -z',
        startedAt: new Date(Date.now() - 120_000).toISOString(),
      }),
    ]
    let files = [fileFixture({ path: 'src/main.jsx' })]
    let changeHandler = null
    const { container } = renderApp({
      ...workspaceStub(),
      getState: async () => repositoryState({ files }),
      getLedger: async () => records,
      onRepositoryChanged: (callback) => {
        changeHandler = callback
        return () => {}
      },
      operate: vi.fn(async () => {
        // 暂存成功：文件进入已暂存区，同时后台刷新写入了一条比用户操作更新的系统读取。
        files = [fileFixture({ path: 'src/main.jsx', area: 'staged' })]
        records = [
          ledgerRecordFixture({
            id: 'bg-after-stage',
            source: 'background',
            intent: 'Read working tree status',
            displayCommand: 'git status --porcelain=v1 -z',
            startedAt: new Date().toISOString(),
          }),
          ledgerRecordFixture({ id: 'user-stage', intent: 'Stage file', displayCommand: 'git add -- src/main.jsx' }),
        ]
        return { execution: { ok: true, argv: ['add', '--', 'src/main.jsx'] }, state: repositoryState({ files }) }
      }),
    })

    const ledgerToggle = () => screen.getByRole('button', { name: '命令账本' })
    const glance = () => container.querySelector('.ledger-glance')

    // 1. 还没有用户操作：摘要回退到最近的系统读取。
    await waitFor(() => {
      expect(glance()).toHaveTextContent('系统读取')
    })

    // 2. 展开 → 切到「系统读取」→ 收起。
    await user.click(ledgerToggle())
    await user.click(screen.getByRole('button', { name: /系统读取/ }))
    await user.click(ledgerToggle())
    expect(ledgerToggle()).toHaveAttribute('aria-expanded', 'false')

    // 3. 暂存一个文件：摘要必须指向刚完成的用户操作，而不是折叠前选中的系统读取。
    await user.click(screen.getByRole('button', { name: '暂存 src/main.jsx' }))
    await waitFor(() => {
      expect(glance()).toHaveTextContent('暂存文件')
    })
    expect(glance().querySelector('.ledger-glance-source')).toHaveTextContent('用户执行')
    expect(glance().querySelector('.ledger-glance-status')).toHaveTextContent('成功')
    // 普通操作完成后，账本保持折叠。
    expect(ledgerToggle()).toHaveAttribute('aria-expanded', 'false')

    // 4. 外部 Git 刷新（refs 变化穿过渲染层静默窗）：后台读取更新，摘要仍指向暂存。
    records = [
      ledgerRecordFixture({
        id: 'bg-external',
        source: 'background',
        intent: 'Read working tree status',
        displayCommand: 'git status --porcelain=v1 -z',
        startedAt: new Date(Date.now() + 1_000).toISOString(),
      }),
      ...records,
    ]
    await act(async () => {
      changeHandler({ reason: 'refs' })
    })
    await waitFor(() => {
      expect(container.querySelectorAll('.ledger-glance')).toHaveLength(1)
    })
    expect(glance()).toHaveTextContent('暂存文件')
    expect(glance()).not.toHaveTextContent('读取工作区状态')
    expect(ledgerToggle()).toHaveAttribute('aria-expanded', 'false')

    // 5. 点摘要：展开并切到这条记录对应的来源（用户操作）。
    await user.click(glance())
    expect(ledgerToggle()).toHaveAttribute('aria-expanded', 'true')
    expect(container.querySelector('.ledger-filter button.active')).toHaveTextContent(/用户操作/)
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

  it('replaces the dead commit graph with a purposeful empty state when the worktree is clean', async () => {
    const { container } = renderApp({
      ...workspaceStub(),
      getState: async () => repositoryState({ files: [] }),
      getLedger: async () => [],
    })

    const empty = await waitFor(() => {
      const element = container.querySelector('.workspace-empty')
      expect(element).toBeInTheDocument()
      return element
    })
    expect(empty).toHaveTextContent('工作区没有未提交的改动')
    expect(empty).toHaveTextContent('从左侧文件列表选择文件查看差异')
    expect(empty).toHaveTextContent('查看提交历史请切换到「历史审查」')

    const toolbar = container.querySelector('.main-toolbar')
    expect(toolbar.querySelector('h2')).toHaveTextContent('文件差异')
    expect(toolbar).toHaveTextContent('未选择文件')

    // 死区不再存在：既没有提交图，也没有点不动的 graph-row。
    expect(container.querySelector('.commit-graph')).toBeNull()
    expect(container.querySelectorAll('.graph-row')).toHaveLength(0)
  })

  it('selects the first changed file automatically after opening a repository', async () => {
    const user = userEvent.setup()
    // getState 跟随“当前仓库”：打开另一个仓库后，refreshAll 读到的就是新仓库的状态。
    let current = { path: REPOSITORY_PATH, files: [fileFixture({ path: 'src/main.jsx' })] }
    const { container } = renderApp({
      ...workspaceStub(),
      getState: async () => repositoryState({ path: current.path, files: current.files }),
      chooseRepository: async () => {
        current = { path: OTHER_REPOSITORY_PATH, files: [fileFixture({ path: 'README.md' })] }
        return { ok: true, path: current.path, state: repositoryState({ path: current.path, files: current.files }) }
      },
    })
    await waitFor(() => {
      expect(container.querySelector('.diff-content')).toBeInTheDocument()
    })

    const topbar = within(container.querySelector('header.topbar'))
    await user.click(topbar.getByRole('button', { name: '打开仓库' }))
    const diffTitle = await waitFor(() => {
      const element = container.querySelector('.diff-title')
      expect(element).toHaveTextContent('README.md')
      return element
    })
    expect(diffTitle).toHaveTextContent('未暂存差异')
    expect(screen.getByRole('button', { name: '选择文件 README.md' })).toBeInTheDocument()
  })

  it('offers the manual refresh command only while automatic refresh is unavailable', async () => {
    const user = userEvent.setup()
    const { container } = await renderWorkspace({
      getWatcherState: async () => ({ active: false }),
    })

    // 常驻 ⟳ 按钮已降级（#21 ①）：侧栏不再有「刷新状态」。
    expect(screen.queryByRole('button', { name: '刷新状态' })).toBeNull()
    // watcher 不可用：打开仓库即提示一次（#21 ②）。
    expect(await screen.findByText('自动刷新不可用（无法监视仓库变化），请从命令面板手动刷新。')).toBeInTheDocument()

    await user.click(within(container.querySelector('header.topbar')).getByRole('button', { name: '命令面板' }))
    const command = screen.getByRole('option', { name: '重新读取本地状态（不联网）' })
    expect(command).toBeEnabled()
  })

  it('keeps the manual refresh command out of the palette while automatic refresh works', async () => {
    const user = userEvent.setup()
    const { container } = await renderWorkspace()

    await user.click(within(container.querySelector('header.topbar')).getByRole('button', { name: '命令面板' }))
    expect(screen.queryByRole('option', { name: '重新读取本地状态（不联网）' })).toBeNull()
    // 两个入口的 title 区分（#21 ③）：「获取…」写明联网与先生成计划。
    expect(within(container.querySelector('header.topbar')).getByRole('button', { name: '获取远程更新（先查看计划）' }))
      .toHaveAttribute('title', '联网拉取远程更新（先生成计划，不会立即执行）')
  })

  it('keeps the commit form available next to the file inspector while a file is selected', async () => {
    const { container } = await renderWorkspace()
    const panel = container.querySelector('.context-panel')

    // 右栏固定两段：「当前文件」只影响这一个文件，「创建提交」影响整个暂存区。
    const sections = [...panel.querySelectorAll(':scope > section.inspector-flow')]
    expect(sections).toHaveLength(2)
    expect(within(sections[0]).getByRole('heading', { name: '当前文件' })).toBeInTheDocument()
    // 文件区的主标签是 basename，完整路径留在悬停提示与可访问名称里。
    expect(within(sections[0]).getByRole('heading', { name: 'main.jsx' })).toHaveAttribute('title', 'src/main.jsx')
    expect(within(sections[1]).getByRole('heading', { name: '创建提交' })).toBeInTheDocument()
    // 暂存区为空：当前文件的「暂存文件」才是唯一的实心动作。
    expect(within(sections[0]).getByRole('button', { name: '暂存文件' })).toHaveClass('primary-action')
    expect(within(sections[0]).getByRole('button', { name: '丢弃改动…' })).toHaveClass('text-action')
    // 可暂存的当前文件给出命令预览。
    expect(sections[0].querySelector('.command-preview')).toHaveTextContent('暂存命令预览')
    expect(sections[0].querySelector('.command-preview')).toHaveTextContent('git add -- src/main.jsx')

    const commit = within(sections[1]).getByRole('button', { name: '提交' })
    // 没有已暂存文件时提交不可用，但按钮本身必须在。
    expect(commit).toBeDisabled()
    expect(sections[1]).toHaveTextContent('已暂存 0 个文件')
    expect(sections[1]).toHaveTextContent('先暂存要提交的文件')
    expect(within(sections[1]).getByRole('button', { name: '暂存全部' })).toBeInTheDocument()
  })

  it('gives the commit button the staged count and explains why it is disabled', async () => {
    const staged = fileFixture({ path: 'docs/quickstart.md', area: 'staged' })
    const { container } = renderApp({
      ...workspaceStub(),
      getState: async () => repositoryState({ files: [fileFixture({ path: 'src/main.jsx' }), staged] }),
    })

    const panel = await waitFor(() => {
      const element = container.querySelector('.context-panel')
      expect(element).toBeInTheDocument()
      return element
    })
    // 暂存区已有文件：提交按钮就位但说明为空，禁用原因写成可见文字。
    const commit = await within(panel).findByRole('button', { name: '提交 1 个文件' })
    expect(commit).toBeDisabled()
    expect(panel).toHaveTextContent('已暂存 1 个文件')
    expect(panel).toHaveTextContent('填写提交说明后即可提交')
    // 单文件暂存降级为描边按钮：页面上只有一个高权重常规动作。
    expect(within(panel).getByRole('button', { name: '暂存文件' })).toHaveClass('secondary-action')
  })

  it('shows the file name as the primary label and disambiguates duplicates by directory', async () => {
    const { container } = renderApp({
      ...workspaceStub(),
      getState: async () => repositoryState({
        files: [
          fileFixture({ path: 'src/settings/configuration.ts' }),
          fileFixture({ path: 'test/settings/configuration.ts' }),
          fileFixture({ path: 'docs/quickstart.md', area: 'staged' }),
        ],
      }),
    })

    const rows = await waitFor(() => {
      const found = container.querySelectorAll('.file-row')
      expect(found.length).toBe(3)
      return [...found]
    })
    const [first, second, third] = rows
    // 主标签只有 basename；同名文件补最短可区分的父目录尾段。
    expect(first.querySelector('.file-name')).toHaveTextContent('configuration.ts')
    expect(first.querySelector('.file-dir')).toHaveTextContent('src/settings/')
    expect(second.querySelector('.file-name')).toHaveTextContent('configuration.ts')
    expect(second.querySelector('.file-dir')).toHaveTextContent('test/settings/')
    // 没有冲突的文件不显示目录，完整路径留在悬停提示里。
    expect(third.querySelector('.file-dir')).toBeNull()
    expect(third.querySelector('.file-select')).toHaveAttribute('title', 'docs/quickstart.md')
    // 状态符号在行尾，且读屏不重复朗读（由可访问名称承载完整路径）。
    expect(first.querySelector('.status')).toHaveTextContent('M')
    expect(first.querySelector('.status')).toHaveAttribute('aria-hidden', 'true')
  })

  it('shows a guide block instead of the commit form when no repository is open', async () => {
    const user = userEvent.setup()
    // 默认假桥就是「还没有打开仓库」：getState 返回 ok:false。
    const { container, gitglass } = renderApp()
    const panel = container.querySelector('.context-panel')
    expect(panel).toBeInTheDocument()

    // 右栏给引导块，而不是一整套全禁用的提交表单。
    expect(within(panel).getByRole('heading', { name: '还没有打开仓库' })).toBeInTheDocument()
    expect(panel.querySelector('textarea')).toBeNull()
    expect(within(panel).queryByRole('button', { name: '提交' })).toBeNull()
    expect(within(panel).queryByText('下一条命令')).toBeNull()

    // 引导块的「打开仓库」复用同一个目录选择入口（主按钮仍只有左栏那一个）。
    await user.click(within(panel).getByRole('button', { name: '打开仓库' }))
    expect(gitglass.chooseRepository).toHaveBeenCalledTimes(1)
  })
})
