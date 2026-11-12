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
    const [hash, parents, subject, author, authoredAt] = line.split('\x1f')
    return { hash, parents: parents ? parents.split(' ') : [], subject, author, authoredAt }
  })
}

function parseReflog(raw) {
  return raw.split('\n').filter(Boolean).map((line) => {
    const [hash, shortHash, selector, subject] = line.split('\x1f')
    const match = selector?.match(/@\{(.+)\}$/)
    return { hash, shortHash, selector, occurredAt: match?.[1] || '', action: selector || '', subject: subject || '' }
  }).filter((entry) => /^[0-9a-f]{40}$/i.test(entry.hash))
}

module.exports = { parseStatus, parseBranches, parseCommits, parseReflog }
