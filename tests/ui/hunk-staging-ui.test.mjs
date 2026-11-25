// @vitest-environment jsdom
//
// PR 2（v0.6.9 工作台 UI）的真渲染断言：块头按钮、按块操作的 IPC 载荷、
// 失败/过期反馈、快速切换文件时的读取顺序，以及提交前暂存总览。
// 真实 Git 语义由 tests/integration/hunk-stage.integration.test.cjs 覆盖。
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp } from '../support/render-app.mjs'
import { fileFixture, repositoryState } from '../support/gitglass-fixtures.mjs'

const TWO_HUNK_DIFF = [
  'diff --git a/app.js b/app.js',
  'index 1111111..2222222 100644',
  '--- a/app.js',
  '+++ b/app.js',
  '@@ -1,6 +1,6 @@',
  ' line 1',
  ' line 2',
  '-line 3',
  '+line 3 edited',
  ' line 4',
  ' line 5',
  ' line 6',
  '@@ -28,7 +28,7 @@',
  ' line 28',
  ' line 29',
  ' line 30',
  '-line 31',
  '+line 31 edited',
  ' line 32',
  ' line 33',
  ' line 34',
  '',
].join('\n')

const APP_HUNKS = [
  { index: 0, range: '@@ -1,6 +1,6 @@', oldStart: 1, oldLines: 6, newStart: 1, newLines: 6, contentHash: 'a'.repeat(64) },
  { index: 1, range: '@@ -28,7 +28,7 @@', oldStart: 28, oldLines: 7, newStart: 28, newLines: 7, contentHash: 'b'.repeat(64) },
]

const UNSTAGED = fileFixture({ path: 'app.js' })
const STAGED = fileFixture({ path: 'docs/guide.md', area: 'staged' })

function diffResult(overrides = {}) {
  return {
    ok: true,
    stdout: TWO_HUNK_DIFF,
    area: 'unstaged',
    path: 'app.js',
    snapshot: 'c'.repeat(64),
    hunkSupport: { ok: true, reason: '', hunks: APP_HUNKS },
    ...overrides,
  }
}

async function renderWorkspace(overrides = {}) {
  const stub = {
    getState: async () => repositoryState({ files: [UNSTAGED, STAGED] }),
    getLedger: async () => [],
    getRecentRepositories: async () => [],
    getDiff: async () => diffResult(),
    ...overrides,
  }
  const view = renderApp(stub)
  const user = userEvent.setup()
  // 首屏会自动选中第一个文件并读取它的差异。
  await waitFor(() => {
    expect(screen.getAllByRole('button', { name: /暂存此块|取消暂存此块/ })).toHaveLength(2)
  })
  return { ...view, stub, user }
}

const hunkButton = (range) => screen.getByRole('button', { name: `暂存此块：${range}` })

