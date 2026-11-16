import { describe, expect, it } from 'vitest'
import { presentDiff } from '../src/diff-presentation.js'

describe('review-oriented diff presentation', () => {
  it('replaces Git protocol headers with Chinese labels and shows both line coordinates', () => {
    const rows = presentDiff(`diff --git a/GUIDE.md b/GUIDE.md
index 78302fe..986b6fa 100644
--- a/GUIDE.md
+++ b/GUIDE.md
@@ -11,3 +11,4 @@ This repository
 unchanged
-before
+after
+added
 tail
`)
    expect(rows).toMatchObject([
      { type: 'file', label: '文件', content: 'GUIDE.md' },
      { type: 'file-path old', label: '原文件', content: 'GUIDE.md' },
      { type: 'file-path new', label: '新文件', content: 'GUIDE.md' },
      { type: 'hunk', content: '旧版第 11–13 行 → 新版第 11–14 行 · This repository' },
      { type: 'context', oldLine: 11, newLine: 11, content: 'unchanged' },
      { type: 'minus', oldLine: 12, newLine: null, content: 'before' },
      { type: 'plus', oldLine: null, newLine: 12, content: 'after' },
      { type: 'plus', oldLine: null, newLine: 13, content: 'added' },
      { type: 'context', oldLine: 13, newLine: 14, content: 'tail' },
    ])
    expect(rows.some((row) => row.content?.startsWith('index '))).toBe(false)
  })
})
