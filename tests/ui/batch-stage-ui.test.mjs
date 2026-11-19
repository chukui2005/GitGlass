// @vitest-environment jsdom
//
// 真渲染断言：批量暂存的勾选、全选、计数与“暂存所选”的启用/禁用都在真实组件树
// 上验证，`operate('stageSelected', { paths })` 的载荷也直接断言。
// 服务端白名单与真实 `git add -- …` 语义由
// tests/integration/batch-stage.integration.test.cjs 用真实仓库覆盖。
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { intentLabel } from '../../src/workbench-ledger.js'
import { renderApp } from '../support/render-app.mjs'
import {
  OTHER_REPOSITORY_PATH,
  REPOSITORY_PATH,
  fileFixture,
  ledgerRecordFixture,
  repositoryState,
} from '../support/gitglass-fixtures.mjs'

const UNSTAGED = [fileFixture({ path: 'src/main.jsx' }), fileFixture({ path: 'docs/design.md' })]
const STAGED = fileFixture({ path: 'electron/main.cjs', area: 'staged' })

function batchState(overrides = {}) {
  return repositoryState({ files: [...UNSTAGED, STAGED], ...overrides })
}

async function renderBatch(overrides = {}) {
  const stub = {
    getState: async () => batchState(),
    getLedger: async () => [],
    getRecentRepositories: async () => [],
    ...overrides,
  }
  const view = renderApp(stub)
  const user = userEvent.setup()
  await waitFor(() => {
    expect(screen.getByRole('checkbox', { name: '选择暂存 src/main.jsx' })).toBeInTheDocument()
  })
  return { ...view, stub, user }
}

const checkbox = (path) => screen.getByRole('checkbox', { name: `选择暂存 ${path}` })

