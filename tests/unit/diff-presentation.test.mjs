import { describe, expect, it } from 'vitest'
import { presentDiff } from '../../src/diff-presentation.js'

// 用数组拼 patch：每一行的前缀（空格 / + / -）都是断言的一部分，不能被缩进吃掉。
const patch = (...lines) => `${lines.join('\n')}\n`

describe('review-oriented diff presentation', () => {
  it('replaces the three protocol header lines with one breadcrumb and shows both line coordinates', () => {
    const rows = presentDiff(patch(
      'diff --git a/GUIDE.md b/GUIDE.md',
      'index 78302fe..986b6fa 100644',
      '--- a/GUIDE.md',
      '+++ b/GUIDE.md',
      '@@ -11,3 +11,4 @@ This repository',
      ' unchanged',
      '-before',
      '+after',
      '+added',
      ' tail',
    ))
    expect(rows).toMatchObject([
      { type: 'file', content: 'GUIDE.md' },
      { type: 'hunk', content: '旧版第 11–13 行 → 新版第 11–14 行 · This repository' },
      { type: 'context', oldLine: 11, newLine: 11, content: 'unchanged' },
      { type: 'minus', oldLine: 12, newLine: null, content: 'before' },
      { type: 'plus', oldLine: null, newLine: 12, content: 'after' },
      { type: 'plus', oldLine: null, newLine: 13, content: 'added' },
      { type: 'context', oldLine: 13, newLine: 14, content: 'tail' },
    ])
    // 文件头只占一行：没有「文件 / 原文件 / 新文件」三行，也没有 index 行。
    expect(rows.filter((row) => row.type === 'file')).toHaveLength(1)
    expect(rows.some((row) => row.content?.startsWith('index '))).toBe(false)
    expect(rows.some((row) => row.type.startsWith('file-path'))).toBe(false)
  })

  it('renders a rename as old → new on the same breadcrumb row', () => {
    const rows = presentDiff(patch(
      'diff --git a/src/old-name.js b/src/new-name.js',
      'similarity index 96%',
      'rename from src/old-name.js',
      'rename to src/new-name.js',
      'index 1111111..2222222 100644',
      '--- a/src/old-name.js',
      '+++ b/src/new-name.js',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ))
    expect(rows[0]).toMatchObject({ type: 'file', content: 'src/old-name.js → src/new-name.js' })
    expect(rows.filter((row) => row.type === 'file')).toHaveLength(1)
    // 重命名信息已经并在面包屑里，不再单独渲染「重命名前 / 重命名后」两行。
    expect(rows.some((row) => row.label === '重命名前' || row.label === '重命名后')).toBe(false)
  })

  it('keeps one breadcrumb for added and deleted files instead of /dev/null lines', () => {
    const added = presentDiff(patch(
      'diff --git a/docs/new.md b/docs/new.md',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/docs/new.md',
      '@@ -0,0 +1 @@',
      '+hello',
    ))
    expect(added[0]).toMatchObject({ type: 'file', content: 'docs/new.md' })
    expect(added[1]).toMatchObject({ type: 'metadata', label: '新增文件' })
    expect(added.some((row) => row.content?.includes('/dev/null'))).toBe(false)

    const deleted = presentDiff(patch(
      'diff --git a/gone.md b/gone.md',
      'deleted file mode 100644',
      'index 1111111..0000000',
      '--- a/gone.md',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
    ))
    expect(deleted[0]).toMatchObject({ type: 'file', content: 'gone.md' })
    expect(deleted.some((row) => row.content?.includes('/dev/null'))).toBe(false)
  })

  it('treats --- and +++ inside a hunk as changed lines, not as another file header', () => {
    const rows = presentDiff(patch(
      'diff --git a/notes.md b/notes.md',
      '--- a/notes.md',
      '+++ b/notes.md',
      '@@ -1,2 +1,2 @@',
      '--- old bullet',
      '+++ new bullet',
      ' plain',
    ))
    expect(rows.filter((row) => row.type === 'file')).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: 'file', content: 'notes.md' })
    expect(rows[2]).toMatchObject({ type: 'minus', oldLine: 1, content: '-- old bullet' })
    expect(rows[3]).toMatchObject({ type: 'plus', newLine: 1, content: '++ new bullet' })
    expect(rows[4]).toMatchObject({ type: 'context', oldLine: 2, newLine: 2, content: 'plain' })
  })

  it('shows change lines from a patch without hunk headers and copes with an empty diff', () => {
    expect(presentDiff(patch('+hello'))).toMatchObject([{ type: 'plus', content: 'hello' }])
    expect(presentDiff('')).toEqual([])
  })
})

