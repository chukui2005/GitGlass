const hunkPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: ?(.*))?$/

// Git 在 patch 头里用 C 风格引号包住「不寻常」的路径：中文、引号、控制字符都会这样输出，
// 非 ASCII 字节写成八进制（core.quotePath 默认开启），例如：
//   diff --git "a/\351\205\215\347\275\256.md" "b/\351\205\215\347\275\256.md"
// 这里把它还原成真实路径。未加引号的路径原样返回——路径里的空格是文件名的一部分。
const SIMPLE_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

function decodeUtf8Bytes(bytes) {
  if (typeof TextDecoder === "function") {
    try {
      return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
    } catch {
      // 落到下面的兜底：至少不抛错，界面仍有可读内容。
    }
  }
  return bytes.map((byte) => String.fromCharCode(byte)).join("");
}

// Git 只把「不寻常」的字符写成八进制，字面字符基本都是 ASCII；编码器缺失时按单字节处理即可。
function encodeLiteralBytes(text) {
  if (typeof TextEncoder === "function") return Array.from(new TextEncoder().encode(text));
  return Array.from(text, (character) => character.charCodeAt(0) & 0xff);
}

function unquotePath(value) {
  const text = String(value || "");
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text;
  const body = text.slice(1, -1);
  const bytes = [];
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character !== "\\") {
      for (const byte of encodeLiteralBytes(character)) bytes.push(byte);
      continue;
    }
    const next = body[index + 1];
    if (next >= "0" && next <= "7") {
      const octal = body.slice(index + 1, index + 4).match(/^[0-7]{1,3}/)[0];
      bytes.push(Number.parseInt(octal, 8) & 0xff);
      index += octal.length;
      continue;
    }
    bytes.push(SIMPLE_ESCAPES[next] ?? (next ? next.charCodeAt(0) : 92));
    index += 1;
  }
  return decodeUtf8Bytes(bytes);
}

// 取出 patch 头里的一个路径 token：
// - 引号形式（Git 对非 ASCII / 含引号的路径会这样写）整条都在引号内；
// - 未加引号时，Git 会用一个制表符把「含空格的路径」与后面的字段隔开，那个制表符是协议分隔符；
// - 行尾的 \r 来自 CRLF 换行，同样不属于路径。
function pathToken(value) {
  const text = String(value ?? "");
  if (text.startsWith('"')) {
    const end = text.lastIndexOf('"');
    return unquotePath(end > 0 ? text.slice(0, end + 1) : text);
  }
  return text.replace(/\r$/, "").replace(/\t$/, "");
}

