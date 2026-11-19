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
