const hunkPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: ?(.*))?$/

function pathLabel(path) {
  return String(path || '').replace(/^[ab]\//, '') || '（无路径）'
}

function metadataRow(line) {
  if (line.startsWith('diff --git ')) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
    return { type: 'file', label: '文件', content: match ? pathLabel(match[2]) : '文件差异' }
  }
  if (line.startsWith('index ')) return null
  if (line.startsWith('--- ')) return { type: 'file-path old', label: '原文件', content: pathLabel(line.slice(4)) }
  if (line.startsWith('+++ ')) return { type: 'file-path new', label: '新文件', content: pathLabel(line.slice(4)) }
  if (line.startsWith('new file mode ')) return { type: 'metadata', label: '新增文件', content: `权限 ${line.slice(14)}` }
  if (line.startsWith('deleted file mode ')) return { type: 'metadata', label: '删除文件', content: `权限 ${line.slice(18)}` }
  if (line.startsWith('old mode ')) return { type: 'metadata', label: '原文件权限', content: line.slice(9) }
  if (line.startsWith('new mode ')) return { type: 'metadata', label: '新文件权限', content: line.slice(9) }
  if (line.startsWith('similarity index ')) return { type: 'metadata', label: '内容相似度', content: line.slice(17) }
  if (line.startsWith('rename from ')) return { type: 'metadata', label: '重命名前', content: line.slice(12) }
  if (line.startsWith('rename to ')) return { type: 'metadata', label: '重命名后', content: line.slice(10) }
  if (/^Binary files .+ differ$/.test(line)) return { type: 'binary', label: '二进制文件差异', content: 'Git 无法生成文本内容' }
  if (line === '\\ No newline at end of file') return { type: 'metadata', label: '文件提示', content: '文件末尾没有换行符' }
  return { type: 'metadata', label: 'Git 信息', content: line }
}

// 原始 patch 不会被修改；此处只把协议字段转为中文，并补上审阅定位所需的旧/新行号。
export function presentDiff(diff) {
  const lines = String(diff || '').split('\n')
  if (lines.at(-1) === '') lines.pop()
  let oldLine = null
  let newLine = null
  return lines.flatMap((line) => {
    const hunk = hunkPattern.exec(line)
    if (hunk) {
      const [, oldStart, oldCount = '1', newStart, newCount = '1', heading = ''] = hunk
      oldLine = Number(oldStart)
      newLine = Number(newStart)
      const oldEnd = oldLine + Number(oldCount) - 1
      const newEnd = newLine + Number(newCount) - 1
      return [{ type: 'hunk', oldLine: null, newLine: null, marker: '…', content: `旧版第 ${oldLine}${oldEnd === oldLine ? '' : `–${oldEnd}`} 行 → 新版第 ${newLine}${newEnd === newLine ? '' : `–${newEnd}`} 行${heading ? ` · ${heading}` : ''}` }]
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      const row = { type: 'plus', oldLine: null, newLine, marker: '+', content: line.slice(1) }
      newLine = newLine === null ? null : newLine + 1
      return [row]
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      const row = { type: 'minus', oldLine, newLine: null, marker: '−', content: line.slice(1) }
      oldLine = oldLine === null ? null : oldLine + 1
      return [row]
    }
    if (line.startsWith(' ') && oldLine !== null && newLine !== null) {
      const row = { type: 'context', oldLine, newLine, marker: ' ', content: line.slice(1) }
      oldLine += 1
      newLine += 1
      return [row]
    }
    const row = metadataRow(line)
    return row ? [row] : []
  })
}
