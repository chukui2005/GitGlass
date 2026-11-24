import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RepositoryWatcher, classifyWatchEvent, createDebouncer, mergeReasons } from '../../electron/repository-watcher.cjs'

// Deterministic timer + clock: the debounce and silent windows are asserted
// without a single real sleep.
function createClock(start = 0) {
  let current = start
  let nextId = 1
  const timers = new Map()
  return {
    now: () => current,
    setTimeout: (callback, delay) => {
      const id = nextId++
      timers.set(id, { at: current + delay, callback })
      return id
    },
    clearTimeout: (id) => timers.delete(id),
    advance(ms) {
      const target = current + ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        current = due[1].at
        due[1].callback()
      }
      current = target
    },
    get pendingTimers() {
      return timers.size
    },
  }
}

function createFakeWatch() {
  const calls = []
  const watch = (target, options, listener) => {
    const handle = { target, options, listener, closed: false, close() { this.closed = true } }
    calls.push(handle)
    return handle
  }
  watch.calls = calls
  return watch
}

let directory
afterEach(() => {
  if (directory) fs.rmSync(directory, { recursive: true, force: true })
  directory = null
})

function gitDirectoryFixture(entries = ['', 'refs', 'refs/heads', 'logs']) {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-watcher-'))
  const gitDirectory = path.join(directory, '.git')
  for (const entry of entries) {
    fs.mkdirSync(entry ? path.join(gitDirectory, ...entry.split('/')) : gitDirectory, { recursive: true })
  }
  return gitDirectory
}

function createWatcher(overrides = {}) {
  const clock = createClock()
  const watch = overrides.watch || createFakeWatch()
  const watcher = new RepositoryWatcher({
    watch,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ...overrides.options,
  })
  return { watcher, clock, watch }
}

function listenerFor(watch, target) {
  const call = watch.calls.find((entry) => entry.target === target)
  expect(call, `no watcher registered for ${target}`).toBeTruthy()
  return call.listener
}

describe('classifyWatchEvent', () => {
  it('maps the git directory files Git writes on commit, checkout and merge', () => {
    expect(classifyWatchEvent('HEAD')).toBe('head')
    expect(classifyWatchEvent('.git/HEAD')).toBe('head')
    expect(classifyWatchEvent('MERGE_HEAD')).toBe('head')
    expect(classifyWatchEvent('CHERRY_PICK_HEAD')).toBe('head')
    expect(classifyWatchEvent('REVERT_HEAD')).toBe('head')
    expect(classifyWatchEvent('ORIG_HEAD')).toBe('head')
    expect(classifyWatchEvent('rebase-merge')).toBe('head')
    expect(classifyWatchEvent('rebase-apply')).toBe('head')
    expect(classifyWatchEvent('logs/HEAD')).toBe('head')
  })

  it('separates staged state from refs', () => {
    expect(classifyWatchEvent('index')).toBe('index')
    expect(classifyWatchEvent('refs')).toBe('refs')
    expect(classifyWatchEvent('packed-refs')).toBe('refs')
    // The directory entry itself only says "something under logs/ changed"; the
    // checked-out branch's reflog arrives as logs/HEAD, so this is a ref change.
    expect(classifyWatchEvent('logs')).toBe('refs')
    expect(classifyWatchEvent('refs/heads/main')).toBe('refs')
    expect(classifyWatchEvent('.git/refs/heads/feature/report')).toBe('refs')
    expect(classifyWatchEvent('logs/refs/heads/main')).toBe('refs')
  })

  it('classifies lock files as the file they protect instead of dropping the event', () => {
    // Git writes index.lock first and renames it; some platforms surface only
    // the lock name, and the debounce merges the pair into one report.
    expect(classifyWatchEvent('.git/index.lock')).toBe('index')
    expect(classifyWatchEvent('index.lock')).toBe('index')
    expect(classifyWatchEvent('HEAD.lock')).toBe('head')
    expect(classifyWatchEvent('refs/heads/main.lock')).toBe('refs')
  })

  it('treats every file under refs/ and refs/heads as a ref change', () => {
    // fs.watch reports names relative to the watched directory, so a 200-branch
    // burst arrives as bare branch names; they must not be dropped.
    expect(classifyWatchEvent('local-1', { directory: 'refs/heads' })).toBe('refs')
    expect(classifyWatchEvent('feature', { directory: 'refs/heads' })).toBe('refs')
    expect(classifyWatchEvent('main.lock', { directory: 'refs/heads' })).toBe('refs')
    expect(classifyWatchEvent('heads', { directory: 'refs' })).toBe('refs')
    expect(classifyWatchEvent('remotes', { directory: 'refs' })).toBe('refs')
    expect(classifyWatchEvent('tags', { directory: 'refs' })).toBe('refs')
  })

  it('keeps only logs/HEAD and drops the duplicate per-ref reflogs', () => {
    // Measured: a commit writes logs/HEAD; the refs/* watchers already report the
    // matching ref write, so other reflog events would only double the refresh.
    expect(classifyWatchEvent('HEAD', { directory: 'logs' })).toBe('head')
    expect(classifyWatchEvent('refs', { directory: 'logs' })).toBeNull()
    expect(classifyWatchEvent('stash', { directory: 'logs' })).toBeNull()
  })

  it('ignores working-tree-only and unrelated paths', () => {
    expect(classifyWatchEvent('objects/ab/cdef0123')).toBeNull()
    expect(classifyWatchEvent('COMMIT_EDITMSG')).toBeNull()
    expect(classifyWatchEvent('hooks/pre-commit')).toBeNull()
    expect(classifyWatchEvent('src/main.jsx')).toBeNull()
    expect(classifyWatchEvent('')).toBeNull()
    expect(classifyWatchEvent(undefined)).toBeNull()
  })
})

