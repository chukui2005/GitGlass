const { execFileSync } = require('node:child_process')
const path = require('node:path')
const electronPath = require('electron')

describe('V0.5.6 history workspace width', () => {
  it('keeps the complete history workbench within the real 1024px viewport', () => {
    const probe = path.join(__dirname, 'support', 'history-workspace-layout.cjs')
    const output = execFileSync(electronPath, [probe], { encoding: 'utf8', timeout: 90_000, windowsHide: true })
    const line = output.split(/\r?\n/).find((entry) => entry.startsWith('[LAYOUT] '))
    expect(line).toBeTruthy()
    const layouts = JSON.parse(line.slice('[LAYOUT] '.length))
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
