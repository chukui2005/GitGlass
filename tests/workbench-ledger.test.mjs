import { describe, expect, it } from 'vitest'
import { countBySource, filterLedgerRecords, glanceSummary, groupBackgroundRecords, intentLabel, recordStatusLabel, recordTypeLabel } from '../src/workbench-ledger.js'

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

  it('presents Chinese operation labels, classification and status for the ledger', () => {
    const locate = { intent: 'Resolve repository root', source: 'background', ok: true, stderr: '' }
    expect(intentLabel(locate)).toBe('定位仓库根目录')
    expect(recordTypeLabel(locate.source)).toBe('系统读取')
    expect(recordStatusLabel(locate)).toBe('成功')
    expect(glanceSummary(locate)).toBe('最近：定位仓库根目录 · 成功')
    expect(intentLabel({ intent: 'Stage file', source: 'user' })).toBe('暂存文件')
    expect(recordTypeLabel('user')).toBe('用户执行')
    expect(recordStatusLabel({ ok: false, stderr: 'fatal' })).toBe('失败')
    expect(recordStatusLabel({ ok: true, stderr: 'warning' })).toBe('警告')
    expect(intentLabel({ source: 'background' })).toBe('系统读取')
    expect(glanceSummary(null)).toBe('尚无命令记录')
  })
})
