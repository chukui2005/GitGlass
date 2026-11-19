// 假桥用的仓库数据。
//
// 字段形状必须和 `electron/repository-service.cjs` / `electron/git-parsers.cjs`
// 的真实返回值一致，否则渲染出来的是测试自己编的世界——那种"绿"没有意义。
// 时间一律相对 now 生成：相对时间文案（`3 分钟前`）才不会被日历日期拖红。

export const REPOSITORY_PATH = 'C:/work/demo-repo'
export const OTHER_REPOSITORY_PATH = 'C:/work/another-repo'

/** @param {number} minutes @returns {string} ISO 时间戳 */
export function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString()
}

/**
 * 一个文件条目（`git status --porcelain=v1 -z --untracked-files=all` 的解析结果）。
 * @param {Record<string, unknown>} [overrides]
 */
export function fileFixture(overrides = {}) {
  return { path: 'src/main.jsx', area: 'unstaged', status: 'modified', ...overrides }
}

/**
 * `getState()` 的返回值。
 * @param {Record<string, unknown>} [overrides]
 */
export function repositoryState(overrides = {}) {
  return {
    ok: true,
    path: REPOSITORY_PATH,
    branch: 'main',
    files: [fileFixture({ path: 'src/main.jsx' }), fileFixture({ path: 'docs/design.md' })],
    ...overrides,
  }
}

/**
 * `getCommits()` / `queryHistory()` 里的一条提交（parseCommits 的字段）。
 * @param {Record<string, unknown>} [overrides]
 */
export function commitFixture(overrides = {}) {
  return {
    hash: '1111111111111111111111111111111111111111',
    shortHash: '1111111',
    parents: ['0000000000000000000000000000000000000000'],
    subject: '修复暂存勾选与 Diff 选中互相污染',
    author: 'GitGlass Dev',
    authorEmail: 'dev@example.com',
    authoredAt: minutesAgo(3),
    refs: [],
    ...overrides,
  }
}

/**
 * `getCommitDetail()` 的返回值（含 `git show --shortstat` 的统计）。
 * @param {Record<string, unknown>} [overrides]
 */
export function commitDetailFixture(overrides = {}) {
  return {
    ok: true,
    hash: '1111111111111111111111111111111111111111',
    subject: '修复暂存勾选与 Diff 选中互相污染',
    message: '修复暂存勾选与 Diff 选中互相污染\n\n勾选集合改成 Set<area:path>，与 Diff 选中解耦。',
    authorName: 'GitGlass Dev',
    authorEmail: 'dev@example.com',
    authoredAt: minutesAgo(3),
    filesChanged: 2,
    insertions: 12,
    deletions: 3,
    changedFiles: [
      { status: 'M', path: 'src/main.jsx' },
      { status: 'A', path: 'docs/design.md' },
    ],
    ...overrides,
  }
}

/**
 * 命令账本里的一条记录（GitCommandService 的 history 条目）。
 * @param {Record<string, unknown>} [overrides]
 */
export function ledgerRecordFixture(overrides = {}) {
  const startedAt = minutesAgo(4)
  return {
    id: 'op-stage-1',
    source: 'user',
    intent: 'Stage file',
    displayCommand: 'git add -- src/main.jsx',
    command: 'git add -- src/main.jsx',
    argv: ['add', '--', 'src/main.jsx'],
    cwd: REPOSITORY_PATH,
    ok: true,
    exitCode: 0,
    startedAt,
    endedAt: new Date(Date.parse(startedAt) + 1200).toISOString(),
    stdout: ' M src/main.jsx',
    stderr: '',
    operationId: 'op-stage-1',
    ...overrides,
  }
}

/**
 * 一段真实的 unified diff，能产出一行文件头、两行换行、四行正文。
 * @param {string} [filePath]
 */
export function unifiedDiff(filePath = 'src/main.jsx') {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    'index 1111111..2222222 100644',
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    '@@ -1,2 +1,2 @@ function App()',
    '-const legacy = true',
    '+const modern = true',
    ' const shared = 1',
  ].join('\n')
}
