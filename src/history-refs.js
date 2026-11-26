// Presentation model for the refs sidebar. Git owns the identifiers; this file
// only groups them and turns them into labels the UI can show without losing
// the distinction between a branch and a tag that happen to share a short name.

export const REF_GROUPS = [
  { kind: 'local', label: '本地分支' },
  { kind: 'remote', label: '远程跟踪分支' },
  { kind: 'alias', label: '远程默认分支' },
  { kind: 'tag', label: '标签' },
]

const KIND_LABELS = {
  local: '分支',
  remote: '远程分支',
  alias: '远程别名',
  tag: '标签',
  head: 'HEAD',
}

export function refKindLabel(ref) {
  return KIND_LABELS[ref?.kind] || '引用'
}

export function refCommitShort(ref) {
  return typeof ref?.commit === 'string' && ref.commit ? ref.commit.slice(0, 7) : ''
}

/**
 * Stable grouping for keyboard order and section counts. Unresolved tags remain
 * present so the user sees why they cannot be opened.
 *
 * @param {Array<Record<string, unknown>>} refs
 * @returns {Array<{ kind: string, label: string, refs: Array<Record<string, unknown>> }>}
 */
export function groupReferences(refs) {
  const list = Array.isArray(refs) ? refs : []
  return REF_GROUPS.map((group) => ({
    ...group,
    refs: list.filter((ref) => ref?.kind === group.kind),
  })).filter((group) => group.refs.length)
}

/**
 * HEAD is rendered before the groups. It is clickable only when it resolves to
 * a commit; detached HEAD and an unborn branch get distinct read-only labels.
 *
 * @param {Record<string, unknown> | null} head
 * @returns {Record<string, unknown> | null}
 */
export function headReference(head) {
  if (!head) return null
  if (head.detached) {
    return {
      fullName: 'HEAD',
      shortName: 'HEAD（分离）',
      kind: 'head',
      commit: head.commit || '',
      status: 'HEAD 处于分离状态。',
      detached: true,
    }
  }
  if (head.unborn) {
    return {
      fullName: head.fullName || 'HEAD',
      shortName: head.shortName || 'HEAD',
      kind: 'head',
      commit: '',
      status: '当前分支还没有提交。',
      unborn: true,
    }
  }
  return {
    fullName: head.fullName || 'HEAD',
    shortName: head.shortName || 'HEAD',
    kind: 'head',
    commit: head.commit || '',
    status: '',
  }
}

export function refTargetDescription(ref) {
  if (!ref) return ''
  if (ref.kind === 'alias' && ref.targetShortName) return `${ref.shortName} → ${ref.targetShortName}`
  return ref.shortName || ref.fullName || ''
}
