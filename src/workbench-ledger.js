export function countBySource(records) {
  return {
    user: records.filter((record) => record.source === 'user').length,
    background: records.filter((record) => record.source === 'background').length,
  }
}

export function filterLedgerRecords(records, filter, focusedOperationId = null) {
  const byFilter = filter === 'all'
    ? records
    : records.filter((record) => record.source === filter)

  if (filter !== 'user' || !focusedOperationId) return byFilter

  const focused = byFilter.filter((record) => record.operationId === focusedOperationId)
  return focused.length ? focused : byFilter
}

export function groupBackgroundRecords(records) {
  const groups = []
  const byCycle = new Map()

  for (const record of records) {
    const cycleId = record.refreshCycleId
    if (!cycleId) {
      groups.push({ type: 'entry', record })
      continue
    }

    if (!byCycle.has(cycleId)) {
      const group = { type: 'refresh', id: cycleId, records: [] }
      byCycle.set(cycleId, group)
      groups.push(group)
    }
    byCycle.get(cycleId).records.push(record)
  }

  return groups
}
