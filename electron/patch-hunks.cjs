const { createHash } = require('node:crypto')

// 选块暂存与取消暂存都建立在「同一次 Git Diff 输出」上：展示用的一次读取，
// 操作时主进程再读一次。任何本机配置（颜色、外部 Diff、textconv、前缀、上下文行数、
// 块间合并）都会改变输出，因此这里把补丁参数固定下来，两边必须逐字节一致。
// --src-prefix / --dst-prefix 固定协议前缀；-U3 固定上下文行数；
// --inter-hunk-context=0 保证「一个 Diff 块」不会因为配置被合并成大块。
const PATCH_ARGV = ['--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '-U3', '--inter-hunk-context=0']

// 应用补丁时必须逐字节照原样写进索引：
// --whitespace=nowarn 压掉本机 apply.whitespace 配置（fix 会改写行尾空白），
// --no-ignore-whitespace 压掉 apply.ignoreWhitespace（宽松匹配上下文），
// 两者都只影响「怎么应用」，不改变补丁内容。
const APPLY_ARGV = ['--cached', '--whitespace=nowarn', '--no-ignore-whitespace']

// Git 的 hunk 头：@@ -旧起始,旧行数 +新起始,新行数 @@ 可选标题。行数省略时为 1。
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: ?(.*))?$/
// 未合并索引的块头是 @@@（两个父提交），首版不处理。
const COMBINED_HEADER = /^@@@/
// 未合并文件的文件头是 `diff --cc` / `diff --combined`；`git diff --cached`
// 对未合并路径只输出 `* Unmerged path <path>`，没有可应用的块。
const COMBINED_FILE_HEADER = /^diff --(?:cc|combined) /m
const UNMERGED_PATH_LINE = /^\* Unmerged path /m
// Node 用 U+FFFD 替换无法按 UTF-8 解码的字节。补丁必须逐字节送回 Git，一旦出现
// 替换字符就说明再编码会改变文件内容，此时只能拒绝按块操作而不是冒险写入索引。
const REPLACEMENT_CHARACTER = '\uFFFD'

const REASON_STALE_SNAPSHOT = 'Diff 已过期：读取之后工作区或仓库发生了变化，请刷新后重试。'
const REASON_UNMERGED = '该文件处于未合并状态，暂不支持按块操作。请先解决冲突。'
const REASON_BINARY = '这是二进制或无法按文本显示的差异，暂不支持按块操作。请使用整文件操作。'
const REASON_NO_HUNKS = '没有可操作的文本块：文件可能只有权限变化、为空差异或输出不可用。'
const REASON_ENCODING = '此文件的差异包含无法识别的编码字节，按块操作可能改坏文件。请使用整文件操作。'
const REASON_MULTIPLE_FILES = 'Diff 中包含多个文件，无法确认块范围。请刷新后重试。'
const REASON_TRUNCATED = 'Diff 已截断，无法确认块的完整范围。请使用整文件操作。'
const REASON_UNKNOWN_OUTPUT = '无法确认这段 Diff 的块范围。请刷新后重试，或使用整文件操作。'
const REASON_ADDED_OR_DELETED = '新增、删除或重命名的文件暂不支持按块操作。请使用整文件操作。'
const REASON_MODE_CHANGE = '此文件同时包含权限变化与文本块，按块操作会连权限一起改动，首版不支持。请使用整文件操作。'

/**
 * 一个 Diff 块：块头、位置、原样块体与内容摘要。`index` 是它在本次输出里的序号。
 * @typedef {object} ParsedHunk
 * @property {number} index
 * @property {string} header
 * @property {number} oldStart
 * @property {number} oldLines
 * @property {number} newStart
 * @property {number} newLines
 * @property {string[]} lines
 * @property {string} contentHash
 */

/**
 * 解析结果。`ok` 为假时 `reason` 是可以直接展示的中文原因；成功时 `reason` 为空串。
 * 形状恒定，调用方不必处理「字段是否存在」。
 * @typedef {object} ParsedPatch
 * @property {boolean} ok
 * @property {string} reason
 * @property {string[]} header
 * @property {ParsedHunk[]} hunks
 */

/**
 * @param {string} reason
 * @returns {ParsedPatch}
 */
function rejectedPatch(reason) { return { ok: false, reason, header: [], hunks: [] } }

