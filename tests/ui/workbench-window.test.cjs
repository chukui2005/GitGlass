const path = require('node:path')

// 0.7 工作台改版的验收：真实 Electron 窗口 + 真实临时 Git 仓库 + 真实 dist/ 构建。
// 探针在 1440×900 / 1366×768 / 1024×680 三个目标尺寸下检查交接稿的 P0 通过条件，
// 并把界面截图写到 .screenshots/ui-redesign/（布局与像素事实只能靠真窗口验证）。
const { buildApplication, runProbe } = require(path.join(__dirname, '..', 'support', 'probe-runner.cjs'))

let summary

function readSummary() {
  if (summary) return summary
  buildApplication()
  summary = JSON.parse(runProbe('workbench-acceptance.cjs', '[WORKBENCH] '))
  return summary
}

describe('工作台 0.7 验收（真实窗口 + 真实临时仓库）', () => {
  it('keeps the app bar, the single diff title and the commit form usable at all three sizes', () => {
    const data = readSummary()
    expect(data.sizes.map((entry) => entry.viewport)).toEqual([
      { width: 1440, height: 900 },
      { width: 1366, height: 768 },
      { width: 1024, height: 680 },
    ])
    for (const entry of data.sizes) {
      const label = `${entry.viewport.width}×${entry.viewport.height}`
      // 全局没有横向滚动条，工作区也不产生横向溢出。
      expect(entry.overflowX, label).toBeLessThanOrEqual(1)
      expect(entry.workspaceScrollX, label).toBeLessThanOrEqual(1)
      // 顶栏 48px，动作组止于窗口安全区之内（不压住原生窗口控件）。
      expect(entry.topbar.height, label).toBe(48)
      expect(entry.topbar.actionsRight, label).toBeLessThanOrEqual(entry.topbar.viewportRight - 12)
      // 首屏默认可见 Diff 与提交区标题。
      expect(entry.diffTitle, label).toContain('src/settings/configuration.ts')
      expect(entry.diffTitle, label).toContain('未暂存差异')
      expect(Math.round(entry.diffTitleHeight), label).toBe(56)
      expect(entry.diffTitleOverflowX, label).toBeLessThanOrEqual(0)
      expect(entry.diffLines, label).toBeGreaterThan(0)
      // 工作区单文件视图不再重复 patch 的文件头。
      expect(entry.diffFileHeaders, label).toBe(0)
      // 等 Diff 时不只看"有没有内容"，而是确认它就是当前选中文件的 Diff。
      expect(entry.diffShowsSelectedFile, label).toBe(true)
      expect(entry.diffSelectedRows, label).toEqual(['src/settings/configuration.ts'])
      expect(entry.commit.heading, label).toBe('创建提交')
      expect(entry.commit.visible, label).toBe(true)
      expect(entry.commit.buttonVisible, label).toBe(true)
      expect(entry.commit.buttonLabel, label).toBe('提交 1 个文件')
      // 右栏两段：当前文件 + 创建提交，且不横向溢出。
      expect(entry.rightPanel.headings, label).toEqual(['当前文件', '创建提交'])
      expect(entry.rightPanel.overflowX, label).toBeLessThanOrEqual(1)
      expect(entry.currentFile.heading, label).toBe('当前文件')
      expect(entry.currentFile.stageLabel, label).toBe('暂存文件')
      expect(entry.currentFile.preview, label).toContain('git add -- src/settings/configuration.ts')
      expect(entry.currentFile.discardVisible, label).toBe(true)
      // 左栏：主标签是 basename、状态符号在行尾、行高 28px。
      expect(entry.sidebar.rowHeight, label).toBe(28)
      expect(entry.sidebar.overflowX, label).toBeLessThanOrEqual(0)
      expect(entry.sidebar.rows.map((row) => row.name)).toEqual([
        'configuration.test.ts',
        'configuration.ts',
        'defaults.ts',
        'quickstart.md',
      ])
      expect(entry.sidebar.rows.find((row) => row.selected).name, label).toBe('configuration.ts')
      expect(entry.sidebar.rows.map((row) => row.status), label).toEqual(['M', 'M', '+', 'M'])
      // 账本折叠高 36px，摘要说明来源与结果。
      expect(entry.ledger.height, label).toBe(36)
      expect(entry.ledger.expanded, label).toBe('false')
      expect(entry.ledger.glance, label).toContain('成功')
    }
  }, 180_000)

  it('reaches the commit button with the keyboard and previews the commit command', () => {
    const data = readSummary()
    for (const entry of data.sizes) {
      const label = `${entry.viewport.width}×${entry.viewport.height}`
      // 禁用态按钮按设计不可聚焦：先填一句说明，再从说明框按 Tab 过去。
      expect(entry.commitReachable, label).toBe(true)
      expect(entry.commitPreview, label).toContain('提交命令预览')
      expect(entry.commitPreview, label).toContain('git commit -m')
    }
  })

  it('shows the discard plan with「尚未运行」and returns without touching the repository', () => {
    const plan = readSummary().plan
    expect(plan.heading).toContain('确认丢弃 configuration.ts 的改动')
    expect(plan.label).toBe('计划执行（尚未运行）')
    expect(plan.command).toBe('git restore --worktree -- src/settings/configuration.ts')
    expect(plan.risk).toContain('不可直接撤销')
    expect(plan.back).toBe(true)
    expect(plan.backFocusable).toBe(true)
    // 打开、查看、返回都不改动仓库：文件内容、暂存区与工作区状态逐项一致。
    expect(plan.statusUnchanged).toBe(true)
  })

  it('stages the reviewed file and records exactly the command the preview showed', () => {
    const { stageCheck } = readSummary()
    expect(stageCheck.previewCommand).toBe('git add -- src/settings/configuration.ts')
    expect(stageCheck.recordedCommand).toBe(stageCheck.previewCommand)
    expect(stageCheck.matches).toBe(true)
    // 真实暂存：文件进入索引，仓库状态与预览一致。
    expect(stageCheck.stagedInIndex).toBe(true)
  })

  it('expands the ledger into the two-line record view for the README screenshot', () => {
    const { ledgerView } = readSummary()
    expect(ledgerView.expanded).toBe('true')
    expect(ledgerView.rows).toBeGreaterThan(0)
    expect(ledgerView.filters.length).toBe(3)
    expect(ledgerView.firstCommand).toContain('git ')
    expect(ledgerView.screenshotBytes).toBeGreaterThan(10_000)
  })

  it('writes one screenshot per target size plus the plan state and the expanded ledger', () => {
    const data = readSummary()
    expect(data.sizes.every((entry) => entry.screenshotBytes > 10_000)).toBe(true)
    expect(data.plan.screenshotBytes).toBeGreaterThan(10_000)
    expect(data.screenshots).toContain(path.join('.screenshots', 'ui-redesign'))
  })
})