describe('mergeReasons', () => {
  it('keeps the strongest reason so a commit is reported as head, not index', () => {
    expect(mergeReasons('index', 'refs')).toBe('refs')
    expect(mergeReasons('refs', 'index')).toBe('refs')
    expect(mergeReasons('refs', 'head')).toBe('head')
    expect(mergeReasons('head', 'index')).toBe('head')
    expect(mergeReasons(null, 'index')).toBe('index')
    expect(mergeReasons('head', null)).toBe('head')
  })
})

describe('createDebouncer', () => {
  function createRecorder() {
    const clock = createClock()
    const fired = []
    const debouncer = createDebouncer({
      delay: 800,
      maxWait: 2000,
      onFire: (reason) => fired.push({ reason, at: clock.now() }),
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    })
    return { clock, fired, debouncer }
  }

  it('reports the first event immediately (leading edge)', () => {
    const { clock, fired, debouncer } = createRecorder()
    debouncer.push('index')
    expect(fired).toEqual([{ reason: 'index', at: 0 }])
    expect(debouncer.pending).toBe(false)
    // Nothing else was queued, so no trailing notification follows.
    clock.advance(5000)
    expect(fired).toHaveLength(1)
  })

  it('coalesces the rest of a burst into one trailing notification with the strongest reason', () => {
    const { clock, fired, debouncer } = createRecorder()
    debouncer.push('index')
    clock.advance(100)
    debouncer.push('refs')
    clock.advance(100)
    debouncer.push('head')
    clock.advance(799)
    expect(fired).toEqual([{ reason: 'index', at: 0 }])
    clock.advance(1)
    // 800 ms after the last event, one notification carrying head (not index).
    expect(fired).toEqual([
      { reason: 'index', at: 0 },
      { reason: 'head', at: 1000 },
    ])
    expect(clock.pendingTimers).toBe(0)
  })

  it('keeps reporting a stream that never pauses, at most every maxWait', () => {
    const { clock, fired, debouncer } = createRecorder()
    for (let index = 0; index < 20; index++) {
      debouncer.push('index')
      clock.advance(250)
    }
    expect(fired.map((entry) => entry.at)).toEqual([0, 2000, 4000])
    // The final trailing report lands one debounce window after the last write.
    clock.advance(2000)
    expect(fired.map((entry) => entry.at)).toEqual([0, 2000, 4000, 5550])
    for (let index = 1; index < fired.length - 1; index++) {
      expect(fired[index].at - fired[index - 1].at).toBeGreaterThanOrEqual(2000)
    }
  })

  it('lets the next event lead again after a quiet gap', () => {
    const { clock, fired, debouncer } = createRecorder()
    debouncer.push('index')
    clock.advance(3000)
    debouncer.push('head')
    expect(fired).toEqual([
      { reason: 'index', at: 0 },
      { reason: 'head', at: 3000 },
    ])
  })

  it('drops a pending trailing notification on cancel() and ignores empty reasons', () => {
    const { clock, fired, debouncer } = createRecorder()
    expect(debouncer.push(null)).toBe(false)
    expect(debouncer.push('')).toBe(false)
    expect(debouncer.pending).toBe(false)
    debouncer.push('index')
    clock.advance(100)
    debouncer.push('head')
    expect(debouncer.pending).toBe(true)
    debouncer.cancel()
    clock.advance(5000)
    expect(fired).toEqual([{ reason: 'index', at: 0 }])
  })
})

