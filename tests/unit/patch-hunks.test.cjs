const { PATCH_ARGV, REASON_STALE_SNAPSHOT, hunkDiffArgs, hunkApplyArgs, diffSnapshot, parsePatchHunks, buildHunkPatch, locateHunk, describeHunks } = require('../../electron/patch-hunks.cjs')
const { normalizeHunkLocator, isRepositoryRelativePath } = require('../../electron/repository-service.cjs')

// 两处相距足够远的改动 → 两个独立的 Diff 块（与真实 git diff 的输出形状一致）。
const twoHunkDiff = [
  'diff --git a/src/app.js b/src/app.js',
  'index 1111111..2222222 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -1,6 +1,6 @@',
  ' line 1',
  ' line 2',
  '-line 3',
  '+line 3 edited',
  ' line 4',
  ' line 5',
  ' line 6',
  '@@ -28,7 +28,7 @@ function main()',
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

describe('hunk patch arguments', () => {
  it('pins prefix, context, colour, external diff and textconv for both areas', () => {
    // 展示与操作必须读到同一份补丁：这些参数就是「同一块」的定义。
    expect(hunkDiffArgs('unstaged', 'src/app.js')).toEqual([
      'diff', ...PATCH_ARGV, '--', 'src/app.js',
    ])
    expect(hunkDiffArgs('staged', 'src/app.js')).toEqual([
      'diff', '--cached', ...PATCH_ARGV, '--', 'src/app.js',
    ])
    expect(PATCH_ARGV).toEqual(['--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '-U3', '--inter-hunk-context=0'])
    // 路径始终在 -- 之后逐项传递，不拼接成命令字符串。
    expect(hunkDiffArgs('unstaged', '-dash name.txt').at(-2)).toBe('--')
    expect(hunkDiffArgs('unstaged', '-dash name.txt').at(-1)).toBe('-dash name.txt')
  })

  it('pins the apply flags that decide whether Git may rewrite the selected bytes', () => {
    // apply.whitespace=fix 会修剪行尾空白，apply.ignoreWhitespace 会放宽上下文匹配：
    // 两者都由这里的固定参数压掉，方向只决定是否反向应用。
    expect(hunkApplyArgs('stage')).toEqual(['apply', '--cached', '--whitespace=nowarn', '--no-ignore-whitespace', '-'])
    expect(hunkApplyArgs('unstage')).toEqual(['apply', '--cached', '--whitespace=nowarn', '--no-ignore-whitespace', '-R', '-'])
    // 补丁经 stdin 传入：argv 里没有路径，也没有块内容。
    expect(hunkApplyArgs('stage').join(' ')).not.toContain('.txt')
  })
})

describe('diff snapshot identity', () => {
  const base = { cwd: 'D:/repo', area: 'unstaged', filePath: 'a.txt', raw: twoHunkDiff }

  it('changes when the repository, area, path or diff bytes change', () => {
    const id = diffSnapshot(base)
    expect(id).toMatch(/^[0-9a-f]{64}$/)
    expect(diffSnapshot(base)).toBe(id)
    expect(diffSnapshot({ ...base, cwd: 'D:/other' })).not.toBe(id)
    expect(diffSnapshot({ ...base, area: 'staged' })).not.toBe(id)
    expect(diffSnapshot({ ...base, filePath: 'b.txt' })).not.toBe(id)
    expect(diffSnapshot({ ...base, raw: `${twoHunkDiff}\n` })).not.toBe(id)
  })
})

describe('parsePatchHunks', () => {
  it('numbers hunks in output order and keeps the file header verbatim', () => {
    const parsed = parsePatchHunks(twoHunkDiff)
    expect(parsed.ok).toBe(true)
    expect(parsed.header).toEqual(['diff --git a/src/app.js b/src/app.js', 'index 1111111..2222222 100644', '--- a/src/app.js', '+++ b/src/app.js'])
    expect(parsed.hunks.map((hunk) => [hunk.index, hunk.header, hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines])).toEqual([
      [0, '@@ -1,6 +1,6 @@', 1, 6, 1, 6],
      [1, '@@ -28,7 +28,7 @@ function main()', 28, 7, 28, 7],
    ])
    // 块体包含块头本身，内容摘要因此覆盖位置与内容两端。
    expect(parsed.hunks[0].lines[0]).toBe('@@ -1,6 +1,6 @@')
    expect(parsed.hunks[0].contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(parsed.hunks[0].contentHash).not.toBe(parsed.hunks[1].contentHash)
  })

  it('treats an omitted line count as one line', () => {
    const parsed = parsePatchHunks([
      'diff --git a/a.txt b/a.txt',
      'index 1..2 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -7 +7 @@',
      '-old',
      '+new',
      '',
    ].join('\n'))
    expect(parsed.ok).toBe(true)
    expect(parsed.hunks[0]).toMatchObject({ oldStart: 7, oldLines: 1, newStart: 7, newLines: 1 })
  })

  it('keeps CRLF bytes and the no-newline marker inside the hunk body', () => {
    const parsed = parsePatchHunks([
      'diff --git a/crlf.txt b/crlf.txt',
      'index 1..2 100644',
      '--- a/crlf.txt',
      '+++ b/crlf.txt',
      '@@ -1,2 +1,2 @@',
      ' one\r',
      '-two\r',
      '+two edited\r',
      '\\ No newline at end of file',
      '',
    ].join('\n'))
    expect(parsed.ok).toBe(true)
    expect(parsed.hunks[0].lines).toEqual(['@@ -1,2 +1,2 @@', ' one\r', '-two\r', '+two edited\r', '\\ No newline at end of file'])
    // \r 属于上一行内容，原样保留；末尾标记行属于块体，不能被当成新块头。
    expect(parsed.hunks).toHaveLength(1)
    expect(buildHunkPatch(parsed, 0)).toContain('+two edited\r\n\\ No newline at end of file\n')
  })

  it('keeps Git-quoted paths and the trailing tab of ---/+++ headers', () => {
    const quoted = [
      'diff --git "a/\\351\\205\\215\\347\\275\\256.txt" "b/\\351\\205\\215\\347\\275\\256.txt"',
      'index 1..2 100644',
      '--- "a/\\351\\205\\215\\347\\275\\256.txt"\t',
      '+++ "b/\\351\\205\\215\\347\\275\\256.txt"\t',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      '',
    ].join('\n')
    const parsed = parsePatchHunks(quoted)
    expect(parsed.ok).toBe(true)
    expect(parsed.header.at(-1)).toBe('+++ "b/\\351\\205\\215\\347\\275\\256.txt"\t')
  })

  it('rejects binary, added, deleted, renamed, unmerged and empty output with Chinese reasons', () => {
    const reasonOf = (lines) => parsePatchHunks(lines.join('\n'))
    expect(reasonOf([
      'diff --git a/bin.dat b/bin.dat',
      'index eaf36c1..95d586e 100644',
      'Binary files a/bin.dat and b/bin.dat differ',
    ])).toMatchObject({ ok: false, hunks: [], reason: expect.stringContaining('二进制') })
    expect(reasonOf([
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+new',
    ]).reason).toContain('新增、删除或重命名')
    expect(reasonOf([
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      'index 1111111..0000000',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-gone',
    ]).reason).toContain('新增、删除或重命名')
    expect(reasonOf([
      'diff --git a/old.txt b/new.txt',
      'similarity index 100%',
      'rename from old.txt',
      'rename to new.txt',
    ]).reason).toContain('新增、删除或重命名')
    expect(reasonOf([
      'diff --cc f.txt',
      'index 809cf25,e5e1b18..0000000',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@@ -7,7 -7,7 +7,11 @@@ line',
      '  line 7',
    ]).reason).toContain('未合并')
    expect(reasonOf(['diff --git a/mode.txt b/mode.txt', 'old mode 100644', 'new mode 100755']).reason).toContain('没有可操作的文本块')
    expect(parsePatchHunks('').reason).toContain('没有可操作的文本块')
    expect(parsePatchHunks('noise\n').reason).toContain('无法确认')
    // 多文件结果无法确认「一块」的范围。
    expect(parsePatchHunks(`${twoHunkDiff}${twoHunkDiff}`).reason).toContain('多个文件')
  })

  it('rejects a diff that mixes a mode change with text hunks', () => {
    // 文件头里的 old/new mode 会被 git apply 一并应用：只带一块的补丁也会改掉权限，
    // 反向应用则把权限改回去。首版直接拒绝，交给整文件流程。
    const mixed = [
      'diff --git a/tool.sh b/tool.sh',
      'old mode 100644',
      'new mode 100755',
      'index 8769499..d33945f',
      '--- a/tool.sh',
      '+++ b/tool.sh',
      '@@ -1,2 +1,2 @@',
      ' echo one',
      '-echo two',
      '+echo TWO',
      '',
    ].join('\n')
    expect(parsePatchHunks(mixed)).toMatchObject({ ok: false, hunks: [], reason: expect.stringContaining('权限变化') })
    expect(describeHunks(mixed)).toMatchObject({ ok: false, hunks: [] })
    // 名字里带 "old mode " 的路径不是权限行，仍可正常解析。
    const lookalike = [
      'diff --git a/old mode notes.txt b/old mode notes.txt',
      'index 1111111..2222222 100644',
      '--- a/old mode notes.txt',
      '+++ b/old mode notes.txt',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      '',
    ].join('\n')
    expect(parsePatchHunks(lookalike).ok).toBe(true)
  })

  it('refuses output that lost bytes to UTF-8 decoding instead of corrupting the file', () => {
    const mangled = [
      'diff --git a/gbk.txt b/gbk.txt',
      'index 1..2 100644',
      '--- a/gbk.txt',
      '+++ b/gbk.txt',
      '@@ -1 +1 @@',
      `-${String.fromCharCode(0xfffd)}`,
      `+${String.fromCharCode(0xfffd)}`,
      '',
    ].join('\n')
    expect(parsePatchHunks(mangled)).toMatchObject({ ok: false, hunks: [], reason: expect.stringContaining('编码') })
  })
})

describe('buildHunkPatch', () => {
  it('keeps only the requested hunk plus the file header', () => {
    const parsed = parsePatchHunks(twoHunkDiff)
    const patch = buildHunkPatch(parsed, 1)
    expect(patch.startsWith('diff --git a/src/app.js b/src/app.js\nindex 1111111..2222222 100644\n--- a/src/app.js\n+++ b/src/app.js\n@@ -28,7 +28,7 @@ function main()\n')).toBe(true)
    expect(patch).toContain('+line 31 edited')
    expect(patch).not.toContain('+line 3 edited')
    // 最后一行必须以换行结束，否则 Git 会认为补丁被截断。
    expect(patch.endsWith('\n')).toBe(true)
    expect(patch.endsWith('\n\n')).toBe(false)
  })

  it('returns null for a hunk that is not in this diff', () => {
    const parsed = parsePatchHunks(twoHunkDiff)
    expect(buildHunkPatch(parsed, 2)).toBeNull()
    expect(buildHunkPatch(parsed, -1)).toBeNull()
    expect(buildHunkPatch(null, 0)).toBeNull()
  })
})

describe('locateHunk', () => {
  const parsed = parsePatchHunks(twoHunkDiff)
  const locator = () => ({ index: 1, range: '@@ -28,7 +28,7 @@', contentHash: parsed.hunks[1].contentHash })

  it('locates by index and content hash, and reports which part moved', () => {
    expect(locateHunk(parsed, locator()).ok).toBe(true)
    // 定位不看块头文本：块头里的函数上下文永远不会成为请求的一部分。
    expect(locateHunk(parsed, { ...locator(), range: undefined }).ok).toBe(true)
    expect(locateHunk(parsed, { ...locator(), index: 9 }).reason).toContain('已不存在')
    expect(locateHunk(parsed, { ...locator(), range: '@@ -40,7 +40,7 @@' }).reason).toContain('位置已变化')
    expect(locateHunk(parsed, { ...locator(), contentHash: 'f'.repeat(64) }).reason).toContain('内容已变化')
    expect(locateHunk(parsed, { ...locator(), index: '1' }).reason).toContain('已不存在')
  })
})

describe('describeHunks', () => {
  it('hands the renderer locators without leaking the patch body or the hunk header context', () => {
    const described = describeHunks(twoHunkDiff)
    expect(described.ok).toBe(true)
    expect(described.reason).toBe('')
    // 第二块的块头带函数上下文；下发的只有行号范围，没有上下文。
    expect(described.hunks.map((hunk) => hunk.range)).toEqual(['@@ -1,6 +1,6 @@', '@@ -28,7 +28,7 @@'])
    expect(Object.keys(described.hunks[0]).sort()).toEqual(['contentHash', 'index', 'newLines', 'newStart', 'oldLines', 'oldStart', 'range'])
  })

  it('never publishes a hunk header that carries file content', () => {
    // 自定义 xfuncname（或函数名本身）可能让块头带上文件里的任意一行，包括像凭据的内容。
    const withContext = twoHunkDiff.replace('@@ -28,7 +28,7 @@ function main()', '@@ -28,7 +28,7 @@ TOKEN https://api.example.test?access_token=SECRET-42')
    const described = describeHunks(withContext)
    expect(described.ok).toBe(true)
    expect(described.hunks[1].range).toBe('@@ -28,7 +28,7 @@')
    expect(JSON.stringify(described)).not.toContain('SECRET-42')
    expect(JSON.stringify(described)).not.toContain('TOKEN')
  })

  it('carries the reason when the file cannot be staged by hunk', () => {
    expect(describeHunks('diff --git a/bin.dat b/bin.dat\nindex 1..2 100644\nBinary files a/bin.dat and b/bin.dat differ')).toMatchObject({ ok: false, hunks: [] })
  })
})

describe('hunk locator validation', () => {
  const snapshot = 'a'.repeat(64)
  const hunk = { index: 1, range: '@@ -28,7 +28,7 @@', contentHash: 'b'.repeat(64) }

  it('accepts the locator shape getDiff produces, including display line numbers', () => {
    expect(normalizeHunkLocator({ path: 'src/app.js', snapshot, hunk: { ...hunk, oldStart: 28, oldLines: 7, newStart: 28, newLines: 7 } })).toEqual({ ok: true, path: 'src/app.js', snapshot, hunk })
    // range 是可选的复核信息。
    expect(normalizeHunkLocator({ path: 'src/app.js', snapshot, hunk: { index: 1, contentHash: hunk.contentHash } })).toEqual({ ok: true, path: 'src/app.js', snapshot, hunk: { index: 1, contentHash: hunk.contentHash, range: '' } })
  })

  it('rejects anything the renderer must not be able to supply', () => {
    for (const input of [null, [], 'stage', 42]) {
      expect(normalizeHunkLocator(input)).toMatchObject({ ok: false, path: '', hunk: null })
    }
    // 额外字段（例如 argv、patch、绝对路径）一律拒绝：契约是窄的。
    expect(normalizeHunkLocator({ path: 'a.txt', snapshot, hunk, argv: ['add'] }).reason).toContain('不支持的内容')
    expect(normalizeHunkLocator({ path: 'a.txt', snapshot, hunk: { ...hunk, patch: 'x' } }).reason).toContain('不支持的内容')
    // 块头不是契约的一部分：连它一起回传会被拒绝，避免把函数上下文带进主进程。
    expect(normalizeHunkLocator({ path: 'a.txt', snapshot, hunk: { ...hunk, header: '@@ -28,7 +28,7 @@' } }).reason).toContain('不支持的内容')
    expect(normalizeHunkLocator({ path: 'C:/outside.txt', snapshot, hunk }).reason).toContain('相对路径')
    expect(normalizeHunkLocator({ path: '../escape.txt', snapshot, hunk }).reason).toContain('相对路径')
    expect(normalizeHunkLocator({ path: 'a.txt', snapshot: 'not-a-snapshot', hunk }).reason).toContain('Diff 版本标识')
    expect(normalizeHunkLocator({ path: 'a.txt', snapshot, hunk: null }).reason).toContain('缺少 Diff 块标识')
    expect(normalizeHunkLocator({ path: 'a.txt', snapshot, hunk: { ...hunk, index: -1 } }).reason).toContain('块编号无效')
    expect(normalizeHunkLocator({ path: 'a.txt', snapshot, hunk: { ...hunk, index: 1.5 } }).reason).toContain('块编号无效')
    expect(normalizeHunkLocator({ path: 'a.txt', snapshot, hunk: { ...hunk, range: 'not a range' } }).reason).toContain('块位置无效')
    expect(normalizeHunkLocator({ path: 'a.txt', snapshot, hunk: { ...hunk, contentHash: 'zz' } }).reason).toContain('块标识无效')
  })

  it('shares the repository-relative path rule with history filters', () => {
    expect(isRepositoryRelativePath('src/app.js')).toBe(true)
    expect(isRepositoryRelativePath('a/real dir/file.txt')).toBe(true)
    for (const value of ['', '.', '..', '/abs.txt', '\\\\server\\share', 'C:/x', 'a/../b', 'a/./b', null, 'bad\u0000path']) {
      expect(isRepositoryRelativePath(value), String(value)).toBe(false)
    }
  })
})

describe('stale snapshot reason', () => {
  it('asks the user to refresh instead of silently retrying', () => {
    expect(REASON_STALE_SNAPSHOT).toContain('刷新')
  })
})
