// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp } from '../support/render-app.mjs'
import {
  commitDetailFixture,
  commitFixture,
  minutesAgo,
  repositoryState,
} from '../support/gitglass-fixtures.mjs'

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const C = 'cccccccccccccccccccccccccccccccccccccccc'
const M = 'dddddddddddddddddddddddddddddddddddddddd'
const OUTSIDE = 'ffffffffffffffffffffffffffffffffffffffff'
const MISSING = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'

const MERGE = commitFixture({
  hash: M,
  shortHash: M.slice(0, 7),
  parents: [B, C],
  subject: 'merge: feature into main',
  refs: ['HEAD -> main'],
  authoredAt: minutesAgo(1),
})
const MAIN = commitFixture({
  hash: B,
  shortHash: B.slice(0, 7),
  parents: [A],
  subject: 'feat: main work',
  authoredAt: minutesAgo(2),
})
const FEATURE = commitFixture({
  hash: C,
  shortHash: C.slice(0, 7),
  parents: [A],
  subject: 'feat: feature work',
  authoredAt: minutesAgo(3),
})
const ROOT = commitFixture({
  hash: A,
  shortHash: A.slice(0, 7),
  parents: [],
  subject: 'feat: initial commit',
  authoredAt: minutesAgo(90),
})

const REFS = [
  { fullName: 'refs/heads/main', shortName: 'main', kind: 'local', commit: M, head: true, annotated: false, status: '' },
  { fullName: 'refs/heads/release', shortName: 'release', kind: 'local', commit: C, head: false, annotated: false, status: '' },
  { fullName: 'refs/remotes/origin/main', shortName: 'origin/main', kind: 'remote', commit: M, annotated: false, status: '' },
  { fullName: 'refs/remotes/origin/HEAD', shortName: 'origin/HEAD', kind: 'alias', targetRef: 'refs/remotes/origin/main', targetShortName: 'origin/main', commit: M, annotated: false, status: '' },
  { fullName: 'refs/tags/release', shortName: 'release', kind: 'tag', commit: C, annotated: false, status: '' },
  { fullName: 'refs/tags/v1.0.0', shortName: 'v1.0.0', kind: 'tag', commit: M, annotated: true, status: '' },
  { fullName: 'refs/tags/ancient', shortName: 'ancient', kind: 'tag', commit: OUTSIDE, annotated: false, status: '' },
  { fullName: 'refs/tags/tree-only', shortName: 'tree-only', kind: 'tag', commit: '', annotated: true, status: '标签目标不是提交（tree 对象），无法定位到提交。' },
]

const HEAD = { fullName: 'refs/heads/main', shortName: 'main', commit: M, detached: false, unborn: false, status: '' }

function historyStub(overrides = {}) {
  return {
    getState: async () => repositoryState(),
    getBranches: async () => ({ branches: [{ name: 'main', current: true }, { name: 'release' }] }),
    getCommits: vi.fn(async () => ({ commits: [MERGE, MAIN, FEATURE, ROOT], limit: 80 })),
    queryHistory: vi.fn(async () => ({ commits: [MERGE], limit: 200 })),
    getRefs: vi.fn(async () => ({ ok: true, head: HEAD, refs: REFS, reason: '' })),
    getCommit: vi.fn(async (hash) => ({
      ok: true,
      commit: {
        ...commitFixture({ hash, shortHash: hash.slice(0, 7), subject: 'ancient: outside the page', parents: [], authoredAt: minutesAgo(500) }),
      },
    })),
    getCommitDetail: vi.fn(async (hash) => commitDetailFixture({
      hash,
      subject: hash === OUTSIDE ? 'ancient: outside the page' : hash === C ? 'feat: feature work' : MERGE.subject,
      changedFiles: [],
    })),
    getCommitDiff: vi.fn(async () => ({ ok: true, diff: '' })),
    getLedger: async () => [],
    getRecentRepositories: async () => [],
    getRemoteOverview: async () => ({ ok: true, remotes: [], remote: null, upstream: null, ahead: 0, behind: 0 }),
    ...overrides,
  }
}

async function renderHistory(overrides = {}) {
  const stub = historyStub(overrides)
  const view = renderApp(stub)
  const user = userEvent.setup()
  await waitFor(() => expect(screen.getByRole('button', { name: '历史审查' })).toBeInTheDocument())
  await user.click(screen.getByRole('button', { name: '历史审查' }))
  await waitFor(() => expect(screen.getByRole('region', { name: 'Git 引用' })).toBeInTheDocument())
  return { ...view, stub, user }
}