function sha256(value) { return createHash('sha256').update(value, 'utf8').digest('hex') }

/**
 * 执行按块操作的固定 argv。方向决定正向应用（暂存）还是反向应用（取消暂存）。
 * 补丁本身经 stdin 传入，所以 argv 里只有固定开关和 `-`。
 * @param {'stage' | 'unstage'} direction
 * @returns {string[]}
 */
function hunkApplyArgs(direction) {
  return ['apply', ...APPLY_ARGV, ...(direction === 'unstage' ? ['-R'] : []), '-']
}

/**
 * 读取某个文件 Diff 的固定 argv。区域决定比较对象：
 * unstaged = 「索引 → 工作区」，staged = 「HEAD → 索引」。
 * @param {string} area
 * @param {string} filePath
 * @returns {string[]}
 */
function hunkDiffArgs(area, filePath) {
  const argv = ['diff']
  if (area === 'staged') argv.push('--cached')
  return [...argv, ...PATCH_ARGV, '--', filePath]
}

/**
 * 「哪一次读取」的标识：仓库路径、区域、文件路径与原始 Diff 字节共同决定。
 * 切换仓库、切换区域、文件变化、索引变化都会得到不同的值，旧请求因此被拒绝。
 * @param {{ cwd: string, area: string, filePath: string, raw: string }} input
 * @returns {string}
 */
function diffSnapshot({ cwd, area, filePath, raw }) {
  return sha256([cwd, area, filePath, raw].join('\u0000'))
}

/**
 * 把一段原始 Diff 解析成「文件头 + 若干块」。首版只接受单个文件、单个或多个
 * 真实 hunk 的标准 Diff；其余输出一律给出中文原因，交给整文件流程。
 * @param {string} raw
 * @returns {ParsedPatch}
 */
function parsePatchHunks(raw) {
  const text = String(raw ?? '')
  if (!text) return rejectedPatch(REASON_NO_HUNKS)
  if (text.includes(REPLACEMENT_CHARACTER)) return rejectedPatch(REASON_ENCODING)
  if (COMBINED_FILE_HEADER.test(text) || UNMERGED_PATH_LINE.test(text)) return rejectedPatch(REASON_UNMERGED)
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  /** @type {Array<{ header: string[], hunks: Array<{ header: string, lines: string[] }> }>} */
  const sections = []
  /** @type {{ header: string[], hunks: Array<{ header: string, lines: string[] }> } | null} */
  let section = null
  for (const line of lines) {
    if (line.startsWith('diff --')) {
      // 只接受标准 `diff --git` 文件头；其余（`diff --stat`、`diff --raw` 等）
      // 无法承载可应用的补丁。
      if (COMBINED_HEADER.test(line) || !line.startsWith('diff --git ')) return rejectedPatch(REASON_UNKNOWN_OUTPUT)
      section = { header: [line], hunks: [] }
      sections.push(section)
      continue
    }
    if (!section) return rejectedPatch(REASON_UNKNOWN_OUTPUT)
    const hunk = HUNK_HEADER.exec(line)
    if (hunk) {
      section.hunks.push({ header: line, lines: [line] })
      continue
    }
    const lastHunk = section.hunks.at(-1)
    if (lastHunk) lastHunk.lines.push(line)
    else section.header.push(line)
  }
  if (sections.length > 1) return rejectedPatch(REASON_MULTIPLE_FILES)
  if (!sections.length) return rejectedPatch(REASON_UNKNOWN_OUTPUT)
  const [only] = sections
  const headerText = only.header.join('\n')
  if (headerText.includes('new file mode') || headerText.includes('deleted file mode') || headerText.includes('rename from ')) {
    return rejectedPatch(REASON_ADDED_OR_DELETED)
  }
  if (headerText.includes('Binary files ') || headerText.includes('GIT binary patch')) return rejectedPatch(REASON_BINARY)
  if (!only.hunks.length) return rejectedPatch(REASON_NO_HUNKS)
  // 文件头里的 old/new mode 会被 git apply 一并应用：只带一块的补丁也会顺手改掉
  // 索引里的权限（反向应用则把权限改回去）。首版对这种混合 Diff 直接拒绝，让整文件
  // 流程去处理；只比较整行，避免把名字里含 "old mode " 的路径误判。
  if (only.header.some((line) => line.startsWith('old mode ') || line.startsWith('new mode '))) return rejectedPatch(REASON_MODE_CHANGE)
  const hunks = only.hunks.map((hunk, index) => {
    const match = HUNK_HEADER.exec(hunk.header) ?? []
    const lines = hunk.lines
    return {
      index,
      header: hunk.header,
      oldStart: Number(match[1] ?? 0),
      oldLines: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3] ?? 0),
      newLines: match[4] === undefined ? 1 : Number(match[4]),
      lines,
      contentHash: sha256(lines.join('\n')),
    }
  })
  return { ok: true, reason: '', header: only.header, hunks }
}