describe('hunk staging in the workbench (rendered)', () => {
  it('offers one action per hunk, named after its block, and only for stageable diffs', async () => {
    const { container } = await renderWorkspace()
    const buttons = screen.getAllByRole('button', { name: /^暂存此块：/ })
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      '暂存此块：@@ -1,6 +1,6 @@',
      '暂存此块：@@ -28,7 +28,7 @@',
    ])
    // 按钮挂在块头行里，位置跟着块走。
    const hunkRows = container.querySelectorAll('.diff-line.hunk')
    expect(hunkRows).toHaveLength(2)
    expect(within(hunkRows[1]).getByRole('button', { name: '暂存此块：@@ -28,7 +28,7 @@' })).toBeInTheDocument()
  })

  it('keeps a hunk whose header carries file content stageable without exposing it', async () => {
    // 自定义 xfuncname 能让块头带上文件里的一行（甚至像凭据的内容）。显示文本已脱敏，
    // 块清单只带范围与内容摘要，载荷里找不到原值也找不到占位文本。
    const redactedDiff = TWO_HUNK_DIFF.replace('@@ -28,7 +28,7 @@', '@@ -28,7 +28,7 @@ endpoint = https://api.example.test/v1?access_token=<redacted>')
    const applyDiffHunk = vi.fn(async () => ({ ok: true, execution: { ok: true, operationId: 'op-h' }, state: { files: [] }, reason: '' }))
    const { container, user } = await renderWorkspace({
      getDiff: async () => diffResult({ stdout: redactedDiff }),
      applyDiffHunk,
    })

    const hunkRows = container.querySelectorAll('.diff-line.hunk')
    expect(hunkRows).toHaveLength(2)
    expect(hunkRows[1].textContent).toContain('access_token=<redacted>')

    await user.click(hunkButton('@@ -28,7 +28,7 @@'))
    await waitFor(() => expect(applyDiffHunk).toHaveBeenCalledTimes(1))
    const payload = JSON.stringify(applyDiffHunk.mock.calls[0])
    expect(payload).not.toContain('SECRET')
    expect(payload).not.toContain('<redacted>')
    expect(applyDiffHunk).toHaveBeenCalledWith('stage', { path: 'app.js', snapshot: 'c'.repeat(64), hunk: APP_HUNKS[1] })
  })

  it('sends only the locator getDiff published when a hunk is staged', async () => {
    const applyDiffHunk = vi.fn(async () => ({ ok: true, execution: { ok: true, operationId: 'op-1' }, state: { files: [] }, reason: '' }))
    const { user } = await renderWorkspace({ applyDiffHunk })

    await user.click(hunkButton('@@ -28,7 +28,7 @@'))

    await waitFor(() => expect(applyDiffHunk).toHaveBeenCalledTimes(1))
    // 只有方向 + 标识：没有命令、没有补丁、没有第二个仓库路径。
    expect(applyDiffHunk).toHaveBeenCalledWith('stage', {
      path: 'app.js',
      snapshot: 'c'.repeat(64),
      hunk: APP_HUNKS[1],
    })
    // 成功后按真实状态刷新，并给出中文反馈。
    await waitFor(() => expect(screen.getByText('已暂存此块。')).toBeInTheDocument())
  })

  it('offers "取消暂存此块" for the staged side of the same file', async () => {
    const { user } = await renderWorkspace({
      getDiff: async (file) =>
        file.area === 'staged'
          ? diffResult({ area: 'staged', path: 'docs/guide.md' })
          : diffResult(),
    })

    await user.click(screen.getByRole('button', { name: '选择文件 docs/guide.md' }))
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /^取消暂存此块：/ })).toHaveLength(2)
    })
    expect(screen.getByRole('button', { name: '取消暂存此块：@@ -1,6 +1,6 @@' })).toBeInTheDocument()
  })

  it('explains an expired selection instead of pretending the hunk was staged', async () => {
    const applyDiffHunk = vi.fn(async () => ({
      ok: false,
      execution: null,
      record: { rejected: true, operationId: 'op-rejected' },
      reason: 'Diff 已过期：读取之后工作区或仓库发生了变化，请刷新后重试。',
      state: null,
    }))
    const { user } = await renderWorkspace({ applyDiffHunk })

    await user.click(hunkButton('@@ -1,6 +1,6 @@'))

    await waitFor(() => {
      expect(screen.getByText(/本地校验拒绝，未执行 Git 命令。Diff 已过期/)).toBeInTheDocument()
    })
    // 拒绝后界面回到可继续操作的状态：块按钮仍在，没有被禁用。
    expect(hunkButton('@@ -1,6 +1,6 @@')).toBeEnabled()
  })

  it('shows the real Git failure reason for a hunk Git refused', async () => {
    const applyDiffHunk = vi.fn(async () => ({
      ok: false,
      execution: { ok: false, exitCode: 128, stderr: 'error: patch failed' },
      record: { rejected: false },
      reason: '这个 Diff 块无法应用到索引。请刷新后重试；Git 的原始输出已保留在命令账本。',
      state: null,
    }))
    const { user } = await renderWorkspace({ applyDiffHunk })

    await user.click(hunkButton('@@ -1,6 +1,6 @@'))

    await waitFor(() => {
      expect(screen.getByText('这个 Diff 块无法应用到索引。请刷新后重试；Git 的原始输出已保留在命令账本。')).toBeInTheDocument()
    })
  })

  it('does not offer hunk actions when the main process refused the file', async () => {
    renderApp({
      getState: async () => repositoryState({ files: [UNSTAGED] }),
      getLedger: async () => [],
      getRecentRepositories: async () => [],
      getDiff: async () => diffResult({ hunkSupport: { ok: false, reason: '这是二进制或无法按文本显示的差异，暂不支持按块操作。请使用整文件操作。', hunks: [] } }),
    })
    await waitFor(() => {
      expect(screen.getByText(/line 3 edited/)).toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: /^暂存此块：/ })).toBeNull()
  })

  it('ignores a diff that arrives after the user already selected another file', async () => {
    const slow = { resolve: null }
    const getDiff = async (file) => {
      if (file.path === 'app.js') {
        await new Promise((resolve) => { slow.resolve = resolve })
        return diffResult({ stdout: TWO_HUNK_DIFF.replace('+line 3 edited', '+line 3 from app') })
      }
      return diffResult({
        path: 'notes.md',
        stdout: TWO_HUNK_DIFF.replaceAll('app.js', 'notes.md').replace('+line 3 edited', '+line 3 from notes'),
      })
    }
    renderApp({
      getState: async () => repositoryState({ files: [fileFixture({ path: 'app.js' }), fileFixture({ path: 'notes.md' })] }),
      getLedger: async () => [],
      getRecentRepositories: async () => [],
      getDiff,
    })
    const user = userEvent.setup()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '选择文件 notes.md' })).toBeInTheDocument()
    })

    // 选中 notes.md 后，app.js 的旧读取才回来：它绝不能覆盖当前 Diff。
    await user.click(screen.getByRole('button', { name: '选择文件 notes.md' }))
    await waitFor(() => {
      expect(screen.getByText(/line 3 from notes/)).toBeInTheDocument()
    })
    slow.resolve?.()
    await waitFor(() => {
      expect(screen.getByText(/line 3 from notes/)).toBeInTheDocument()
    })
    expect(screen.queryByText(/line 3 from app/)).toBeNull()
  })
})

