const path = require('node:path')

// 真 Electron 窗口 + 本地 bare 远程：空工作台克隆 → 检出远程分支 → 新建分支
// 并提交 → 本地标签 → 首次推送 → 历史图按标签定位。探针复用生产
// RepositoryService / GitCommandService / repository-cloner。
const { buildApplication, runProbe } = require(path.join(__dirname, '..', 'support', 'probe-runner.cjs'))

let summary
function readSummary() {
  if (summary) return summary
  buildApplication()
  summary = JSON.parse(runProbe('v0610-integration-window.cjs', '[V0610-INTEGRATION] '))
  return summary
}

describe('v0.6.10 remote + history graph integration (real window)', () => {
  it('clones, checks out, commits, first-pushes and locates the commit in history', () => {
    const data = readSummary()
    expect(data.clonePlan).toContain('clone --')
    expect(data.clonePlan).toContain('GitGlass-e2e')
    expect(data.repository).toContain('GitGlass-e2e')
    expect(data.remoteBranches).toEqual(expect.arrayContaining([
      'refs/heads/main',
      'refs/heads/feature',
      'refs/heads/integration/demo',
    ]))
    // Local commit, remote branch, local remote-tracking ref, graph ref and tag
    // all name the same commit object.
    expect(data.remoteCommit).toBe(data.localCommit)
    expect(data.remoteTracking).toBe(data.localCommit)
    expect(data.graphRemoteCommit).toBe(data.localCommit)
    expect(data.tagJump).toEqual({ tag: 'refs/tags/demo-tag', commit: data.localCommit })
    expect(data.upstream).toBe('origin/integration/demo')
    expect(data.counts).toEqual([0, 0])
  }, 180_000)

  it('first push sends only the branch and leaves remote tags empty', () => {
    const data = readSummary()
    expect(data.firstPushCommand).toContain('--no-follow-tags')
    expect(data.firstPushCommand).toContain('refs/heads/integration/demo:refs/heads/integration/demo')
    expect(data.firstPushArgv).toEqual([
      'git',
      'push',
      '--set-upstream',
      '--no-follow-tags',
      'origin',
      'refs/heads/integration/demo:refs/heads/integration/demo',
    ])
    expect(data.firstPushArgv.some((value) => value.includes('refs/tags'))).toBe(false)
    expect(data.remoteTagsBeforePush).toBe('')
    expect(data.remoteTagsAfterPush).toBe('')
  })

  it('keeps the history graph and refs usable at 1440x900 and 1024x680', () => {
    const data = readSummary()
    expect(data.sizes.map((entry) => entry.viewport)).toEqual([
      { width: 1440, height: 900 },
      { width: 1024, height: 680 },
    ])
    for (const entry of data.sizes) {
      const label = `${entry.viewport.width}×${entry.viewport.height}`
      expect(entry.documentOverflow, label).toBeLessThanOrEqual(1)
      expect(entry.workspaceOverflow, label).toBeLessThanOrEqual(1)
      expect(entry.graph, label).toBe(true)
      expect(entry.refs, label).toBeGreaterThan(5)
      expect(entry.screenshotBytes, label).toBeGreaterThan(10_000)
    }
    expect(data.screenshots).toContain(path.join('.screenshots', 'v0610-integration'))
  })
})
