import { vi } from 'vitest'

// 渲染层用的 `window.gitglass` 假桥。
//
// `electron/preload.cjs` 在真实窗口里用 `contextBridge` 暴露一组方法；这里用普通
// JS 对象复刻同一份**形状**（不是同一份实现），让 `<App />` 的首屏 effect 能跑完：
// 更新状态订阅、仓库状态、分支、提交、远程概览、账本、最近仓库。
//
// 默认值刻意选“空仓库 + 一切成功”：用例只想验证某个区块时就只覆盖那一支，
// 不用把整张 IPC 表抄一遍。返回值必须与 `electron/repository-service.cjs` /
// `electron/main.cjs` 保持一致，否则真渲染出来的是测试自己编的世界。
//
// 与 `tests/support/update-ui-preload.cjs` 的关系：那份是给 Electron 探针注入的
// preload 脚本，这份是给 jsdom 测试用的对象，两者各自独立。

// 未开始检查更新时的状态（`useAppUpdates` 的初始值之外的第一份真实数据）。
export const IDLE_UPDATE_STATE = Object.freeze({
  supported: false,
  currentVersion: '0.0.0-test',
  channel: 'beta',
  automatic: true,
  phase: 'idle',
  latestVersion: null,
  error: '',
  notes: '',
})

// 订阅类方法的返回值为“取消订阅”函数。
const unsubscribe = () => () => {}

/**
 * 生成一份 `window.gitglass` 假桥。
 * @param {Record<string, unknown>} [overrides] 需要覆盖的方法或返回值。
 * @returns {Record<string, import('vitest').Mock>} 假桥（值都是 `vi.fn`，可断言调用）。
 */
export function createGitglassStub(overrides = {}) {
  const idleUpdateState = async () => ({ ...IDLE_UPDATE_STATE })
  const unsupported = async () => ({ plan: null, reason: '假桥未配置此项计划。' })
  const stub = {
    // 更新服务（src/app-updates.jsx）
    getUpdateState: vi.fn(idleUpdateState),
    onUpdateState: vi.fn(unsubscribe),
    getUpdateResume: vi.fn(async () => null),
    consumeUpdateResume: vi.fn(async () => undefined),
    checkForUpdates: vi.fn(idleUpdateState),
    downloadUpdate: vi.fn(idleUpdateState),
    setAutomaticUpdates: vi.fn(idleUpdateState),
    installUpdate: vi.fn(async () => ({ ok: true })),

    // 仓库状态与账本
    getState: vi.fn(async () => ({ ok: false, path: '', branch: '', files: [] })),
    getLedger: vi.fn(async () => []),
    onRepositoryChanged: vi.fn(unsubscribe),
    // watcher 可用性（fs.watch 在网络盘等场景会静默失败；默认乐观可用）
    getWatcherState: vi.fn(async () => ({ active: true })),
    onWatcherChanged: vi.fn(unsubscribe),

    // 工作区
    getBranches: vi.fn(async () => ({ branches: [] })),
    getDiff: vi.fn(async () => ({ ok: true, stdout: '' })),
    getStagedOverview: vi.fn(async () => ({
      ok: true,
      files: [],
      totals: { files: 0, insertions: 0, deletions: 0, binary: 0, unavailable: 0 },
      reason: '',
    })),
    applyDiffHunk: vi.fn(async () => ({ ok: true, execution: { ok: true }, state: { files: [] }, reason: '' })),
    getRecentRepositories: vi.fn(async () => []),
    forgetRecentRepository: vi.fn(async () => []),
    chooseRepository: vi.fn(async () => ({ canceled: true })),
    openRepository: vi.fn(async () => ({ ok: false, message: '假桥未配置 openRepository。' })),
    // 克隆仓库（v0.6.10 PR 1）：默认「什么都没配」，用例只覆盖自己关心的那一支。
    chooseCloneTarget: vi.fn(async () => ({ canceled: true })),
    prepareClone: vi.fn(async () => ({ ok: false, blocked: true, reason: '假桥未配置克隆计划。', plan: null, target: null })),
    executeClone: vi.fn(async () => ({ ok: false, blocked: true, reason: '假桥未配置克隆执行。', plan: null, target: null, execution: null })),

    // 历史审查
    getCommits: vi.fn(async () => ({ commits: [] })),
    queryHistory: vi.fn(async () => ({ commits: [] })),
    getRefs: vi.fn(async () => ({
      ok: true,
      head: { fullName: 'HEAD', shortName: 'HEAD', commit: '', detached: false, unborn: true, status: '当前分支还没有提交。' },
      refs: [],
      reason: '',
    })),
    getCommit: vi.fn(async () => ({ ok: false, commit: null, reason: '假桥未配置 getCommit。' })),
    getCommitDetail: vi.fn(async () => ({ ok: true, changedFiles: [] })),
    getCommitDiff: vi.fn(async () => ({ ok: true, diff: '' })),
    compareCommits: vi.fn(async () => ({ ok: true, diff: '' })),
    getFileHistory: vi.fn(async () => ({ ok: true, entries: [] })),
    getFileHistoryDiff: vi.fn(async () => ({ ok: true, diff: '' })),

    // 远程与恢复
    getRemoteOverview: vi.fn(async () => ({ ok: true, remotes: [], remote: null, upstream: null, ahead: 0, behind: 0 })),
    getReflog: vi.fn(async () => ({ entries: [] })),

    // “计划 → 执行”两步操作
    operate: vi.fn(async () => ({ execution: { ok: true }, state: { files: [] } })),
    prepareBranch: vi.fn(unsupported),
    executeBranch: vi.fn(async () => ({ execution: { ok: true } })),
    prepareRemote: vi.fn(unsupported),
    executeRemote: vi.fn(async () => ({ execution: { ok: true } })),
    prepareDiscard: vi.fn(unsupported),
    executeDiscard: vi.fn(async () => ({ execution: { ok: true } })),
    prepareDeleteMergedBranch: vi.fn(unsupported),
    executeDeleteMergedBranch: vi.fn(async () => ({ execution: { ok: true } })),
    prepareRescueBranch: vi.fn(unsupported),
    executeRescueBranch: vi.fn(async () => ({ execution: { ok: true } })),
  }
  return Object.assign(stub, overrides)
}