describe('history refs and bounded graph (rendered)', () => {
  it('renders local, remote, alias and tag entries with full identifiers and readable unresolved status', async () => {
    const { container, stub } = await renderHistory()
    await waitFor(() => expect(stub.getRefs).toHaveBeenCalledTimes(1))

    const panel = screen.getByRole('region', { name: 'Git 引用' })
    // HEAD has its own entry and resolves to the same full commit.
    expect(within(panel).getByRole('button', { name: `定位当前 HEAD main 到提交 ${M.slice(0, 7)}` })).toHaveAttribute('title', expect.stringContaining(M))
    // Equal short names remain distinct by kind and full ref name.
    const branch = within(panel).getByRole('button', { name: `定位分支 release 到提交 ${C.slice(0, 7)}` })
    const tag = within(panel).getByRole('button', { name: `定位标签 release 到提交 ${C.slice(0, 7)}` })
    expect(branch).toHaveAttribute('data-ref-name', 'refs/heads/release')
    expect(tag).toHaveAttribute('data-ref-name', 'refs/tags/release')
    expect(branch).toHaveAttribute('title', expect.stringContaining('refs/heads/release'))
    expect(tag).toHaveAttribute('title', expect.stringContaining('refs/tags/release'))
    // Remote default alias shows what it points at, not only its own name.
    expect(within(panel).getByRole('button', { name: `定位远程别名 origin/HEAD → origin/main 到提交 ${M.slice(0, 7)}` })).toHaveAttribute('data-ref-name', 'refs/remotes/origin/HEAD')
    expect(within(panel).getByText('origin/HEAD → origin/main')).toBeInTheDocument()
    expect(within(panel).getByText('附注')).toBeInTheDocument()
    // A tag that cannot resolve to a commit is visible and not a dead button.
    expect(within(panel).getByText('标签目标不是提交（tree 对象），无法定位到提交。')).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: /tree-only/ })).toBeNull()
    // The graph lives inside each row button; a merge has all parent edges.
    const mergeRow = screen.getByRole('button', { name: `查看提交 ${MERGE.subject}` })
    const mergeParents = [...mergeRow.querySelectorAll('svg.commit-graph [data-parent]')]
      .map((edge) => edge.getAttribute('data-parent'))
    expect(mergeParents).toEqual([B, C])
    expect(container.querySelector('.history-graph-notice')).toHaveTextContent('4 条父边')
    expect(container.textContent).not.toContain('NaN')
  })

  it('locates a ref in the current list, then reads an out-of-page commit by full id with feedback', async () => {
    const { stub, user } = await renderHistory()
    const panel = screen.getByRole('region', { name: 'Git 引用' })

    await user.click(within(panel).getByRole('button', { name: `定位标签 release 到提交 ${C.slice(0, 7)}` }))
    await waitFor(() => expect(stub.getCommitDetail).toHaveBeenCalledWith(C))
    expect(panel).toHaveTextContent(`已从标签「release」定位到当前列表中的提交 ${C.slice(0, 7)}。`)
    expect(await screen.findByRole('heading', { name: 'feat: feature work' })).toBeInTheDocument()

    await user.click(within(panel).getByRole('button', { name: `定位标签 ancient 到提交 ${OUTSIDE.slice(0, 7)}` }))
    await waitFor(() => expect(stub.getCommit).toHaveBeenCalledWith(OUTSIDE))
    await waitFor(() => expect(stub.getCommitDetail).toHaveBeenCalledWith(OUTSIDE))
    expect(panel).toHaveTextContent('不在当前列表，已按完整 ID')
    expect(panel).toHaveTextContent(OUTSIDE.slice(0, 7))
    expect(await screen.findByRole('heading', { name: 'ancient: outside the page' })).toBeInTheDocument()
    expect(screen.getByText(/当前选中的提交不在本页/)).toBeInTheDocument()
  })

  it('discards a slow Diff from the old commit after switching to another ref', async () => {
    let resolveDiff
    const slowDiff = new Promise((resolve) => { resolveDiff = resolve })
    const { stub, user } = await renderHistory({
      getCommitDiff: vi.fn(() => slowDiff),
    })
    const panel = screen.getByRole('region', { name: 'Git 引用' })

    await user.click(screen.getByRole('button', { name: `查看提交 ${MERGE.subject}` }))
    await waitFor(() => expect(stub.getCommitDetail).toHaveBeenCalledWith(M))
    await user.click(screen.getByRole('button', { name: '查看完整 Diff' }))
    await waitFor(() => expect(stub.getCommitDiff).toHaveBeenCalledWith(M))

    await user.click(within(panel).getByRole('button', { name: `定位标签 release 到提交 ${C.slice(0, 7)}` }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'feat: feature work' })).toBeInTheDocument())
    expect(screen.queryByText('OLD-DIFF-MUST-NOT-RENDER')).toBeNull()

    await act(async () => {
      resolveDiff({ ok: true, diff: 'OLD-DIFF-MUST-NOT-RENDER' })
      await slowDiff
    })
    expect(screen.getByRole('heading', { name: 'feat: feature work' })).toBeInTheDocument()
    expect(screen.queryByText('OLD-DIFF-MUST-NOT-RENDER')).toBeNull()
    expect(screen.getByRole('button', { name: '查看完整 Diff' })).toBeEnabled()
  })

  it('recovers loading when returning to a cached list commit during an outside ref read', async () => {
    let resolveOutside
    const outsideRead = new Promise((resolve) => { resolveOutside = resolve })
    const { stub, user } = await renderHistory({
      getCommit: vi.fn(() => outsideRead),
    })

    await user.click(screen.getByRole('button', { name: `查看提交 ${MERGE.subject}` }))
    await waitFor(() => expect(stub.getCommitDetail).toHaveBeenCalledWith(M))

    const panel = screen.getByRole('region', { name: 'Git 引用' })
    await user.click(within(panel).getByRole('button', { name: `定位标签 ancient 到提交 ${OUTSIDE.slice(0, 7)}` }))
    await waitFor(() => expect(screen.getByRole('button', { name: '打开仓库' })).toBeDisabled())
    expect(screen.getByRole('button', { name: '查看完整 Diff' })).toBeDisabled()

    // The list commit is already cached; selecting it must end the old
    // outside-ref loading state immediately, while that read is still pending.
    await user.click(screen.getByRole('button', { name: `查看提交 ${MERGE.subject}` }))
    await waitFor(() => expect(screen.getByRole('button', { name: '打开仓库' })).toBeEnabled())
    expect(screen.getByRole('button', { name: '查看完整 Diff' })).toBeEnabled()
    expect(screen.getByRole('heading', { name: MERGE.subject })).toBeInTheDocument()

    await act(async () => {
      resolveOutside({
        ok: true,
        commit: commitFixture({ hash: OUTSIDE, shortHash: OUTSIDE.slice(0, 7), subject: 'outside response must be discarded', parents: [] }),
      })
      await outsideRead
    })
    expect(screen.getByRole('heading', { name: MERGE.subject })).toBeInTheDocument()
    expect(screen.queryByText('outside response must be discarded')).toBeNull()
    expect(screen.getByRole('button', { name: '打开仓库' })).toBeEnabled()
  })

  it('discards an older out-of-page ref response when a newer ref is clicked first', async () => {
    let resolveFirst
    const first = new Promise((resolve) => { resolveFirst = resolve })
    const second = commitFixture({
      hash: '9'.repeat(40),
      shortHash: '9999999',
      subject: 'second: newer ref target',
      parents: [],
      authoredAt: minutesAgo(4),
    })
    const refs = [
      ...REFS.filter((ref) => ref.fullName !== 'refs/tags/ancient'),
      { fullName: 'refs/tags/first-slow', shortName: 'first-slow', kind: 'tag', commit: OUTSIDE, annotated: false, status: '' },
      { fullName: 'refs/tags/second-fast', shortName: 'second-fast', kind: 'tag', commit: second.hash, annotated: false, status: '' },
    ]
    const { stub, user } = await renderHistory({
      getRefs: vi.fn(async () => ({ ok: true, head: HEAD, refs, reason: '' })),
      getCommit: vi.fn((hash) => hash === OUTSIDE ? first : Promise.resolve({ ok: true, commit: second })),
      getCommitDetail: vi.fn(async (hash) => commitDetailFixture({ hash, subject: hash === second.hash ? second.subject : 'first: must be discarded' })),
    })
    const panel = screen.getByRole('region', { name: 'Git 引用' })

    await user.click(within(panel).getByRole('button', { name: `定位标签 first-slow 到提交 ${OUTSIDE.slice(0, 7)}` }))
    await user.click(within(panel).getByRole('button', { name: `定位标签 second-fast 到提交 ${second.shortHash}` }))
    await waitFor(() => expect(stub.getCommit).toHaveBeenCalledWith(second.hash))
    await waitFor(() => expect(screen.getByRole('heading', { name: second.subject })).toBeInTheDocument())

    await act(async () => {
      resolveFirst({ ok: true, commit: { ...commitFixture({ hash: OUTSIDE, shortHash: OUTSIDE.slice(0, 7), subject: 'first: must be discarded', parents: [] }) } })
      await first
    })
    await waitFor(() => expect(screen.getByRole('heading', { name: second.subject })).toBeInTheDocument())
    expect(screen.queryByText('first: must be discarded')).toBeNull()
  })

  it('marks parent connections omitted at the lane cap instead of drawing misleading lines', async () => {
    const parentHashes = Array.from({ length: 9 }, (_, index) => String(index + 1).repeat(40))
    const octopus = commitFixture({
      hash: M,
      shortHash: M.slice(0, 7),
      parents: parentHashes,
      subject: 'merge: nine parents at the lane cap',
      authoredAt: minutesAgo(1),
    })
    const parents = parentHashes.map((hash, index) => commitFixture({
      hash,
      shortHash: hash.slice(0, 7),
      parents: [],
      subject: `parent ${index + 1}`,
      authoredAt: minutesAgo(index + 2),
    }))
    const { container } = await renderHistory({
      getCommits: vi.fn(async () => ({ commits: [octopus, ...parents], limit: 80 })),
    })
    const row = screen.getByRole('button', { name: `查看提交 ${octopus.subject}` })
    expect(within(row).getByText('省略 2')).toHaveAttribute('title', expect.stringContaining(parentHashes[8]))
    expect(row.querySelectorAll('svg.commit-graph [data-parent]')).toHaveLength(7)
    expect(container.querySelector('.history-graph-notice')).toHaveTextContent('已省略 2 条连接')
    expect(container.querySelector('.history-graph-notice')).toHaveTextContent('没有画成错误的实线')
  })

  it('marks a parent outside the current page as a visible boundary edge', async () => {
    const boundaryCommit = commitFixture({
      hash: '9'.repeat(40),
      shortHash: '9999999',
      parents: [MISSING],
      subject: 'truncated: parent is outside this page',
      authoredAt: minutesAgo(5),
    })
    const { container } = await renderHistory({
      getCommits: vi.fn(async () => ({ commits: [boundaryCommit], limit: 1 })),
    })
    const row = screen.getByRole('button', { name: `查看提交 ${boundaryCommit.subject}` })
    expect(within(row).getByText('边界')).toHaveAttribute('title', expect.stringContaining(MISSING))
    expect(row.querySelector('svg.commit-graph [data-boundary="true"]')).toHaveAttribute('data-parent', MISSING)
    expect(container.querySelector('.history-graph-notice')).toHaveTextContent('边界 1')
    expect(container.querySelector('.history-graph-notice')).toHaveTextContent('父提交不在读取范围内')
  })

  it('keeps the list-only view when a file filter would use Git history simplification', async () => {
    const { container, stub, user } = await renderHistory()
    const fileInput = screen.getByPlaceholderText('当前已跟踪文件')
    await user.type(fileInput, 'src/main.jsx')
    await user.click(screen.getByRole('button', { name: '应用筛选' }))
    await waitFor(() => expect(stub.queryHistory).toHaveBeenCalledWith(expect.objectContaining({ filePath: 'src/main.jsx' })))

    const notice = container.querySelector('.history-graph-notice.list-only')
    expect(notice).toHaveTextContent('文件筛选会经过 Git 的历史简化')
    expect(container.querySelector('svg.commit-graph')).toBeNull()
    // The commit list remains usable.
    expect(screen.getByRole('button', { name: `查看提交 ${MERGE.subject}` })).toBeInTheDocument()
  })

  it('refreshes refs when Git reports an external ref change', async () => {
    let changed
    const { stub } = await renderHistory({
      onRepositoryChanged: (callback) => { changed = callback; return () => {} },
    })
    await waitFor(() => expect(stub.getRefs).toHaveBeenCalledTimes(1))
    expect(changed).toBeTypeOf('function')

    await act(async () => { changed({ reason: 'refs' }) })
    await waitFor(() => expect(stub.getRefs).toHaveBeenCalledTimes(2))
  })

  it('keeps an explicitly selected out-of-page commit through a background refresh', async () => {
    let changed
    const { stub, user } = await renderHistory({
      onRepositoryChanged: (callback) => { changed = callback; return () => {} },
    })
    const panel = screen.getByRole('region', { name: 'Git 引用' })
    await user.click(within(panel).getByRole('button', { name: `定位标签 ancient 到提交 ${OUTSIDE.slice(0, 7)}` }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'ancient: outside the page' })).toBeInTheDocument())
    const detailCalls = stub.getCommitDetail.mock.calls.length

    await act(async () => { changed({ reason: 'refs' }) })
    await waitFor(() => expect(stub.getRefs).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(stub.getCommits).toHaveBeenCalledTimes(2))
    // The silent refresh re-read the same page; the explicit ref selection and
    // its feedback survive because this commit is deliberately outside it.
    expect(screen.getByRole('heading', { name: 'ancient: outside the page' })).toBeInTheDocument()
    expect(panel).toHaveTextContent('不在当前列表，已按完整 ID')
    expect(screen.getByText(/当前选中的提交不在本页/)).toBeInTheDocument()
    expect(stub.getCommitDetail.mock.calls.length).toBe(detailCalls)
  })

  it('moves focus through refs and commit rows with the keyboard', async () => {
    const { user } = await renderHistory()
    const panel = screen.getByRole('region', { name: 'Git 引用' })
    const headButton = within(panel).getByRole('button', { name: /定位当前 HEAD/ })
    headButton.focus()
    expect(headButton).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(within(panel).getByRole('button', { name: `定位分支 main 到提交 ${M.slice(0, 7)}` })).toHaveFocus()

    const mergeRow = screen.getByRole('button', { name: `查看提交 ${MERGE.subject}` })
    mergeRow.focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('button', { name: `查看提交 ${MAIN.subject}` })).toHaveFocus()
  })

  it('shows a dangling remote default alias as a readable missing-target row', async () => {
    const dangling = {
      fullName: 'refs/remotes/origin/HEAD',
      shortName: 'origin/HEAD',
      kind: 'alias',
      targetRef: 'refs/remotes/origin/gone',
      targetShortName: 'origin/gone',
      commit: '',
      status: '目标分支不存在',
    }
    const { stub } = await renderHistory({
      getRefs: vi.fn(async () => ({
        ok: true,
        head: HEAD,
        refs: [...REFS.filter((ref) => ref.fullName !== 'refs/remotes/origin/HEAD'), dangling],
        truncated: false,
        reason: '',
      })),
    })
    await waitFor(() => expect(stub.getRefs).toHaveBeenCalled())
    const panel = screen.getByRole('region', { name: 'Git 引用' })
    expect(panel).toHaveTextContent('origin/HEAD → origin/gone')
    expect(panel).toHaveTextContent('目标分支不存在')
    expect(within(panel).queryByRole('button', { name: /origin\/HEAD/ })).toBeNull()
  })

  it('labels a truncated ref read instead of pretending the list is complete', async () => {
    const { stub } = await renderHistory({
      getRefs: vi.fn(async () => ({ ok: true, head: HEAD, refs: REFS.slice(0, 3), truncated: true, reason: '' })),
    })
    await waitFor(() => expect(stub.getRefs).toHaveBeenCalled())
    expect(screen.getByRole('region', { name: 'Git 引用' })).toHaveTextContent('仅显示部分引用')
  })

  it('keeps an origin/HEAD jump when its target is outside a truncated ref list', async () => {
    const alias = REFS.find((ref) => ref.fullName === 'refs/remotes/origin/HEAD')
    const { stub, user } = await renderHistory({
      getRefs: vi.fn(async () => ({
        ok: true,
        head: HEAD,
        // origin/main is deliberately absent, as it would be when local
        // branches fill the 64 KiB ref-record budget.
        refs: [REFS[0], REFS[1], alias],
        truncated: true,
        reason: '',
      })),
    })
    await waitFor(() => expect(stub.getRefs).toHaveBeenCalled())
    const panel = screen.getByRole('region', { name: 'Git 引用' })
    expect(panel).toHaveTextContent('仅显示部分引用')
    expect(within(panel).queryByText('origin/main')).toBeNull()

    await user.click(within(panel).getByRole('button', { name: `定位远程别名 origin/HEAD → origin/main 到提交 ${M.slice(0, 7)}` }))
    await waitFor(() => expect(screen.getByRole('heading', { name: MERGE.subject })).toBeInTheDocument())
    expect(stub.getCommitDetail).toHaveBeenCalledWith(M)
  })

  it('tells an empty repository that no refs can be shown yet', async () => {
    const { container } = await renderHistory({
      getCommits: vi.fn(async () => ({ commits: [], limit: 80 })),
      getRefs: vi.fn(async () => ({
        ok: true,
        head: { fullName: 'refs/heads/main', shortName: 'main', commit: '', detached: false, unborn: true, status: '当前分支还没有提交。' },
        refs: [],
        reason: '',
      })),
    })
    const panel = screen.getByRole('region', { name: 'Git 引用' })
    expect(panel).toHaveTextContent('main · 当前分支还没有提交。')
    expect(panel).toHaveTextContent('当前仓库没有可显示的分支或标签。')
    expect(container.querySelector('svg.commit-graph')).toBeNull()
  })
})
