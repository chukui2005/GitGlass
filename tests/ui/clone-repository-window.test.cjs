const path = require('node:path')

// 克隆的真实窗口验收：真 Electron 窗口 + 真实 dist/ + 真实 Git（tests/support/clone-window.cjs）。
// 单元与集成测试守的是模块边界；这里守的是「从空工作台点界面入口真的能克隆并打开」。
const { buildApplication, runProbe } = require(path.join(__dirname, '..', 'support', 'probe-runner.cjs'))

function runCloneProbe() {
  buildApplication()
  const summary = JSON.parse(runProbe('clone-window.cjs', '[CLONE-WINDOW] '))
  return summary
}

describe('clone repository in a real window', () => {
  it('clones a real remote from the workbench dialog, opens it and refuses a credential-bearing address', () => {
    const summary = runCloneProbe()
    expect(summary.ok, JSON.stringify(summary)).toBe(true)

    // 空工作台的两个入口都指向同一个克隆对话框。
    expect(summary.emptyGuide).toBe(true)
    expect(summary.emptyStatePath).toBe('')

    // 预览里是最终目录与带协议约束的真实命令，且此时还没有执行。
    expect(summary.targetLabel).toContain(summary.target)
    expect(summary.plannedCommand).toContain('-c protocol.allow=never')
    expect(summary.plannedCommand).toContain('clone --')

    // 执行结果以磁盘上的真实 Git 为准。
    expect(summary.notice).toContain('已克隆并打开仓库')
    expect(summary.repository).toBe('probe-clone')
    expect(summary.statePath).toBe(summary.target)
    expect(summary.head).toBe(summary.expectedHead)
    expect(summary.originUrl).toBe(summary.origin)
    expect(summary.branch).toBe('main')

    // 账本：一条用户操作记录，argv 带协议约束，工作目录是用户选择的目标位置。
    expect(summary.ledger).toHaveLength(1)
    expect(summary.ledger[0]).toMatchObject({ intent: 'Clone repository', ok: true, source: 'user', cwd: path.dirname(summary.target) })
    expect(summary.ledger[0].argv).toEqual(
      expect.arrayContaining(['-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always', 'clone', '--']),
    )

    // 内嵌凭据的地址：对话框里给出原因、不出现确认入口，也没有第二条克隆记录。
    expect(summary.rejectedReason).toContain('内嵌的用户名或令牌')
    expect(summary.rejectedReason).not.toContain('tok3n')
    expect(summary.dialogStillOpen).toBe(true)
    expect(summary.canConfirm).toBe(false)
    expect(summary.cloneRecordsAfterRejection).toBe(1)
    expect(summary.leakyCreated).toBe(false)
  }, 180_000)
})
