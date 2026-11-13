function statusKind(code) {
  if (code === 'A' || code === '?') return 'added'
  if (code === 'D') return 'deleted'
  if (code === 'R' || code === 'C') return 'renamed'
  return 'modified'
}

function parseStatus(raw) {
  const records = raw.split('\0').filter(Boolean)
  const files = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    const xy = record.slice(0, 2)
    const filePath = record.slice(3)
    if (xy === '??') {
      files.push({ path: filePath, oldPath: null, status: 'added', area: 'unstaged' })
      continue
    }
    const renamed = xy.includes('R') || xy.includes('C')
    const oldPath = renamed ? records[++index] || null : null
    const add = (code, area) => {
      if (code === ' ') return
      files.push({ path: filePath, oldPath, status: statusKind(code), area })
    }
    add(xy[0], 'staged')
    add(xy[1], 'unstaged')
  }
  return files
}

function parseBranches(raw) {
  return raw.split('\n').filter(Boolean).map((line) => {
    const [name, head, hash] = line.split('\0')
    return { name, current: head === '*', hash }
  })
}

function parseCommits(raw) {
  return raw.split('\n').filter(Boolean).map((line) => {
    const values = line.split('\x1f')
    if (values.length === 5) {
      const [hash, parents, subject, author, authoredAt] = values
      return { hash, parents: parents ? parents.split(' ') : [], subject, author, authoredAt }
    }
    const refsOf = (refs) => (refs ? refs.split(',').map((ref) => ref.trim()).filter(Boolean) : [])
    if (values.length >= 8) {
      const [hash, shortHash, parents, subject, author, authorEmail, authoredAt, refs] = values
      return { hash, shortHash: shortHash || hash?.slice(0, 7), parents: parents ? parents.split(' ') : [], subject, author, authorEmail, authoredAt, refs: refsOf(refs) }
    }
    const [hash, shortHash, parents, subject, author, authoredAt, refs] = values
    return { hash, shortHash: shortHash || hash?.slice(0, 7), parents: parents ? parents.split(' ') : [], subject, author, authoredAt, refs: refsOf(refs) }
  })
}

// 解析 `git show --format=%B%x1e%an%x1f%ae%x1f%aI --shortstat` 的结构化输出：
// 正文（%B，含完整提交说明）与作者、邮箱、时间用记录分隔符 \x1e 隔开，
// 元数据之间用 \x1f 隔开，统计行跟随在时间之后。
function parseCommitDetail(raw) {
  const text = String(raw || '')
  const separator = text.indexOf('\x1e')
  const messagePart = separator === -1 ? text : text.slice(0, separator)
  const metaPart = separator === -1 ? '' : text.slice(separator + 1)
  const [rawName, rawEmail, rawDateAndStat = ''] = metaPart.split('\x1f')
  const [authoredAt, ...statLines] = rawDateAndStat.split(/\r?\n/)
  const statText = statLines.join('\n')
  const filesMatch = statText.match(/(\d+) files? changed/)
  const plusMatch = statText.match(/(\d+) insertions?\(\+\)/)
  const minusMatch = statText.match(/(\d+) deletions?\(-\)/)
  const message = messagePart.replace(/\r?\n$/, '')
  return {
    message,
    subject: message.split(/\r?\n/)[0] || '',
    authorName: String(rawName || '').trim(),
    authorEmail: String(rawEmail || '').trim(),
    authoredAt: String(authoredAt || '').trim(),
    filesChanged: filesMatch ? Number(filesMatch[1]) : 0,
    insertions: plusMatch ? Number(plusMatch[1]) : 0,
    deletions: minusMatch ? Number(minusMatch[1]) : 0,
  }
}

function parseReflog(raw) {
  return raw.split('\n').filter(Boolean).map((line) => {
    const [hash, shortHash, selector, subject] = line.split('\x1f')
    const match = selector?.match(/@\{(.+)\}$/)
    return { hash, shortHash, selector, occurredAt: match?.[1] || '', action: selector || '', subject: subject || '' }
  }).filter((entry) => /^[0-9a-f]{40}$/i.test(entry.hash))
}

module.exports = { parseStatus, parseBranches, parseCommits, parseCommitDetail, parseReflog }