/**
 * 只保留目标块的最小补丁：文件头 + 该块。文件头的 ---/+++ 与 index 行必须保留，
 * `\ No newline at end of file` 这类标记行属于块体，原样带走。
 * @param {ParsedPatch} parsed
 * @param {number} index
 * @returns {string | null}
 */
function buildHunkPatch(parsed, index) {
  const hunk = parsed?.hunks?.[index]
  if (!hunk) return null
  const body = [...parsed.header, ...hunk.lines].join('\n')
  return body.endsWith('\n') ? body : `${body}\n`
}

/**
 * 块的「范围」文本：只由行号组成，永远不含块头里的函数上下文。
 * 行数为 1 时 Git 省略 `,1`，这里保持一致，审计记录才能和 Git 输出对得上。
 * @param {{ oldStart: number, oldLines: number, newStart: number, newLines: number }} hunk
 * @returns {string}
 */
function hunkRange(hunk) {
  const span = (start, lines) => (lines === 1 ? `${start}` : `${start},${lines}`)
  return `@@ -${span(hunk.oldStart, hunk.oldLines)} +${span(hunk.newStart, hunk.newLines)} @@`
}

/**
 * 校验请求里的块标识仍然指向本次读取的同一块。定位只用「块序号 + 内容摘要」，
 * 不看块头文本：块头里可能带文件的函数上下文（甚至看起来像凭据的内容），
 * 它绝对不能成为 IPC 或账本的一部分。
 * @param {ParsedPatch} parsed
 * @param {{ index: number, contentHash: string, range?: string }} locator
 * @returns {{ ok: boolean, reason: string, hunk: ParsedHunk | null }}
 */
function locateHunk(parsed, locator) {
  const hunk = Number.isSafeInteger(locator?.index) ? parsed?.hunks?.[locator.index] : null
  if (!hunk) return { ok: false, reason: '所选 Diff 块已不存在，请刷新后重试。', hunk: null }
  // 界面回传的行号范围只用于复核位置；真正判重的是内容摘要。
  if (typeof locator.range === 'string' && locator.range && locator.range !== hunkRange(hunk)) {
    return { ok: false, reason: '所选 Diff 块的位置已变化，请刷新后重试。', hunk: null }
  }
  if (hunk.contentHash !== locator.contentHash) return { ok: false, reason: '所选 Diff 块的内容已变化，请刷新后重试。', hunk: null }
  return { ok: true, reason: '', hunk }
}

/**
 * 展示 Diff 时随记录一起下发的块清单。不可按块操作时给出中文原因，界面据此隐藏入口。
 * 每条只包含序号、行号范围与内容摘要：块头里的函数上下文留在主进程，绝不随 IPC 出去。
 * @param {string} raw
 * @returns {{ ok: boolean, reason: string, hunks: Array<{ index: number, range: string, oldStart: number, oldLines: number, newStart: number, newLines: number, contentHash: string }> }}
 */
function describeHunks(raw) {
  const parsed = parsePatchHunks(raw)
  if (!parsed.ok) return { ok: false, reason: parsed.reason, hunks: [] }
  return {
    ok: true,
    reason: '',
    hunks: parsed.hunks.map((hunk) => ({
      index: hunk.index,
      range: hunkRange(hunk),
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      contentHash: hunk.contentHash,
    })),
  }
}

module.exports = {
  PATCH_ARGV,
  APPLY_ARGV,
  REASON_STALE_SNAPSHOT,
  REASON_TRUNCATED,
  REASON_MODE_CHANGE,
  hunkDiffArgs,
  hunkApplyArgs,
  hunkRange,
  diffSnapshot,
  parsePatchHunks,
  buildHunkPatch,
  locateHunk,
  describeHunks,
}
