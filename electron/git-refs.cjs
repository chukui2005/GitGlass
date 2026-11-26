// Git refs are read through one fixed `for-each-ref` format so branches, remote
// tracking refs and tags arrive with their full ref name and the commit they
// actually resolve to. `%(objectname)` is the tag object for an annotated tag;
// `%(*objectname)` is the peeled object, which is the commit the UI must use.
const REF_FORMAT = '%(refname)%09%(objectname)%09%(objecttype)%09%(*objectname)%09%(*objecttype)%09%(symref)%09%(HEAD)'
const REF_ARGV = ['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags']
const SHA1 = /^[0-9a-f]{40}$/i

function stripPrefix(fullName, prefix) {
  return fullName.startsWith(prefix) ? fullName.slice(prefix.length) : fullName
}

function shortRefName(fullName) {
  if (fullName.startsWith('refs/heads/')) return stripPrefix(fullName, 'refs/heads/')
  if (fullName.startsWith('refs/remotes/')) return stripPrefix(fullName, 'refs/remotes/')
  if (fullName.startsWith('refs/tags/')) return stripPrefix(fullName, 'refs/tags/')
  return fullName
}

function refKind(fullName) {
  if (fullName.startsWith('refs/heads/')) return 'local'
  if (fullName.startsWith('refs/remotes/')) return 'remote'
  if (fullName.startsWith('refs/tags/')) return 'tag'
  return ''
}

function parseCommitId(value) {
  return typeof value === 'string' && SHA1.test(value) ? value : ''
}

// Tags can point at a commit directly (lightweight), at another tag
// (annotated) or at a non-commit object. Only the first two are navigable.
function tagTarget(entry) {
  if (entry.objectType === 'commit') return { commit: parseCommitId(entry.objectName), annotated: false }
  if (entry.peeledType === 'commit') return { commit: parseCommitId(entry.peeledName), annotated: true }
  const objectType = entry.objectType || '未知'
  return {
    commit: '',
    annotated: entry.objectType === 'tag',
    status: `标签目标不是提交（${objectType} 对象），无法定位到提交。`,
  }
}

function nonCommitStatus(kind, objectType) {
  const objectLabel = objectType || '未知'
  return kind === 'local'
    ? `本地分支指向${objectLabel}对象，不是提交，无法定位。`
    : `远程跟踪分支指向${objectLabel}对象，不是提交，无法定位。`
}

/**
 * Parses tab-delimited `for-each-ref` output. Ref names cannot contain tabs or
 * newlines, so the fixed field delimiter cannot be confused with user data.
 *
 * @param {string} raw
 * @returns {Array<Record<string, unknown>>}
 */
function parseRefs(raw) {
  const refs = String(raw || '').split(/\r?\n/).filter(Boolean).map((line) => {
    const [fullName, objectName = '', objectType = '', peeledName = '', peeledType = '', symref = '', head = ''] = line.split('\t')
    if (!fullName) return null
    const kind = refKind(fullName)
    if (!kind) return null
    const entry = {
      fullName,
      shortName: shortRefName(fullName),
      kind,
      objectName,
      objectType,
      commit: '',
      head: head.trim() === '*',
      annotated: false,
      status: '',
    }
    if (kind === 'tag') {
      Object.assign(entry, tagTarget({ objectName, objectType, peeledName, peeledType }))
    } else if (kind === 'remote' && symref) {
      entry.kind = 'alias'
      entry.targetRef = symref
      entry.targetShortName = shortRefName(symref)
      // A symbolic remote ref (origin/HEAD) points at another remote ref. The
      // target is resolved after every row is parsed, because ref order is
      // lexicographic and the target may arrive later.
      entry.commit = objectType === 'commit' ? parseCommitId(objectName) : ''
    } else {
      entry.commit = objectType === 'commit' ? parseCommitId(objectName) : ''
      if (!entry.commit) entry.status = nonCommitStatus(kind, objectType)
    }
    return entry
  }).filter(Boolean)

  const byFullName = new Map(refs.map((entry) => [entry.fullName, entry]))
  for (const entry of refs) {
    if (entry.kind !== 'alias') continue
    const target = byFullName.get(entry.targetRef)
    if (!target) {
      entry.status = '远程默认分支别名指向的远程跟踪分支不存在。'
      continue
    }
    entry.targetShortName = target.shortName
    entry.commit = target.commit || entry.commit
    if (!entry.commit) entry.status = target.status || '远程默认分支别名无法解析到提交。'
  }
  return refs
}

/**
 * HEAD needs three facts that `for-each-ref` alone cannot provide: the symbolic
 * ref (or detached state), the commit, and whether a branch is still unborn.
 *
 * @param {{ symbolicRef?: string, headCommit?: string, refs?: Array<Record<string, unknown>> }} input
 */
function buildHead({ symbolicRef = '', headCommit = '', refs = [] } = {}) {
  const ref = typeof symbolicRef === 'string' ? symbolicRef.trim() : ''
  const commit = parseCommitId(String(headCommit || '').trim())
  const local = ref ? refs.find((entry) => entry.fullName === ref) : null
  const resolvedCommit = commit || local?.commit || ''
  const detached = !ref && Boolean(resolvedCommit)
  const unborn = Boolean(ref) && !resolvedCommit
  return {
    fullName: ref || 'HEAD',
    shortName: ref ? shortRefName(ref) : 'HEAD',
    commit: resolvedCommit,
    symbolic: Boolean(ref),
    detached,
    unborn,
    status: unborn ? '当前分支还没有提交。' : '',
  }
}

module.exports = { REF_ARGV, REF_FORMAT, parseRefs, buildHead, shortRefName }
