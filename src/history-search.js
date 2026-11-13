// V0.5.2 历史审阅的纯前端辅助函数：本地搜索过滤、比较方向、时间格式与状态映射。
// 搜索是纯前端过滤，输入不会触发任何额外 Git 命令。

function normalizeQuery(value) {
  return String(value || '').trim().toLowerCase()
}

function commitMatches(commit, query) {
  if (!commit) return false
  const subject = String(commit.subject || '').toLowerCase()
  const author = String(commit.author || '').toLowerCase()
  const shortHash = String(commit.shortHash || '').toLowerCase()
  const hash = String(commit.hash || '').toLowerCase()
  return (
    subject.includes(query) ||
    author.includes(query) ||
    shortHash.startsWith(query) ||
    hash.startsWith(query)
  )
}

// 返回 { query, matches, filtered }：matches 为过滤结果，filtered 表示当前是否处于过滤态。
export function filterCommits(commits, rawQuery) {
  const query = normalizeQuery(rawQuery)
  const list = Array.isArray(commits) ? commits : []
  if (!query) return { query, matches: list, filtered: false }
  return { query, matches: list.filter((commit) => commitMatches(commit, query)), filtered: true }
}

// 双提交比较：默认基准为较早提交、对比为较晚提交。
export function orderComparePair(first, second) {
  if (!first || !second) return { base: first || null, target: second || null }
  const firstTime = Date.parse(first.authoredAt || '')
  const secondTime = Date.parse(second.authoredAt || '')
  if (Number.isNaN(firstTime) || Number.isNaN(secondTime)) {
    return { base: first, target: second }
  }
  return firstTime <= secondTime
    ? { base: first, target: second }
    : { base: second, target: first }
}

export function relativeTime(value, now = Date.now()) {
  if (!value) return '—'
  const then = Date.parse(value)
  if (Number.isNaN(then)) return '—'
  const seconds = Math.round((now - then) / 1000)
  if (seconds < 45) return '刚刚'
  if (seconds < 90) return '1 分钟前'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  if (minutes < 90) return '1 小时前'
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  if (hours < 36) return '1 天前'
  const days = Math.round(hours / 24)
  if (days < 14) return `${days} 天前`
  const weeks = Math.round(days / 7)
  if (weeks < 5) return `${weeks} 周前`
  const months = Math.round(days / 30.44)
  if (months < 12) return `${months} 个月前`
  return `${Math.max(1, Math.round(days / 365.25))} 年前`
}

const fullFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

export function fullLocalTime(value) {
  if (!value) return '—'
  const then = Date.parse(value)
  if (Number.isNaN(then)) return String(value)
  return fullFormatter.format(then)
}

// git show --name-status 的状态码（含 R100 之类的相似度后缀）→ 界面状态。
const changeKindByCode = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'renamed', T: 'modified' }

export function changeOf(status) {
  const code = String(status || '').slice(0, 1).toUpperCase()
  return changeKindByCode[code] || 'modified'
}

export const changeKindLetter = {
  added: '+',
  modified: 'M',
  deleted: '−',
  renamed: 'R',
}

// git 输出中的英文二进制提示行，例如 "Binary files a/logo.png and b/logo.png differ"。
export const binaryDiffPattern = /^Binary files .+ differ$/

export function isHeadCommit(commit) {
  return (commit?.refs || []).some((ref) => String(ref).includes('HEAD'))
}
