const path = require('node:path')

const { runProbe } = require(path.join(__dirname, '..', 'support', 'probe-runner.cjs'))

describe('V0.5.6 history workspace width', () => {
  it('keeps the complete history workbench within the real 1024px viewport', () => {
    const layouts = JSON.parse(runProbe('history-workspace-layout.cjs', '[LAYOUT] '))
    expect(layouts.map((entry) => entry.viewport)).toEqual([1024, 1280])
    for (const entry of layouts) {
      const label = `${entry.viewport}px`
      expect(entry.documentWidth, label).toBeLessThanOrEqual(entry.viewport + 1)
      expect(entry.shellWidth, label).toBeLessThanOrEqual(entry.shellClientWidth + 1)
      expect(entry.topbarWidth, label).toBeLessThanOrEqual(entry.topbarClientWidth + 1)
      expect(entry.rightEdge, label).toBeLessThanOrEqual(entry.viewport + 1)
      expect(entry.leftWidth, label).toBeGreaterThanOrEqual(190)
      expect(entry.mainWidth, label).toBeGreaterThanOrEqual(360)
      expect(entry.rightWidth, label).toBeGreaterThanOrEqual(240)
    }
  }, 90_000)
})