describe('staged overview in the commit panel (rendered)', () => {
  const overview = {
    ok: true,
    files: [
      { path: 'docs/guide.md', status: 'modified', insertions: 12, deletions: 3, binary: false, statUnavailable: false },
      { path: 'assets/logo.png', status: 'modified', insertions: null, deletions: null, binary: true, statUnavailable: false },
      { path: 'big.txt', status: 'modified', insertions: null, deletions: null, binary: false, statUnavailable: true },
    ],
    totals: { files: 3, insertions: 12, deletions: 3, binary: 1, unavailable: 1 },
    reason: '',
  }

  it('opens on demand, reads the real staged area, and jumps to a staged diff', async () => {
    const getStagedOverview = vi.fn(async () => overview)
    const getDiff = vi.fn(async (file) => diffResult({ area: file.area, path: file.path }))
    renderApp({
      getState: async () => repositoryState({ files: [UNSTAGED, STAGED] }),
      getLedger: async () => [],
      getRecentRepositories: async () => [],
      getDiff,
      getStagedOverview,
    })
    const user = userEvent.setup()

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '查看暂存总览' })).toBeInTheDocument()
    })
    // 折叠时不读统计：不点就不产生后台命令。
    expect(getStagedOverview).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '查看暂存总览' }))
    await waitFor(() => expect(getStagedOverview).toHaveBeenCalledTimes(1))

    const list = document.getElementById('staged-overview-list')
    expect(within(list).getByText('+12 −3')).toBeInTheDocument()
    expect(within(list).getByText('二进制')).toBeInTheDocument()
    expect(within(list).getByText('统计不可用')).toBeInTheDocument()
    expect(within(list).getByText('文件 3')).toBeInTheDocument()

    await user.click(within(list).getByRole('button', { name: '查看已暂存文件 docs/guide.md 的差异' }))
    await waitFor(() => {
      expect(getDiff).toHaveBeenCalledWith({ path: 'docs/guide.md', area: 'staged' })
    })
  })

  it('keeps the two-section right panel and explains an empty staged area', async () => {
    const { container } = renderApp({
      getState: async () => repositoryState({ files: [UNSTAGED] }),
      getLedger: async () => [],
      getRecentRepositories: async () => [],
      getStagedOverview: async () => ({ ok: true, files: [], totals: { files: 0, insertions: 0, deletions: 0, binary: 0, unavailable: 0 }, reason: '' }),
    })
    const user = userEvent.setup()

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '查看暂存总览' })).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: '查看暂存总览' }))
    await waitFor(() => {
      expect(screen.getByText('还没有已暂存的文件。')).toBeInTheDocument()
    })
    // 总览嵌在「创建提交」里：右栏仍然只有「当前文件」与「创建提交」两段。
    const sections = [...container.querySelectorAll('.context-panel > section.inspector-flow')]
    expect(sections.map((section) => section.querySelector('h2')?.textContent)).toEqual([
      '当前文件',
      '创建提交',
    ])
  })
})

