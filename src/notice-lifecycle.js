// 顶部通知横幅的生命周期规则（纯逻辑，不依赖 React）。
//
// 两类横幅共用同一条渲染出口，但语义完全不同：
// - 成功/失败类通知是「一次操作的结果」，属于瞬时消息，几秒后应该自己让出空间；
// - 来自 state.operation 的「仓库正处于合并/变基中」是仓库状态，必须常驻，
//   也不该有 ×（用户没法在应用内把它关掉，只能去终端完成或中止）。
//
// 这里只负责判断"该不该计时"和"计时器怎么走"，React 侧只做接线，
// 这样暂停/恢复、文本变化重置这些容易写错的分支都可以用假定时器单测。

export const AUTO_DISMISS_MS = 6000;

// 同一条横幅的身份：类型 + 文案。文案变了（同一位置换了新消息）就必须重新计时，
// 否则用户可能只看到新消息一两秒就被上一条消息的计时收走。
export function noticeTimerKey(notice) {
  if (!notice || typeof notice !== "object") return null;
  const text = typeof notice.text === "string" ? notice.text : "";
  if (!text) return null;
  const type = typeof notice.type === "string" && notice.type ? notice.type : "info";
  return `${type}|${text}`;
}

// 只有"瞬时通知"才自动收起。operationBanner 为真时说明仓库处于合并/变基中，
// 此时显示的是状态横幅（瞬时通知被它遮住），不能计时。
// pinned 是用户手动钉住的通知，按需求"钉住后不再自动收起"。
export function shouldAutoDismiss(notice, operationBanner) {
  if (!notice || typeof notice !== "object") return false;
  if (operationBanner) return false;
  if (notice.pinned) return false;
  return noticeTimerKey(notice) !== null;
}

/**
 * @typedef {object} NoticeTimerDependencies
 * @property {(callback: () => void, ms: number) => any} [setTimeout] injected scheduler (defaults to the global one)
 * @property {(handle: any) => void} [clearTimeout] injected canceller (defaults to the global one)
 * @property {() => void} [onExpire] called once the visible time is up
 * @property {number} [duration] visible milliseconds before `onExpire`
 */

// 注入式的小定时器对象：主流程只调 start / pause / resume / cancel。
// 暂停时直接清掉底层定时器、恢复时重新计满整段时间——这样"鼠标离开后重新计时"
// 不会退化成"离开即立刻消失"，实现也不用维护剩余毫秒。
/** @param {NoticeTimerDependencies} [dependencies] */
export function createNoticeTimer({
  setTimeout: scheduleTimeout,
  clearTimeout: clearScheduled,
  onExpire,
  duration = AUTO_DISMISS_MS,
} = {}) {
  const schedule =
    typeof scheduleTimeout === "function" ? scheduleTimeout : (callback, ms) => globalThis.setTimeout(callback, ms);
  const clear =
    typeof clearScheduled === "function" ? clearScheduled : (handle) => globalThis.clearTimeout(handle);

  let handle = null;
  let key = null;
  let running = false;
  let paused = false;

  const disarm = () => {
    if (handle !== null) {
      clear(handle);
      handle = null;
    }
  };

  const arm = () => {
    disarm();
    handle = schedule(() => {
      handle = null;
      running = false;
      paused = false;
      key = null;
      if (typeof onExpire === "function") onExpire();
    }, duration);
  };

  return {
    start(nextKey) {
      // 文案变化时如果用户正悬停在横幅上，保留暂停状态：只清掉旧倒计时，
      // 等用户离开再重新计满整段时间。
      const wasPaused = paused;
      key = nextKey ?? null;
      running = true;
      paused = wasPaused;
      if (wasPaused) disarm();
      else arm();
    },
    pause() {
      if (!running || paused) return;
      paused = true;
      disarm();
    },
    resume() {
      if (!running || !paused) return;
      paused = false;
      arm();
    },
    cancel() {
      disarm();
      running = false;
      paused = false;
      key = null;
    },
    isRunning() {
      return running;
    },
    isPaused() {
      return paused;
    },
    currentKey() {
      return key;
    },
  };
}

/**
 * @typedef {object} NoticeTimerState
 * @property {{ type?: string, text?: string, pinned?: boolean } | null} [notice] transient success/failure banner
 * @property {boolean} [operationBanner] true while the repository is mid-merge/rebase
 */

// React 接线用的一步：该计时就（重新）启动，不该计时就取消。
// 返回值只用于测试和调试，不参与渲染。
/**
 * @param {ReturnType<typeof createNoticeTimer>} timer
 * @param {NoticeTimerState} [state]
 * @returns {boolean}
 */
export function syncNoticeTimer(timer, { notice, operationBanner } = {}) {
  if (!shouldAutoDismiss(notice, operationBanner)) {
    timer.cancel();
    return false;
  }
  timer.start(noticeTimerKey(notice));
  return true;
}
