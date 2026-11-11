import { describe, expect, it } from 'vitest'
import { countBySource, filterLedgerRecords, groupBackgroundRecords } from '../src/workbench-ledger.js'

const records = [
  { id: 'add', source: 'user', operationId: 'stage-readme', displayCommand: 'git add -- README.md' },
  { id: 'status', source: 'background', refreshCycleId: 'refresh-1', displayCommand: 'git status --porcelain=v1 -z' },
  { id: 'branches', source: 'background', refreshCycleId: 'refresh-1', displayCommand: 'git branch --format=...' },
  { id: 'diff', source: 'background', refreshCycleId: 'refresh-2', displayCommand: 'git diff -- README.md' },
]

describe('Workbench ledger presentation', () => {
  it('defaults the user view to the current user operation instead of background reads', () => {
    expect(filterLedgerRecords(records, 'user', 'stage-readme')).toEqual([records[0]])
    expect(countBySource(records)).toEqual({ user: 1, background: 3 })
  })

  it('keeps background reads available as collapsed refresh groups', () => {
    const background = filterLedgerRecords(records, 'background')
    expect(groupBackgroundRecords(background)).toEqual([
      { type: 'refresh', id: 'refresh-1', records: [records[1], records[2]] },
      { type: 'refresh', id: 'refresh-2', records: [records[3]] },
    ])
  })

  it('keeps the complete audit trail available in the all view', () => {
    expect(filterLedgerRecords(records, 'all')).toHaveLength(4)
  })
})
