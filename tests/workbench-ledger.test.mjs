import { describe, expect, it } from 'vitest'
import { countBySource, filterLedgerRecords, formatLedgerOutput, glanceSummary, groupBackgroundRecords, intentLabel, recordStatusLabel, recordTypeLabel } from '../src/workbench-ledger.js'

// 用 String.fromCharCode 构造控制字符，避免测试源码里出现不可见字符。
const RS = String.fromCharCode(30) // 0x1e 记录分隔符
const US = String.fromCharCode(31) // 0x1f 单元分隔符
const NUL = String.fromCharCode(0)

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

describe('V0.5.2 ledger output formatting', () => {
  it('turns structure separators into readable text instead of boxes', () => {
    // 提交详情的真实 stdout：说明 + 0x1e + 作者 0x1f 邮箱 0x1f 时间。
    const raw = `chore: remove temp module\n\n${RS}Demo Author${US}demo@example.test${US}2026-11-13T19:19:07+08:00`
    const text = formatLedgerOutput(raw)
    expect(text.toLowerCase()).not.toContain(String.fromCharCode(30))
    expect(text).not.toContain(US)
    expect(text).not.toContain('\ufffd')
    expect(text).toContain('chore: remove temp module')
    expect(text).toContain('Demo Author · demo@example.test · 2026-11-13T19:19:07+08:00')
  })

  it('keeps porcelain -z entries on separate lines instead of NUL separators', () => {
    const raw = ` M src/a.js${NUL}A  src/new.js${NUL}`
    const text = formatLedgerOutput(raw)
    expect(text).not.toContain(NUL)
    expect(text.split('\n')).toEqual([' M src/a.js', 'A  src/new.js'])
  })

  it('never leaks other control characters or replacement boxes to the page', () => {
    const raw = `a${String.fromCharCode(7)}b${String.fromCharCode(27)}c\ufffdd\r\ne`
    const text = formatLedgerOutput(raw)
    expect(text).toBe('abcd\ne')
    expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/.test(text)).toBe(false)
  })

  it('collapses blank-line runs and tolerates empty input', () => {
    expect(formatLedgerOutput('a\n\n\n\nb')).toBe('a\n\nb')
    expect(formatLedgerOutput('')).toBe('')
    expect(formatLedgerOutput(null)).toBe('')
    expect(formatLedgerOutput(undefined)).toBe('')
    expect(formatLedgerOutput(42)).toBe('')
  })

  it('does not mutate the raw record used for audit', () => {
    const raw = `subject${RS}author`
    expect(formatLedgerOutput(raw)).toBe('subject\nauthor')
    // 原始字符串保持原样，账本记录仍是真实 stdout。
    expect(raw).toBe(`subject${RS}author`)
  })
})
