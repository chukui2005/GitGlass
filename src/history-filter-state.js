export const emptyHistoryFilters = { keyword: '', author: '', branch: '', filePath: '' }
export function sameHistoryFilters(left, right) { return ['keyword', 'author', 'branch', 'filePath'].every((key) => (left?.[key] || '') === (right?.[key] || '')) }
export function resolveHistoryEscape(draft, applied) {
  if (!sameHistoryFilters(draft, applied || emptyHistoryFilters)) return { kind: 'discard-draft', filters: applied || emptyHistoryFilters }
  if (applied) return { kind: 'reset-applied', filters: emptyHistoryFilters }
  return { kind: 'exit-history', filters: emptyHistoryFilters }
}