describe('staged overview follows the real index (rendered)', () => {
  const STAGED_GUIDE = {
    ok: true,
    files: [{ path: 'docs/guide.md', status: 'modified', insertions: 4, deletions: 1, binary: false, statUnavailable: false }],
    totals: { files: 1, insertions: 4, deletions: 1, binary: 0, unavailable: 0 },
    reason: '',
  }
  const EMPTY_OVERVIEW = { ok: true, files: [], totals: { files: 0, insertions: 0, deletions: 0, binary: 0, unavailable: 0 }, reason: '' }
  const EMPTY_TOTALS = EMPTY_OVERVIEW.totals

  async function openOverview(overrides) {
    const view = renderApp({
      getLedger: async () => [],
      getRecentRepositories: async () => [],
      getDiff: async (file) => diffResult({ area: file.area, path: file.path }),
      ...overrides,
    })
    const user = userEvent.setup()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '查看暂存总览' })).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: '查看暂存总览' }))
    return { ...view, user }
  }

  it('re-reads the overview after unstage-all so the list matches the empty index', async () => {
    let hasStaged = true
    const getState = async () =>
      repositoryState({
        files: hasStaged
          ? [fileFixture({ path: 'docs/guide.md', area: 'staged' })]
          : [fileFixture({ path: 'docs/guide.md' })],
      })
    const getStagedOverview = vi.fn(async () => (hasStaged ? STAGED_GUIDE : EMPTY_OVERVIEW))
    const operate = vi.fn(async () => {
      hasStaged = false
      return { execution: { ok: true }, state: await getState() }
    })

    const { user } = await openOverview({ getState, getStagedOverview, operate })
    await waitFor(() => expect(within(document.getElementById('staged-overview-list')).getByText('+4 −1')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: '取消全部暂存' }))

    await waitFor(() => expect(operate).toHaveBeenCalledWith('unstageAll', {}))
    // 展开着的总览跟着真实暂存区更新：旧文件不再显示。
    await waitFor(() => expect(getStagedOverview).toHaveBeenCalledTimes(2))
    await waitFor(() => {
      const list = document.getElementById('staged-overview-list')
      expect(within(list).queryByText('docs/guide.md')).toBeNull()
      expect(within(list).getByText('还没有已暂存的文件。')).toBeInTheDocument()
    })
  })

  it('empties the overview after a commit succeeds', async () => {
    let hasStaged = true
    const getState = async () =>
      repositoryState({ files: hasStaged ? [fileFixture({ path: 'docs/guide.md', area: 'staged' })] : [] })
    const getStagedOverview = vi.fn(async () => (hasStaged ? STAGED_GUIDE : EMPTY_OVERVIEW))
    const operate = vi.fn(async (action) => {
      if (action === 'commit') hasStaged = false
      return { execution: { ok: true }, state: await getState(), commit: action === 'commit' ? 'abc1234' : null }
    })

    const { user } = await openOverview({ getState, getStagedOverview, operate })
    await waitFor(() => expect(within(document.getElementById('staged-overview-list')).getByText('+4 −1')).toBeInTheDocument())

    await user.type(screen.getByLabelText('提交说明'), 'feat: commit the staged change')
    await user.click(screen.getByRole('button', { name: '提交 1 个文件' }))

    await waitFor(() => expect(operate).toHaveBeenCalledWith('commit', { message: 'feat: commit the staged change' }))
    await waitFor(() => {
      const list = document.getElementById('staged-overview-list')
      expect(within(list).queryByText('docs/guide.md')).toBeNull()
      expect(within(list).getByText('还没有已暂存的文件。')).toBeInTheDocument()
    })
  })

  it('refreshes an expanded overview after an external Git change', async () => {
    let onChange = null
    let files = [fileFixture({ path: 'docs/guide.md', area: 'staged' })]
    const getState = async () => repositoryState({ files })
    let overview = STAGED_GUIDE
    const getStagedOverview = vi.fn(async () => overview)

    await openOverview({
      getState,
      getStagedOverview,
      onRepositoryChanged: (callback) => { onChange = callback; return () => {} },
    })
    await waitFor(() => expect(within(document.getElementById('staged-overview-list')).getByText('docs/guide.md')).toBeInTheDocument())
    expect(getStagedOverview).toHaveBeenCalledTimes(1)

    // 终端里又暂存了一个文件：watcher 报告 refs 变化（穿过滤抖窗）。
    files = [
      fileFixture({ path: 'docs/guide.md', area: 'staged' }),
      fileFixture({ path: 'src/added.js', area: 'staged', status: 'added' }),
    ]
    overview = {
      ok: true,
      files: [
        { path: 'docs/guide.md', status: 'modified', insertions: 4, deletions: 1, binary: false, statUnavailable: false },
        { path: 'src/added.js', status: 'added', insertions: 9, deletions: 0, binary: false, statUnavailable: false },
      ],
      totals: { files: 2, insertions: 13, deletions: 1, binary: 0, unavailable: 0 },
      reason: '',
    }
    await act(async () => { onChange({ reason: 'refs' }) })

    await waitFor(() => expect(getStagedOverview).toHaveBeenCalledTimes(2))
    await waitFor(() => {
      const list = document.getElementById('staged-overview-list')
      expect(within(list).getByText('src/added.js')).toBeInTheDocument()
      expect(within(list).getByText('文件 2')).toBeInTheDocument()
    })
  })

  it('stops reading once collapsed and reads again when reopened', async () => {
    let onChange = null
    const getState = vi.fn(async () => repositoryState({ files: [fileFixture({ path: 'docs/guide.md', area: 'staged' })] }))
    const getStagedOverview = vi.fn(async () => STAGED_GUIDE)

    const { user } = await openOverview({
      getState,
      getStagedOverview,
      onRepositoryChanged: (callback) => { onChange = callback; return () => {} },
    })
    await waitFor(() => expect(getStagedOverview).toHaveBeenCalledTimes(1))
    const refreshesWhileOpen = getState.mock.calls.length

    // 收起：跟随刷新立刻停止（总览不再读，但工作区刷新照常发生）。
    await user.click(screen.getByRole('button', { name: '收起暂存总览' }))
    await act(async () => { onChange({ reason: 'refs' }) })
    await waitFor(() => expect(getState.mock.calls.length).toBeGreaterThan(refreshesWhileOpen))
    expect(getStagedOverview).toHaveBeenCalledTimes(1)

    // 重新展开：按需再读一次，并把当前暂存区显示出来。
    await user.click(screen.getByRole('button', { name: '查看暂存总览' }))
    await waitFor(() => expect(getStagedOverview).toHaveBeenCalledTimes(2))
    await waitFor(() => {
      expect(within(document.getElementById('staged-overview-list')).getByText('docs/guide.md')).toBeInTheDocument()
    })
  })

  it('drops a staged-overview response that belongs to the previous repository', async () => {
    let onChange = null
    let currentPath = 'C:/work/demo-repo'
    let files = [fileFixture({ path: 'src/only-in-old.js', area: 'staged' })]
    const getState = async () => repositoryState({ path: currentPath, files })
    let resolveFirst = null
    let calls = 0
    const getStagedOverview = vi.fn(async () => {
      calls += 1
      if (calls === 1) {
        return new Promise((resolve) => { resolveFirst = resolve })
      }
      return { ...EMPTY_OVERVIEW, totals: EMPTY_TOTALS }
    })

    await openOverview({
      getState,
      getStagedOverview,
      onRepositoryChanged: (callback) => { onChange = callback; return () => {} },
    })
    // 第一次读取还挂着：切到另一个仓库（刷新拿到新路径），新仓库的索引是空的。
    expect(getStagedOverview).toHaveBeenCalledTimes(1)
    currentPath = 'C:/work/other-repo'
    files = []
    await act(async () => { onChange({ reason: 'refs' }) })
    await waitFor(() => expect(getStagedOverview).toHaveBeenCalledTimes(2))

    // 旧仓库的响应这时才回来：不能显示在新仓库里。
    await act(async () => {
      resolveFirst({
        ok: true,
        files: [{ path: 'src/only-in-old.js', status: 'modified', insertions: 1, deletions: 0, binary: false, statUnavailable: false }],
        totals: { files: 1, insertions: 1, deletions: 0, binary: 0, unavailable: 0 },
        reason: '',
      })
    })

    const list = document.getElementById('staged-overview-list')
    expect(within(list).queryByText('src/only-in-old.js')).toBeNull()
    expect(within(list).getByText('还没有已暂存的文件。')).toBeInTheDocument()
  })
})
