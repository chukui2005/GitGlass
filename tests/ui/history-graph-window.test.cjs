const path = require('node:path')

// 真 Electron 窗口 + 真临时 Git 仓库 + 真 dist/ 构建：引用跳转、列表外提交、
// 合并图父边、键盘焦点与 1024 最小窗口都在这里验收；截图写到
// .screenshots/history-graph/（已忽略）。
const { buildApplication, runProbe } = require(path.join(__dirname, '..', 'support', 'probe-runner.cjs'))

let summary
function readSummary() {
  if (summary) return summary
  buildApplication()
  summary = JSON.parse(runProbe('history-graph-window.cjs', '[HISTORY-GRAPH] '))
  return summary
}

describe('v0.6.10 PR3 history refs and graph (real window)', () => {
  it('navigates from refs, reads an outside commit, and draws every merge parent edge', () => {
    const data = readSummary()
    expect(data.refs.branch).toMatchObject({ fullName: 'refs/heads/release' })
    expect(data.refs.tag).toMatchObject({ fullName: 'refs/tags/release', annotated: false })
    expect(data.refs.branch.commit).toBe(data.refs.tag.commit)
    // Same short name survives because the full ref and kind differ.
    expect(data.refs.sameName.branch).toBe(data.refs.tag.commit)
    expect(data.refs.sameName.tag).toBe(data.refs.tag.commit)
    expect(data.refs.sameName.alias).toContain('origin/HEAD → origin/main')
    expect(data.refs.alias).toMatchObject({
      fullName: 'refs/remotes/origin/HEAD',
      targetRef: 'refs/remotes/origin/main',
      commit: data.commits.merge,
    })
    expect(data.refs.outside.commit).toBe(data.commits.outside)

    // In-page ref gets the existing detail path; outside ref is read by full id.
    expect(data.outsideView.feedback).toContain('已按完整 ID')
    expect(data.outsideView.hashes).toEqual([data.commits.outside])
    expect(data.outsideView.note).toContain('不在本页')
    expect(data.graph.edges).toHaveLength(2)
    expect(data.graph.edges).toEqual(expect.arrayContaining([data.commits.feature]))
    expect(data.graph.nodes).toBe(1)
    expect(data.graph.notice).toBe('')
    expect(data.tagJumpScreenshotBytes).toBeGreaterThan(10_000)
    expect(data.repositoryUnchanged).toBe(true)
  }, 180_000)

  it('keeps refs and graph usable at 1440x900 and 1024x680, with keyboard focus', () => {
    const data = readSummary()
    expect(data.keyboard.refNext).toMatch(/^refs\//)
    expect(data.keyboard.refNext).not.toBe('refs/heads/main')
    expect(data.keyboard.commitNext).toContain('查看提交')
    expect(data.sizes.map((entry) => entry.viewport)).toEqual([
      { width: 1440, height: 900 },
      { width: 1024, height: 680 },
    ])
    for (const entry of data.sizes) {
      const label = `${entry.viewport.width}×${entry.viewport.height}`
      expect(entry.documentOverflow, label).toBeLessThanOrEqual(1)
      expect(entry.workspaceOverflow, label).toBeLessThanOrEqual(1)
      expect(entry.referenceOverflow, label).toBeLessThanOrEqual(1)
      expect(entry.main.width, label).toBeGreaterThanOrEqual(330)
      expect(entry.graph.height, label).toBe(38)
      expect(entry.commitRowHeight, label).toBeGreaterThanOrEqual(36)
      expect(entry.commitRowHeight, label).toBeLessThanOrEqual(40)
      expect(entry.refs, label).toBeGreaterThan(6)
      expect(entry.screenshotBytes, label).toBeGreaterThan(10_000)
    }
    expect(data.screenshots).toContain(path.join('.screenshots', 'history-graph'))
  })
})