// 只去掉一层 Git 的 a/ b/ 前缀（这是 patch 头的协议前缀，真实目录 a/、b/ 会因此保留下来）。
// /dev/null 表示这一侧没有文件（新增或删除），面包屑里不显示。
function pathLabel(path) {
  const text = pathToken(path);
  if (text === "/dev/null") return "";
  return text.replace(/^[ab]\//, "");
}

// rename from/to 的路径不带 a/ b/ 前缀，不能再剥，否则会把 "a/foo" 这类真实路径改坏。
function rawPath(path) {
  const text = pathToken(path);
  return text === "/dev/null" ? "" : text;
}

// 一个文件只留一行面包屑：改动用路径本身，重命名用「旧 → 新」。
function breadcrumb(oldPath, newPath) {
  if (oldPath && newPath && oldPath !== newPath) return `${oldPath} → ${newPath}`
  return newPath || oldPath || '（无路径）'
}

function metadataRow(line) {
  if (line.startsWith('index ')) return null
  if (line.startsWith('new file mode ')) return { type: 'metadata', label: '新增文件', content: `权限 ${line.slice(14)}` }
  if (line.startsWith('deleted file mode ')) return { type: 'metadata', label: '删除文件', content: `权限 ${line.slice(18)}` }
  if (line.startsWith('old mode ')) return { type: 'metadata', label: '原文件权限', content: line.slice(9) }
  if (line.startsWith('new mode ')) return { type: 'metadata', label: '新文件权限', content: line.slice(9) }
  if (line.startsWith('similarity index ')) return { type: 'metadata', label: '内容相似度', content: line.slice(17) }
  if (/^Binary files .+ differ$/.test(line)) return { type: 'binary', label: '二进制文件差异', content: 'Git 无法生成文本内容' }
  if (line === '\\ No newline at end of file') return { type: 'metadata', label: '文件提示', content: '文件末尾没有换行符' }
  return { type: 'metadata', label: 'Git 信息', content: line }
}

// `diff --git <old> <new>`：两侧都可能带引号（非 ASCII / 含引号的路径），也可能都不带。
// 未加引号时按最后一个 ` b/` 切开 —— 路径里的空格属于文件名，不能当分隔符。
// 这个结果只用于「发现新文件 + 初始路径」；紧随其后的 ---/+++ 与 rename from/to 会给出更准的路径。
function parseDiffGitPaths(line) {
  const rest = line.slice('diff --git '.length)
  const quoted = /^("(?:[^"\\]|\\.)*")\s+("(?:[^"\\]|\\.)*")$/.exec(rest)
  if (quoted) return { old: quoted[1], new: quoted[2] }
  const separator = rest.lastIndexOf(' b/')
  if (separator <= 0) return null
  return { old: rest.slice(0, separator), new: rest.slice(separator + 1) }
}

/**
 * One rendered diff row. The file row only carries the breadcrumb in `content`;
 * hunk rows keep the raw `@@ … @@` header in `rawHeader` so the workbench can map
 * a rendered block back to the locator the main process published; hunk and line
 * rows add the review locators (`oldLine`/`newLine`/`marker`), metadata rows add
 * a Chinese `label`.
 * @typedef {object} DiffRow
 * @property {string} type
 * @property {string} [label]
 * @property {string} [rawHeader]
 * @property {number | null} [oldLine]
 * @property {number | null} [newLine]
 * @property {string} [marker]
 * @property {string} content
 */

// 工作区单文件视图的标题已经承载了路径：此时 patch 里那行「一模一样」的文件头是重复信息。
// 只有一条文件头、且路径与标题确认指向同一个文件时才去掉；重命名（含「旧 → 新」）、
// 多文件结果一律保留各自的文件头。
// 比较的是**解析后的完整仓库相对路径**：a/ b/ 前缀在解析时已经剥过一次，这里不再二次剥离，
// 否则真实存在的 a/、b/ 目录会被误判成同一路径。
const comparablePath = (value) => String(value || "").replace(/\r$/, "").replace(/\\/g, "/");

export function redundantFileHeader(rows, path) {
  const headers = rows.filter((row) => row.type === 'file');
  if (headers.length !== 1) return null;
  const [header] = headers;
  if (!comparablePath(path)) return null;
  return comparablePath(header.content) === comparablePath(path) ? header : null;
}

// 原始 patch 不会被修改；此处只把协议字段转为中文，并补上审阅定位所需的旧/新行号。
// 文件头的 diff --git / --- / +++ / rename 四类行都写回同一个 row，所以头部只占一行面包屑。
/**
 * @param {string} diff
 * @param {{ dropFileHeaderFor?: string }} [options] 与标题重复的文件头路径
 * @returns {DiffRow[]}
 */
export function presentDiff(diff, options = {}) {
  const lines = String(diff || '').split('\n')
  if (lines.at(-1) === '') lines.pop()
  /** @type {DiffRow[]} */
  const rows = []
  let oldLine = null
  let newLine = null
  // hunk 内的 ---/+++ 是删改内容，不是文件头，所以要看当前是否还在 hunk 里。
  let inHunk = false
  // 当前文件的面包屑行：路径多次到达时都写回这一行的 content。
  /** @type {DiffRow | null} */
  let fileRow = null
  let oldPath = ''
  let newPath = ''
  let headerComplete = true

  const beginFile = () => {
    oldPath = ''
    newPath = ''
    headerComplete = false
    fileRow = { type: 'file', content: breadcrumb('', '') }
    rows.push(fileRow)
  }
  /** @param {{ old?: string, new?: string, done?: boolean }} next */
  const setPaths = (next) => {
    if (!fileRow) beginFile()
    if (next.old !== undefined) oldPath = next.old
    if (next.new !== undefined) newPath = next.new
    if (next.done) headerComplete = true
    fileRow.content = breadcrumb(oldPath, newPath)
  }
  // 改动行（+ / − / 上下文）。返回 false 表示这一行不是改动行。
  const pushChangeRow = (line) => {
    if (line.startsWith('+')) {
      rows.push({ type: 'plus', oldLine: null, newLine, marker: '+', content: line.slice(1) })
      newLine = newLine === null ? null : newLine + 1
      return true
    }
    if (line.startsWith('-')) {
      rows.push({ type: 'minus', oldLine, newLine: null, marker: '−', content: line.slice(1) })
      oldLine = oldLine === null ? null : oldLine + 1
      return true
    }
    if (line.startsWith(' ')) {
      rows.push({ type: 'context', oldLine, newLine, marker: ' ', content: line.slice(1) })
      oldLine = oldLine === null ? null : oldLine + 1
      newLine = newLine === null ? null : newLine + 1
      return true
    }
    return false
  }

  for (const line of lines) {
    const hunk = hunkPattern.exec(line)
    if (hunk) {
      const [, oldStart, oldCount = '1', newStart, newCount = '1', heading = ''] = hunk
      oldLine = Number(oldStart)
      newLine = Number(newStart)
      const oldEnd = oldLine + Number(oldCount) - 1
      const newEnd = newLine + Number(newCount) - 1
      rows.push({ type: 'hunk', rawHeader: line, oldLine: null, newLine: null, marker: '…', content: `旧版第 ${oldLine}${oldEnd === oldLine ? '' : `–${oldEnd}`} 行 → 新版第 ${newLine}${newEnd === newLine ? '' : `–${newEnd}`} 行${heading ? ` · ${heading}` : ''}` })
      inHunk = true
      continue
    }
    if (inHunk) {
      if (pushChangeRow(line)) continue
      inHunk = false
    }
    if (line.startsWith('diff --git ')) {
      const paths = parseDiffGitPaths(line)
      beginFile()
      if (paths) setPaths({ old: pathLabel(paths.old), new: pathLabel(paths.new) })
      continue
    }
    // 没有 diff --git 头的 patch（例如 --no-prefix）：上一份文件头已完整时，这一行开始新文件。
    if (line.startsWith('--- ')) {
      if (headerComplete) beginFile()
      setPaths({ old: pathLabel(line.slice(4)) })
      continue
    }
    if (line.startsWith('+++ ')) {
      setPaths({ new: pathLabel(line.slice(4)), done: true })
      continue
    }
    // 纯重命名没有 ---/+++，只有 rename from/to：面包屑同样要显示「旧 → 新」。
    if (line.startsWith('rename from ')) {
      setPaths({ old: rawPath(line.slice(12)) })
      continue
    }
    if (line.startsWith('rename to ')) {
      setPaths({ new: rawPath(line.slice(10)) })
      continue
    }
    // 没有 hunk 头的 +/- 输出（截断或手工拼的 patch）仍按改动行展示。
    if (pushChangeRow(line)) continue
    const row = metadataRow(line)
    if (row) rows.push(row)
  }
  const redundant = options.dropFileHeaderFor
    ? redundantFileHeader(rows, options.dropFileHeaderFor)
    : null
  return redundant ? rows.filter((row) => row !== redundant) : rows
}
