import { describe, expect, it } from 'vitest'
import { riskLabel } from '../../src/plan-risk.js'

describe('plan risk labels', () => {
  it('labels the three destructive or recovering plans', () => {
    expect(riskLabel('high')).toBe('高风险：不可直接撤销')
    expect(riskLabel('caution')).toBe('谨慎：删除已合并本地分支')
    expect(riskLabel('safe')).toBe('安全：创建救援分支')
  })

  it('renders nothing for ordinary plans such as branch switch or fetch', () => {
    // Regression: the old ternary fallback painted "安全：创建救援分支" on every
    // plan without an explicit tone, including fetch.
    expect(riskLabel('normal')).toBeNull()
    expect(riskLabel('')).toBeNull()
    expect(riskLabel(undefined)).toBeNull()
    expect(riskLabel(null)).toBeNull()
    expect(riskLabel(42)).toBeNull()
  })
})
