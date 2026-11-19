const hunkPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: ?(.*))?$/

// 只去掉 Git 的 a/ b/ 前缀；/dev/null 表示这一侧没有文件（新增或删除），面包屑里不显示。
function pathLabel(path) {
  const text = String(path || '').trim()
  return text === '/dev/null' ? '' : text.replace(/^[ab]\//, '')
}

// rename from/to 的路径不带 a/ b/ 前缀，不能再剥，否则会把 "a/foo" 这类真实路径改坏。
function rawPath(path) {
  const text = String(path || '').trim()
  return text === '/dev/null' ? '' : text
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

/**
 * One rendered diff row. The file row only carries the breadcrumb in `content`;
 * hunk and line rows add the review locators (`oldLine`/`newLine`/`marker`),
 * metadata rows add a Chinese `label`.
 * @typedef {object} DiffRow
 * @property {string} type
 * @property {string} [label]
 * @property {number | null} [oldLine]
 * @property {number | null} [newLine]
 * @property {string} [marker]
 * @property {string} content
 */

// 原始 patch 不会被修改；此处只把协议字段转为中文，并补上审阅定位所需的旧/新行号。
// 文件头的 diff --git / --- / +++ / rename 四类行都写回同一个 row，所以头部只占一行面包屑。
/**
 * @param {string} diff
 * @returns {DiffRow[]}
 */
export function presentDiff(diff) {
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
      rows.push({ type: 'hunk', oldLine: null, newLine: null, marker: '…', content: `旧版第 ${oldLine}${oldEnd === oldLine ? '' : `–${oldEnd}`} 行 → 新版第 ${newLine}${newEnd === newLine ? '' : `–${newEnd}`} 行${heading ? ` · ${heading}` : ''}` })
      inHunk = true
      continue
    }
    if (inHunk) {
      if (pushChangeRow(line)) continue
      inHunk = false
    }
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
      beginFile()
      if (match) setPaths({ old: pathLabel(match[1]), new: pathLabel(match[2]) })
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
  return rows
}