describe('RepositoryWatcher', () => {
  it('watches the git directory plus the refs and logs directories that exist', () => {
    const gitDirectory = gitDirectoryFixture()
    const { watcher, watch } = createWatcher()
    expect(watcher.watch(gitDirectory, () => {})).toBe(true)
    expect(watch.calls.map((call) => path.relative(gitDirectory, call.target)).sort()).toEqual(['', 'logs', 'refs'])
    expect(watch.calls.filter((call) => call.options.recursive).map((call) => path.basename(call.target))).toEqual(['refs'])
    expect(watch.calls.every((call) => call.options.persistent === false)).toBe(true)
    expect(watcher.watching).toBe(true)
    watcher.close()
  })

  it('tolerates git paths that do not exist and reports when nothing can be watched', () => {
    const gitDirectory = gitDirectoryFixture([''])
    const { watcher, watch } = createWatcher()
    expect(watcher.watch(gitDirectory, () => {})).toBe(true)
    // Only the git directory itself exists here; refs/logs are skipped, not fatal.
    expect(watch.calls).toHaveLength(1)
    watcher.close()
    expect(watcher.watch(path.join(directory, 'missing'), () => {})).toBe(false)
    expect(watcher.watching).toBe(false)
  })

  it('reports unavailable when every fs.watch call throws synchronously', () => {
    const gitDirectory = gitDirectoryFixture()
    const onError = vi.fn()
    const throwingWatch = () => { throw new Error('EPERM: operation not permitted') }
    const { watcher } = createWatcher({ watch: throwingWatch, options: { onError } })
    expect(watcher.watch(gitDirectory, () => {})).toBe(false)
    expect(watcher.watching).toBe(false)
    // 同步失败走 watch() 的返回值，不走 onError。
    expect(onError).not.toHaveBeenCalled()
    watcher.close()
  })

  it('stays available when only some directories fail to watch', () => {
    const gitDirectory = gitDirectoryFixture()
    const watch = (target, options, listener) => {
      if (/refs|logs/.test(target)) throw new Error('EACCES')
      const handle = { target, listener, closed: false, close() { this.closed = true } }
      return handle
    }
    const { watcher } = createWatcher({ watch })
    expect(watcher.watch(gitDirectory, () => {})).toBe(true)
    // git 目录本身还在监视：HEAD 与 index 的变化仍能看到。
    expect(watcher.watching).toBe(true)
    watcher.close()
  })

  it('reports total loss once every handle errors asynchronously', () => {
    const gitDirectory = gitDirectoryFixture()
    const onError = vi.fn()
    const handles = []
    const watch = (target, options, listener) => {
      const handle = { target, listener, closed: false, close() { this.closed = true }, on(event, callback) { handle.fail = callback } }
      handles.push(handle)
      return handle
    }
    const { watcher } = createWatcher({ watch, options: { onError } })
    watcher.watch(gitDirectory, () => {})
    expect(watcher.watching).toBe(true)
    // 部分句柄死亡仍是可用：剩下的目录继续监视。
    handles[0].fail(new Error('ENOENT'))
    expect(watcher.watching).toBe(true)
    expect(onError).not.toHaveBeenCalled()
    for (const handle of handles) if (handle.fail) handle.fail(new Error('ENOENT'))
    expect(watcher.watching).toBe(false)
    expect(onError).toHaveBeenCalledTimes(1)
    // 迟到的重复 error（已拆除的句柄）不再触发。
    for (const handle of handles) if (handle.fail) handle.fail(new Error('ENOENT'))
    expect(onError).toHaveBeenCalledTimes(1)
    watcher.close()
  })

  it('reports the first filesystem event immediately and coalesces the rest', () => {
    const gitDirectory = gitDirectoryFixture()
    const { watcher, clock, watch } = createWatcher()
    const reasons = []
    watcher.watch(gitDirectory, ({ reason }) => reasons.push(reason))
    const listener = listenerFor(watch, gitDirectory)
    listener('rename', 'index')
    expect(reasons).toEqual(['index'])
    clock.advance(300)
    listener('change', 'HEAD')
    clock.advance(799)
    expect(reasons).toEqual(['index'])
    clock.advance(1)
    expect(reasons).toEqual(['index', 'head'])
    watcher.close()
  })

  it('never reports files that cannot change repository state', () => {
    const gitDirectory = gitDirectoryFixture()
    const { watcher, clock, watch } = createWatcher()
    const reasons = []
    watcher.watch(gitDirectory, ({ reason }) => reasons.push(reason))
    const listener = listenerFor(watch, gitDirectory)
    for (const filename of ['COMMIT_EDITMSG', 'objects/ab/cdef', 'src/main.jsx']) listener('change', filename)
    clock.advance(5000)
    expect(reasons).toEqual([])
    watcher.close()
  })

  it('turns a burst of 200 branch names under refs/heads into two notifications', () => {
    const gitDirectory = gitDirectoryFixture()
    const { watcher, clock, watch } = createWatcher()
    const reasons = []
    watcher.watch(gitDirectory, ({ reason }) => reasons.push(reason))
    const listener = listenerFor(watch, path.join(gitDirectory, 'refs'))
    for (let index = 0; index < 200; index++) listener('rename', `heads/branch-${index}`)
    expect(reasons).toEqual(['refs'])
    clock.advance(800)
    expect(reasons).toEqual(['refs', 'refs'])
    watcher.close()
  })

  it('drops events received inside the silent window and reports again after it', () => {
    const gitDirectory = gitDirectoryFixture()
    const { watcher, clock, watch } = createWatcher()
    const reasons = []
    watcher.watch(gitDirectory, ({ reason }) => reasons.push(reason))
    const listener = listenerFor(watch, gitDirectory)
    watcher.notifyIgnored(1500)
    listener('change', 'HEAD')
    clock.advance(2000)
    expect(reasons).toEqual([])
    listener('change', 'HEAD')
    expect(reasons).toEqual(['head'])
    watcher.close()
  })

  it('can silence only index events so external HEAD/ref changes still arrive', () => {
    const gitDirectory = gitDirectoryFixture()
    const { watcher, clock, watch } = createWatcher()
    const reasons = []
    watcher.watch(gitDirectory, ({ reason }) => reasons.push(reason))
    const listener = listenerFor(watch, gitDirectory)
    // This is what main.cjs does around `repo:state`: `git status` may rewrite
    // .git/index, but an external commit must still be reported while it runs.
    watcher.notifyIgnored(1000, { reasons: ['index'] })
    listener('change', 'index')
    listener('change', 'HEAD')
    expect(reasons).toEqual(['head'])
    clock.advance(1500)
    listener('change', 'index')
    expect(reasons).toEqual(['head', 'index'])
    watcher.close()
  })

  it('drops a queued trailing notification when our own Git command starts', () => {
    const gitDirectory = gitDirectoryFixture()
    const { watcher, clock, watch } = createWatcher()
    const reasons = []
    watcher.watch(gitDirectory, ({ reason }) => reasons.push(reason))
    const listener = listenerFor(watch, gitDirectory)
    listener('change', 'HEAD')
    clock.advance(100)
    listener('change', 'index')
    // A GitGlass Git command starts before the trailing debounce fires.
    watcher.notifyIgnored(1500)
    clock.advance(800)
    expect(reasons).toEqual(['head'])
    watcher.close()
  })

  it('closes every handle and stays safe when close() is called twice', () => {
    const gitDirectory = gitDirectoryFixture()
    const { watcher, clock, watch } = createWatcher()
    const reasons = []
    watcher.watch(gitDirectory, ({ reason }) => reasons.push(reason))
    const listener = listenerFor(watch, gitDirectory)
    listener('change', 'HEAD')
    expect(watcher.watching).toBe(true)
    watcher.close()
    expect(watch.calls.every((call) => call.closed)).toBe(true)
    expect(watcher.watching).toBe(false)
    // Events already queued by the OS after close() must not surface.
    listener('change', 'HEAD')
    clock.advance(5000)
    expect(reasons).toEqual(['head'])
    expect(() => watcher.close()).not.toThrow()
  })

  it('replaces the previous watch when watch() is called again', () => {
    const first = gitDirectoryFixture()
    const { watcher, watch } = createWatcher()
    watcher.watch(first, () => {})
    const second = gitDirectoryFixture()
    watcher.watch(second, () => {})
    expect(watch.calls.filter((call) => call.closed)).toHaveLength(3)
    expect(watch.calls.slice(3).every((call) => !call.closed)).toBe(true)
    expect(watch.calls.slice(3).every((call) => call.target.startsWith(second))).toBe(true)
    watcher.close()
    fs.rmSync(path.dirname(first), { recursive: true, force: true })
  })
})