describe('diff file header de-duplication', () => {
  const singleFilePatch = patch(
    'diff --git a/src/settings/configuration.ts b/src/settings/configuration.ts',
    'index 1111111..2222222 100644',
    '--- a/src/settings/configuration.ts',
    '+++ b/src/settings/configuration.ts',
    '@@ -1 +1 @@',
    '-retryLimit: 2,',
    '+retryLimit: 3,',
  )

  it('drops the header when the title already points at the same path', () => {
    const rows = presentDiff(singleFilePatch, { dropFileHeaderFor: 'src/settings/configuration.ts' })
    expect(rows.some((row) => row.type === 'file')).toBe(false)
    expect(rows[0]).toMatchObject({ type: 'hunk' })
  })

  it('matches on the parsed repository path and never strips a/ b/ twice', () => {
    // 平台分隔符归一化后仍然算同一个文件。
    const rows = presentDiff(singleFilePatch, { dropFileHeaderFor: 'src\\settings/configuration.ts' })
    expect(rows.some((row) => row.type === 'file')).toBe(false)
    // 解析时已经剥过一次 a/ b/ 前缀：标题里再带一个 a/ 或 b/ 就是另一个路径（真实目录），不去重。
    expect(presentDiff(singleFilePatch, { dropFileHeaderFor: 'b/src/settings/configuration.ts' })
      .some((row) => row.type === 'file')).toBe(true)
    expect(presentDiff(singleFilePatch, { dropFileHeaderFor: 'a/src/settings/configuration.ts' })
      .some((row) => row.type === 'file')).toBe(true)
  })

  it('keeps real a/ and b/ directories and still de-duplicates them', () => {
    const patchUnderA = patch(
      'diff --git a/a/real-a.md b/a/real-a.md',
      'index 1111111..2222222 100644',
      '--- a/a/real-a.md',
      '+++ b/a/real-a.md',
      '@@ -1 +1 @@',
      '-before',
      '+after',
    )
    // 协议前缀只剥一层，所以文件在仓库里的真实路径是 a/real-a.md。
    const rows = presentDiff(patchUnderA)
    expect(rows[0]).toMatchObject({ type: 'file', content: 'a/real-a.md' })
    expect(presentDiff(patchUnderA, { dropFileHeaderFor: 'a/real-a.md' }).some((row) => row.type === 'file')).toBe(false)
    // 顶层同名文件是另一个路径，不能被当成重复头去掉。
    expect(presentDiff(patchUnderA, { dropFileHeaderFor: 'real-a.md' }).some((row) => row.type === 'file')).toBe(true)
  })

  it('decodes the C-style quoted paths Git emits for non-ASCII names', () => {
    // Git（core.quotePath 默认开启）会把中文路径写成八进制转义：
    //   配置.md → "a/\351\205\215\347\275\256.md"
    const patchWithChinesePath = patch(
      'diff --git "a/\\351\\205\\215\\347\\275\\256.md" "b/\\351\\205\\215\\347\\275\\256.md"',
      'index 1111111..2222222 100644',
      '--- "a/\\351\\205\\215\\347\\275\\256.md"',
      '+++ "b/\\351\\205\\215\\347\\275\\256.md"',
      '@@ -1 +1 @@',
      '-旧',
      '+新',
    )
    // 未去重时：只有一条文件头，内容是真实的仓库相对路径（不是转义串）。
    const rows = presentDiff(patchWithChinesePath)
    expect(rows.filter((row) => row.type === 'file')).toHaveLength(1)
    expect(rows[0].content).toBe('配置.md')
    // 工作区单文件视图：标题与文件头指向同一路径，重复头被去掉。
    expect(presentDiff(patchWithChinesePath, { dropFileHeaderFor: '配置.md' })
      .some((row) => row.type === 'file')).toBe(false)
  })

  it('keeps spaces inside the path instead of treating them as separators', () => {
    const spaced = patch(
      'diff --git a/guide for project.md b/guide for project.md',
      'index 1111111..2222222 100644',
      '--- a/guide for project.md',
      '+++ b/guide for project.md',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    )
    expect(presentDiff(spaced)[0]).toMatchObject({ type: 'file', content: 'guide for project.md' })
    expect(presentDiff(spaced, { dropFileHeaderFor: 'guide for project.md' })
      .some((row) => row.type === 'file')).toBe(false)
  })

  it('keeps the header when the path differs, when there are several files, or nothing is asked', () => {
    expect(presentDiff(singleFilePatch).some((row) => row.type === 'file')).toBe(true)
    expect(presentDiff(singleFilePatch, { dropFileHeaderFor: 'src/other.ts' }).some((row) => row.type === 'file')).toBe(true)
    const twoFiles = patch(
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1 +1 @@',
      '-c',
      '+d',
    )
    // 多文件结果（例如历史对比）每个文件都保留自己的文件头。
    expect(presentDiff(twoFiles, { dropFileHeaderFor: 'a.ts' }).filter((row) => row.type === 'file')).toHaveLength(2)
  })

  it('never drops the「旧 → 新」breadcrumb of a rename', () => {
    const renamed = patch(
      'diff --git a/src/old-name.js b/src/new-name.js',
      'similarity index 96%',
      'rename from src/old-name.js',
      'rename to src/new-name.js',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    )
    const rows = presentDiff(renamed, { dropFileHeaderFor: 'src/old-name.js' })
    expect(rows[0]).toMatchObject({ type: 'file', content: 'src/old-name.js → src/new-name.js' })
  })
})