describe('batch stage UI (rendered)', () => {
  it('renders checkboxes only in the unstaged section, one per path', async () => {
    const { container } = await renderBatch()

    expect(screen.getAllByRole('checkbox').map((node) => node.getAttribute('aria-label'))).toEqual([
      '选择暂存 src/main.jsx',
      '选择暂存 docs/design.md',
    ])

    const sections = container.querySelectorAll('.file-section')
    expect(sections[0]).toHaveTextContent('未暂存改动')
    expect(within(sections[0]).getAllByRole('checkbox')).toHaveLength(2)
    expect(sections[1]).toHaveTextContent('已暂存改动')
    expect(within(sections[1]).queryAllByRole('checkbox')).toHaveLength(0)
  })

  it('selects all, clears the selection, and keeps a live count', async () => {
    const { user } = await renderBatch()

    expect(screen.getByText('已选择 0 个')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '全选未暂存' }))
    expect(checkbox('src/main.jsx')).toBeChecked()
    expect(checkbox('docs/design.md')).toBeChecked()
    expect(screen.getByText('已选择 2 个')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '清除选择' }))
    expect(checkbox('src/main.jsx')).not.toBeChecked()
    expect(checkbox('docs/design.md')).not.toBeChecked()
    expect(screen.getByText('已选择 0 个')).toBeInTheDocument()

    // 单条勾选也更新计数。
    await user.click(checkbox('docs/design.md'))
    expect(screen.getByText('已选择 1 个')).toBeInTheDocument()
  })

  it('explains the disabled primary action with visible text, not only the title', async () => {
    const { user } = await renderBatch()

    const stage = screen.getByRole('button', { name: '暂存所选 0 个' })
    expect(stage).toBeDisabled()
    expect(stage).toHaveAttribute('title', '先在上方勾选要暂存的文件')
    // 禁用原因同时是可见文字，不依赖 hover 才出现的 title。
    expect(screen.getByText('先在上方勾选要暂存的文件。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '清除选择' })).toBeDisabled()

    await user.click(checkbox('src/main.jsx'))
    expect(screen.queryByText('先在上方勾选要暂存的文件。')).toBeNull()
    expect(screen.getByRole('button', { name: '暂存所选 1 个' })).toHaveAttribute(
      'title',
      '将暂存所选 1 个文件',
    )
  })

  it('stages exactly the checked paths through one operate() call', async () => {
    const { stub, user } = await renderBatch({
      operate: vi.fn(async () => ({
        execution: { ok: true, argv: ['add', '--', 'src/main.jsx', 'docs/design.md'] },
        state: batchState(),
      })),
    })

    await user.click(checkbox('docs/design.md'))
    await user.click(checkbox('src/main.jsx'))
    await user.click(screen.getByRole('button', { name: '暂存所选 2 个' }))

    await waitFor(() => {
      expect(stub.operate).toHaveBeenCalledTimes(1)
    })
    // 逐条真实路径，绝不退化成 `git add .` / `git add -A`。
    expect(stub.operate).toHaveBeenCalledWith('stageSelected', {
      paths: ['src/main.jsx', 'docs/design.md'],
    })
  })

  it('keeps the batch selection independent from the diff selection', async () => {
    const { user } = await renderBatch()

    await user.click(checkbox('src/main.jsx'))
    // 切换右侧/中央的文件预览不应当清掉勾选。
    await user.click(screen.getByRole('button', { name: '选择文件 docs/design.md' }))
    await waitFor(() => {
      expect(screen.getByText(/已选择 1 个/)).toBeInTheDocument()
    })
    expect(checkbox('src/main.jsx')).toBeChecked()
    expect(screen.getByRole('button', { name: '选择文件 docs/design.md' })).toBeInTheDocument()
  })

  it('disables every control that mutates the staging area while an operation is running', async () => {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const { user } = await renderBatch({
      operate: vi.fn(async () => {
        await gate
        return { execution: { ok: true, argv: ['add', '--', 'src/main.jsx'] }, state: batchState() }
      }),
    })

    await user.click(checkbox('src/main.jsx'))
    await user.click(screen.getByRole('button', { name: '暂存所选 1 个' }))

    await waitFor(() => {
      expect(checkbox('src/main.jsx')).toBeDisabled()
    })
    expect(screen.getByRole('button', { name: '暂存所选 1 个' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '全选未暂存' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '清除选择' })).toBeDisabled()
    // 单文件行上的“暂存”同样禁用，加载期间不能半途改状态。
    // 注意：已暂存区目前没有接 `busy`（`<FileSection>` 只给未暂存区传了它），
    // 所以“取消暂存”按钮在加载期间仍可点——这是本次真渲染暴露出来的既有缺口，
    // 记在 PR 的后续项里，不用断言锁死当前行为。
    expect(screen.getByRole('button', { name: '暂存 src/main.jsx' })).toBeDisabled()

    release()
    await waitFor(() => {
      expect(checkbox('src/main.jsx')).not.toBeDisabled()
    })
  })

  it('drops ghost selections that no longer exist in the unstaged area', async () => {
    let files = [...UNSTAGED, STAGED]
    const { user } = await renderBatch({
      getState: async () => repositoryState({ files }),
      operate: vi.fn(async () => {
        // 暂存成功后：docs/design.md 离开了未暂存区（只剩 src/main.jsx）。
        files = [
          fileFixture({ path: 'src/main.jsx' }),
          fileFixture({ path: 'docs/design.md', area: 'staged' }),
          STAGED,
        ]
        return { execution: { ok: true, argv: ['add', '--', 'src/main.jsx'] }, state: repositoryState({ files }) }
      }),
    })

    await user.click(screen.getByRole('button', { name: '全选未暂存' }))
    expect(screen.getByText('已选择 2 个')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '暂存所选 2 个' }))

    await waitFor(() => {
      expect(screen.getByText('已选择 1 个')).toBeInTheDocument()
    })
    expect(checkbox('src/main.jsx')).toBeChecked()
    expect(screen.queryByRole('checkbox', { name: '选择暂存 docs/design.md' })).toBeNull()
  })

  it('clears the selection when the repository changes', async () => {
    let state = batchState()
    const { container, user } = await renderBatch({
      getState: async () => state,
      getRecentRepositories: async () => [
        { path: OTHER_REPOSITORY_PATH, name: 'another-repo', exists: true },
        { path: REPOSITORY_PATH, name: 'demo-repo', exists: true },
      ],
      openRepository: async (path) => {
        state = repositoryState({ path, files: [fileFixture({ path: 'README.md' })] })
        return { ok: true, path, state }
      },
    })

    await user.click(checkbox('src/main.jsx'))
    expect(screen.getByText('已选择 1 个')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '最近仓库' }))
    const entry = await waitFor(() => {
      const node = container.querySelector(`.recent-repository[title="${OTHER_REPOSITORY_PATH}"]`)
      expect(node).toBeInTheDocument()
      return node
    })
    await user.click(entry)

    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: '选择暂存 README.md' })).toBeInTheDocument()
    })
    // 换仓库后勾选集合清空：旧仓库的选择不能渗进新仓库。
    expect(screen.getByText('已选择 0 个')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: '选择暂存 src/main.jsx' })).toBeNull()
  })

  it('reports a partial batch result honestly instead of pretending it was atomic', async () => {
    const { container, user } = await renderBatch({
      operate: vi.fn(async () => ({
        execution: { ok: false, argv: ['add', '--', 'src/main.jsx', 'docs/design.md'] },
        state: batchState(),
      })),
    })

    await user.click(screen.getByRole('button', { name: '全选未暂存' }))
    await user.click(screen.getByRole('button', { name: '暂存所选 2 个' }))

    const notice = await waitFor(() => {
      const element = container.querySelector('.app-notice')
      expect(element).toBeInTheDocument()
      return element
    })
    expect(notice).toHaveTextContent('暂存未全部完成，请查看命令账本与当前文件状态。')
  })

  it('explains a locally rejected batch with the reason instead of a Git failure', async () => {
    const { container, user } = await renderBatch({
      operate: vi.fn(async () => ({
        execution: {
          ok: false,
          rejected: true,
          userMessage: '所选文件已不在未暂存区，请刷新后重试。',
        },
        state: batchState(),
      })),
    })

    await user.click(screen.getByRole('button', { name: '全选未暂存' }))
    await user.click(screen.getByRole('button', { name: '暂存所选 2 个' }))

    const notice = await waitFor(() => {
      const element = container.querySelector('.app-notice')
      expect(element).toBeInTheDocument()
      return element
    })
    expect(notice).toHaveTextContent('本地校验拒绝，未执行 Git 命令。')
    expect(notice).toHaveTextContent('所选文件已不在未暂存区，请刷新后重试。')
  })

  it('labels a locally rejected ledger record as 已拒绝 instead of a failed command', async () => {
    const { container, user } = await renderBatch({
      getLedger: async () => [
        ledgerRecordFixture({
          ok: false,
          rejected: true,
          exitCode: null,
          displayCommand: 'git add -- src/main.jsx',
          intent: 'Stage selected files',
        }),
      ],
    })

    await user.click(screen.getByRole('button', { name: '命令账本' }))
    const meta = await waitFor(() => {
      const element = container.querySelector('.ledger-entry-meta')
      expect(element).toBeInTheDocument()
      return element
    })
    expect(meta).toHaveTextContent('已拒绝')
    expect(meta).not.toHaveTextContent('失败')
    expect(meta).toHaveTextContent('退出码 —')
    expect(container.querySelector('.ledger-intent')).toHaveTextContent('暂存所选文件')
  })

  it('maps the batch intent to a Chinese ledger label', () => {
    expect(intentLabel({ intent: 'Stage selected files', source: 'user' })).toBe('暂存所选文件')
    expect(intentLabel({ intent: 'Stage selected files' })).toBe('暂存所选文件')
  })
})
