// 自动刷新的静默窗：一次刷新结束后 1 秒内的自动刷新请求默认丢弃。
// `git status` 会重写 .git/index 缓存，主进程 watcher 的静默窗是第一层，
// 这一层是渲染层的兜底，避免"刷新 → 事件 → 再刷新"的自触发循环。
export const AUTO_REFRESH_QUIET_MS = 1000;

// 只有我们自己 `git status` 这类读取会写 index；HEAD 与 refs 的变化一定来自
// 外部（终端里的 commit / 切换分支 / 合并）或用户刚执行的操作（主进程已用
// notifyIgnored 静默窗屏蔽）。所以这两类事件可以穿过渲染层静默窗，避免出现
// "终端先 add 再 commit，第二次改动要等到窗口重新聚焦才显示"。
export const QUIET_WINDOW_BYPASS_REASONS = new Set(["head", "refs"]);

// 纯函数：本次 repo:changed / window focus 事件是否应该触发一次静默刷新。
// - loading：用户可见的 Git 操作或手动刷新正在进行，不叠加新的刷新；
// - refreshing：一次静默刷新尚未结束（静默刷新不设置 loading）；
// - hasRepository：没有打开仓库时不刷新，避免产生无意义的失败记录；
// - lastRefreshAt：上一次刷新结束的时间戳，用于 1 秒静默窗；
// - reason：watcher 报告的变化类型（index / head / refs），空串表示窗口聚焦。
export function shouldRefreshOnChange({
  loading = false,
  refreshing = false,
  hasRepository = true,
  lastRefreshAt = 0,
  now = Date.now(),
  quietMs = AUTO_REFRESH_QUIET_MS,
  reason = "",
} = {}) {
  if (!hasRepository) return false;
  if (loading || refreshing) return false;
  if (QUIET_WINDOW_BYPASS_REASONS.has(reason)) return true;
  return now - lastRefreshAt >= quietMs;
}
