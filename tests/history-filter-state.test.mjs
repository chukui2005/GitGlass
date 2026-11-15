import { describe, expect, it } from 'vitest'
import { emptyHistoryFilters, resolveHistoryEscape } from '../src/history-filter-state.js'

describe('V0.5.6 历史筛选 Escape 状态机', () => {
  const applied = { keyword: 'fix', author: 'Ada', branch: 'main', filePath: 'src/a.js' }
  it('草稿变更时仅放弃四种草稿条件，不查询 Git', () => {
    expect(resolveHistoryEscape({ ...applied, author: 'Ben' }, applied)).toEqual({ kind: 'discard-draft', filters: applied })
    expect(resolveHistoryEscape({ ...applied, filePath: '' }, applied)).toEqual({ kind: 'discard-draft', filters: applied })
  })
  it('已应用条件时重置为默认历史，否则才退出历史页', () => {
    expect(resolveHistoryEscape(applied, applied).kind).toBe('reset-applied')
    expect(resolveHistoryEscape(emptyHistoryFilters, null).kind).toBe('exit-history')
  })
})
