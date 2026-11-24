// @vitest-environment jsdom
//
// 路径是 GitGlass 的寻址单位：空格、中文、a/ b/ 目录都必须原样保留，
// 否则「预览里写的命令」「左栏的那一行」「实际暂存的路径」会三处不一致。
// 真实 Git 的引号/八进制输出由 tests/integration/git-path-quoting.integration.test.cjs 覆盖。
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { displayGitCommand } from '../../src/command-display.js'
import { renderApp } from '../support/render-app.mjs'
import { fileFixture, ledgerRecordFixture, repositoryState } from '../support/gitglass-fixtures.mjs'

// Git（core.quotePath 默认开启）对 配置.md 的真实输出：非 ASCII 字节写成八进制转义。
const CHINESE_PATCH = [
  'diff --git "a/\\351\\205\\215\\347\\275\\256.md" "b/\\351\\205\\215\\347\\275\\256.md"',
  'index 1111111..2222222 100644',
  '--- "a/\\351\\205\\215\\347\\275\\256.md"',
  '+++ "b/\\351\\205\\215\\347\\275\\256.md"',
  '@@ -1 +1 @@',
  '-旧说明',
  '+新说明',
].join('\n')

const SPACED_PATCH = [
  'diff --git a/guide for project.md b/guide for project.md',
  'index 1111111..2222222 100644',
  '--- a/guide for project.md',
  '+++ b/guide for project.md',
  '@@ -1 +1 @@',
  '-旧指南',
  '+新指南',
].join('\n')

const PATHS = ['guide for project.md', 'new note.md', 'new  note.md', '配置.md', 'a/real-a.md']

function patchFor(filePath) {
  if (filePath === '配置.md') return CHINESE_PATCH
  if (filePath === 'guide for project.md') return SPACED_PATCH
  return [
    `diff --git a/${filePath} b/${filePath}`,
    'index 1111111..2222222 100644',
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    '@@ -1 +1 @@',
    '-before',
    '+after',
  ].join('\n')
}

async function renderPaths(overrides = {}) {
  const view = renderApp({
    getState: async () => repositoryState({ files: PATHS.map((filePath) => fileFixture({ path: filePath })) }),
    getDiff: async (file) => ({ ok: true, stdout: patchFor(file.path) }),
    getLedger: async () => [
      ledgerRecordFixture({
        id: 'user-stage-guide',
        displayCommand: displayGitCommand(['add', '--', 'guide for project.md']),
      }),
    ],
    getRecentRepositories: async () => [],
    ...overrides,
  })
  const user = userEvent.setup()
  await waitFor(() => {
    expect(screen.getByRole('button', { name: '选择文件 guide for project.md' })).toBeInTheDocument()
  })
  await waitFor(() => {
    expect(view.container.querySelector('.diff-content')).toBeInTheDocument()
  })
  return { ...view, user }
}

const rowFor = (label) => screen.getByRole('button', { name: `选择文件 ${label}` })

// 可访问名称按规范会把连续空白折叠成一个空格，所以只差空格的同名行按名字取会撞车；
// 用原始 title（完整路径）定位，同时在下面单独断言 aria-label 保留了原始路径。
const rawRowFor = (filePath) =>
  screen.getAllByRole('button', { name: /^选择文件 / }).find((node) => node.getAttribute('title') === filePath)

