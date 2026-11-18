import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTO_DISMISS_MS,
  createNoticeTimer,
  noticeTimerKey,
  shouldAutoDismiss,
  syncNoticeTimer,
} from '../../src/notice-lifecycle.js'

const stagedNotice = { type: 'success', text: '已暂存文件。' }
const unstagedNotice = { type: 'success', text: '已取消暂存文件。' }
const failureNotice = { type: 'error', text: 'Git 操作未完成，请查看命令账本中的诊断信息。' }
// state.operation 推导出来的状态横幅：仓库正在合并/变基，必须常驻。
const operationBanner = {
  type: 'error',
  text: '仓库正在进行合并操作。请在终端完成或中止（git merge --abort）后再继续。',
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('noticeTimerKey', () => {
  it('用类型 + 文案标识同一条通知', () => {
    expect(noticeTimerKey(stagedNotice)).toBe('success|已暂存文件。')
    expect(noticeTimerKey(unstagedNotice)).not.toBe(noticeTimerKey(stagedNotice))
    // 钉住只是显示状态，不改变"这是哪条消息"。
    expect(noticeTimerKey({ ...stagedNotice, pinned: true })).toBe(noticeTimerKey(stagedNotice))
  })

  it('没有文案的通知不参与计时', () => {
    expect(noticeTimerKey(null)).toBeNull()
    expect(noticeTimerKey(undefined)).toBeNull()
    expect(noticeTimerKey({ type: 'success' })).toBeNull()
  })
})

describe('shouldAutoDismiss', () => {
  it('成功与失败类通知都自动收起', () => {
    expect(shouldAutoDismiss(stagedNotice, null)).toBe(true)
    expect(shouldAutoDismiss(failureNotice, null)).toBe(true)
  })

  it('仓库处于合并/变基中时，状态横幅与其后的通知都不自动收起', () => {
    expect(shouldAutoDismiss(operationBanner, operationBanner)).toBe(false)
    expect(shouldAutoDismiss(stagedNotice, operationBanner)).toBe(false)
    expect(shouldAutoDismiss(stagedNotice, 'rebase')).toBe(false)
  })

  it('被钉住的通知不自动收起，没有通知时也不计时', () => {
    expect(shouldAutoDismiss({ ...stagedNotice, pinned: true }, null)).toBe(false)
    expect(shouldAutoDismiss(null, null)).toBe(false)
  })
})

describe('createNoticeTimer', () => {
  it('默认 6 秒后到点收起，且只触发一次', () => {
    expect(AUTO_DISMISS_MS).toBe(6000)
    const onExpire = vi.fn()
    const timer = createNoticeTimer({ onExpire })
    timer.start(noticeTimerKey(stagedNotice))

    vi.advanceTimersByTime(AUTO_DISMISS_MS - 1)
    expect(onExpire).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledTimes(1)
    expect(timer.isRunning()).toBe(false)
    expect(timer.currentKey()).toBeNull()

    vi.advanceTimersByTime(AUTO_DISMISS_MS * 4)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('悬停暂停后不会"离开即消失"，恢复后重新计满整段时间', () => {
    const onExpire = vi.fn()
    const timer = createNoticeTimer({ onExpire })
    timer.start(noticeTimerKey(stagedNotice))

    vi.advanceTimersByTime(AUTO_DISMISS_MS - 200)
    timer.pause()
    expect(timer.isPaused()).toBe(true)

    // 悬停多久都不收起。
    vi.advanceTimersByTime(AUTO_DISMISS_MS * 10)
    expect(onExpire).not.toHaveBeenCalled()

    timer.resume()
    expect(timer.isPaused()).toBe(false)
    vi.advanceTimersByTime(AUTO_DISMISS_MS - 1)
    expect(onExpire).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('文本变化（新的通知对象）重新计时', () => {
    const onExpire = vi.fn()
    const timer = createNoticeTimer({ onExpire })
    timer.start(noticeTimerKey(stagedNotice))

    vi.advanceTimersByTime(AUTO_DISMISS_MS - 100)
    timer.start(noticeTimerKey(unstagedNotice))
    expect(timer.currentKey()).toBe(noticeTimerKey(unstagedNotice))

    vi.advanceTimersByTime(AUTO_DISMISS_MS - 1)
    expect(onExpire).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('悬停中换文案仍保持暂停，离开后重新计满整段时间', () => {
    const onExpire = vi.fn()
    const timer = createNoticeTimer({ onExpire })
    timer.start(noticeTimerKey(stagedNotice))
    timer.pause()

    timer.start(noticeTimerKey(unstagedNotice))
    expect(timer.isPaused()).toBe(true)
    expect(timer.currentKey()).toBe(noticeTimerKey(unstagedNotice))

    vi.advanceTimersByTime(AUTO_DISMISS_MS * 3)
    expect(onExpire).not.toHaveBeenCalled()

    timer.resume()
    vi.advanceTimersByTime(AUTO_DISMISS_MS)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('暂停/恢复在未运行或未暂停时是空操作', () => {
    const onExpire = vi.fn()
    const timer = createNoticeTimer({ onExpire })
    timer.pause()
    timer.resume()
    expect(timer.isRunning()).toBe(false)

    vi.advanceTimersByTime(AUTO_DISMISS_MS * 2)
    expect(onExpire).not.toHaveBeenCalled()
  })

  it('可以注入定时器函数，便于在 React 之外单测', () => {
    const scheduled = []
    const cleared = []
    const onExpire = vi.fn()
    const timer = createNoticeTimer({
      setTimeout: (callback, ms) => {
        scheduled.push({ callback, ms })
        return scheduled.length
      },
      clearTimeout: (handle) => cleared.push(handle),
      onExpire,
      duration: 1234,
    })

    timer.start('success|已暂存文件。')
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0].ms).toBe(1234)

    timer.cancel()
    expect(cleared).toEqual([1])
    expect(onExpire).not.toHaveBeenCalled()
    expect(timer.isRunning()).toBe(false)
  })
})

describe('syncNoticeTimer（React 接线只调这一步）', () => {
  it('× 手动关闭（notice 变空）后取消计时，不会再触发收起', () => {
    const onExpire = vi.fn()
    const timer = createNoticeTimer({ onExpire })

    expect(syncNoticeTimer(timer, { notice: failureNotice, operationBanner: null })).toBe(true)
    vi.advanceTimersByTime(2000)

    expect(syncNoticeTimer(timer, { notice: null, operationBanner: null })).toBe(false)
    expect(timer.isRunning()).toBe(false)

    vi.advanceTimersByTime(AUTO_DISMISS_MS * 2)
    expect(onExpire).not.toHaveBeenCalled()
  })

  it('仓库处于合并/变基中时常驻：计时器根本不启动，回到正常后才开始计时', () => {
    const onExpire = vi.fn()
    const timer = createNoticeTimer({ onExpire })

    expect(syncNoticeTimer(timer, { notice: stagedNotice, operationBanner })).toBe(false)
    vi.advanceTimersByTime(AUTO_DISMISS_MS * 3)
    expect(onExpire).not.toHaveBeenCalled()

    // 合并结束后 operationBanner 消失，同一条通知才开始自动收起。
    expect(syncNoticeTimer(timer, { notice: stagedNotice, operationBanner: null })).toBe(true)
    vi.advanceTimersByTime(AUTO_DISMISS_MS)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('钉住后取消计时，取消钉住后重新计时', () => {
    const onExpire = vi.fn()
    const timer = createNoticeTimer({ onExpire })

    syncNoticeTimer(timer, { notice: stagedNotice, operationBanner: null })
    vi.advanceTimersByTime(3000)

    expect(syncNoticeTimer(timer, { notice: { ...stagedNotice, pinned: true }, operationBanner: null })).toBe(false)
    vi.advanceTimersByTime(AUTO_DISMISS_MS * 2)
    expect(onExpire).not.toHaveBeenCalled()

    expect(syncNoticeTimer(timer, { notice: stagedNotice, operationBanner: null })).toBe(true)
    vi.advanceTimersByTime(AUTO_DISMISS_MS)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })
})