describe('文件路径的显示与寻址（渲染）', () => {
  it('shows every path verbatim and keeps two space-variant names apart', async () => {
    const { container } = await renderPaths()

    // 行数与路径一一对应，悬停提示保留原始空白。
    const titles = [...container.querySelectorAll('.file-select')].map((node) => node.getAttribute('title'))
    expect(titles).toEqual(PATHS)

    // 主标签按 basename 显示，连续空格不被折叠。
    const names = [...container.querySelectorAll('.file-name')].map((node) => node.textContent)
    expect(names).toEqual(['guide for project.md', 'new note.md', 'new  note.md', '配置.md', 'real-a.md'])
    expect(names.filter((name) => name.startsWith('new'))).toEqual(['new note.md', 'new  note.md'])

    // 真实 a/ 目录保留在目录尾段里（同名不冲突时不显示）与完整路径提示里。
    expect(titles).toContain('a/real-a.md')
    expect(within(rowFor('a/real-a.md')).queryByText('real-a.md')).toBeInTheDocument()

    // 只差空格的同名文件：可见文本与 aria-label / title 都保留原始空白。
    const spaced = rawRowFor('new  note.md')
    expect(spaced).toBeDefined()
    expect(spaced.getAttribute('aria-label')).toBe('选择文件 new  note.md')
    expect(spaced.querySelector('.file-name').textContent).toBe('new  note.md')
    expect(rawRowFor('new note.md').querySelector('.file-name').textContent).toBe('new note.md')
  })

  it('previews the staging command with exactly the quoting the ledger records', async () => {
    const { container, user } = await renderPaths()

    const preview = () => container.querySelector('.current-file .command-preview code').textContent
    // 含空格的路径按账本同一套规则加引号，而不是拼出一条看起来命中两个文件的命令。
    expect(preview()).toBe('git add -- "guide for project.md"')
    expect(preview()).not.toBe('git add -- guide for project.md')

    // 展开账本：记录里的真实命令与预览逐字一致。
    await user.click(screen.getByRole('button', { name: '命令账本' }))
    const recorded = await waitFor(() => {
      const node = container.querySelector('.ledger-command')
      expect(node).toBeInTheDocument()
      return node
    })
    expect(recorded).toHaveTextContent('git add -- "guide for project.md"')
    expect(recorded.textContent).toBe(preview())

    // 中文路径不需要引号。
    await user.click(rowFor('配置.md'))
    await waitFor(() => {
      expect(preview()).toBe('git add -- 配置.md')
    })
  })

  it('stages exactly the selected path, including the two-space variant', async () => {
    const operate = vi.fn(async () => ({
      execution: { ok: true, argv: ['add', '--', 'src/main.jsx'] },
      state: repositoryState({ files: PATHS.map((filePath) => fileFixture({ path: filePath })) }),
    }))
    const { container, user } = await renderPaths({ operate })

    await user.click(within(screen.getByRole('heading', { name: '当前文件' }).closest('section')).getByRole('button', { name: '暂存文件' }))
    await waitFor(() => {
      expect(operate).toHaveBeenCalledWith('stage', { path: 'guide for project.md' })
    })

    await user.click(rawRowFor('new  note.md'))
    await waitFor(() => {
      // 右栏标题也保留原始空白：两个空格的文件名不会被折叠成一个。
      expect(container.querySelector('.current-file-name-text').textContent).toBe('new  note.md')
    })
    await user.click(within(screen.getByRole('heading', { name: '当前文件' }).closest('section')).getByRole('button', { name: '暂存文件' }))
    await waitFor(() => {
      // 两个只差一个空格的名字各自命中自己的路径。
      expect(operate).toHaveBeenCalledWith('stage', { path: 'new  note.md' })
    })
    // 每次操作只带一个路径：绝不退化成批量暂存。
    expect(operate).toHaveBeenCalledTimes(2)
    expect(operate.mock.calls.map((call) => call[1].path)).toEqual(['guide for project.md', 'new  note.md'])
  })

  it('renders a real quoted Git patch for a Chinese file with a single title', async () => {
    const { container, user } = await renderPaths()

    await user.click(rowFor('配置.md'))
    const title = await waitFor(() => {
      const node = container.querySelector('.diff-title')
      expect(node).toHaveTextContent('配置.md')
      return node
    })
    expect(title).toHaveTextContent('未暂存差异')
    // 标题已经指出路径，patch 里那条（转义过的）文件头不再重复出现。
    expect(container.querySelectorAll('.diff-content .diff-line.file')).toHaveLength(0)
    // 转义没有被直接渲染给用户。
    expect(container.querySelector('.diff-content')).not.toHaveTextContent('351')
    expect(container.querySelector('.diff-content')).toHaveTextContent('新说明')
  })
})
