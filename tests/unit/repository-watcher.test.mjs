import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { RepositoryWatcher, classifyWatchEvent, createDebouncer } from '../../electron/repository-watcher.cjs'

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
    expect(classifyWatchEvent('refs/heads/main')).toBe('refs')
    expect(classifyWatchEvent('.git/refs/heads/feature/report')).toBe('refs')
    expect(classifyWatchEvent('logs/refs/heads/main')).toBe('refs')
  })

  it('classifies lock files as the file they protect instead of dropping the event', () => {
    // Git writes index.lock first and renames it; some platforms surface only
    // the lock name, and the 800ms debounce merges the pair into one report.
    expect(classifyWatchEvent('.git/index.lock')).toBe('index')
    expect(classifyWatchEvent('index.lock')).toBe('index')
    expect(classifyWatchEvent('HEAD.lock')).toBe('head')
    expect(classifyWatchEvent('refs/heads/main.lock')).toBe('refs')
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

describe('createDebouncer', () => {
  it('merges a burst into one notification after the delay', () => {
    const clock = createClock()
    const fired = []
    const debouncer = createDebouncer({
      delay: 800,
      onFire: (reason) => fired.push(reason),
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    })
    debouncer.push('index')
    clock.advance(500)
    debouncer.push('refs')
    clock.advance(799)
    expect(fired).toEqual([])
    clock.advance(1)
    expect(fired).toEqual(['index'])
    expect(clock.pendingTimers).toBe(0)
  })

  it('reports once per round even when events keep arriving slowly', () => {
    const clock = createClock()
    const fired = []
    const debouncer = createDebouncer({
      delay: 800,
      onFire: (reason) => fired.push(reason),
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    })
    for (let round = 0; round < 3; round++) {
      debouncer.push(round === 0 ? 'head' : 'refs')
      clock.advance(800)
    }
    expect(fired).toEqual(['head', 'refs', 'refs'])
  })

  it('drops a pending notification on cancel() and ignores empty reasons', () => {
    const clock = createClock()
    const fired = []
    const debouncer = createDebouncer({
      delay: 800,
      onFire: (reason) => fired.push(reason),
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    })
    expect(debouncer.push(null)).toBe(false)
    expect(debouncer.push('')).toBe(false)
    expect(debouncer.pending).toBe(false)
    debouncer.push('index')
    expect(debouncer.pending).toBe(true)
    debouncer.cancel()
    clock.advance(5000)
    expect(fired).toEqual([])
  })
})

describe('RepositoryWatcher', () => {
  it('watches the git directory plus the refs and logs directories that exist', () => {
    const gitDirectory = gitDirectoryFixture()
    const { watcher, watch } = createWatcher()
    expect(watcher.watch(gitDirectory, () => {})).toBe(true)
    expect(watch.calls.map((call) => path.relative(gitDirectory, call.target)).sort()).toEqual(['', 'logs', 'refs', 'refs\\heads'])
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

  it('debounces a burst of filesystem events into one change notification', () => {
    const gitDirectory = gitDirectoryFixture()
    const { watcher, clock, watch } = createWatcher()
    const reasons = []
    watcher.watch(gitDirectory, ({ reason }) => reasons.push(reason))
    const listener = listenerFor(watch, gitDirectory)
    listener('rename', 'index')
    clock.advance(300)
    listener('change', 'index')
    clock.advance(799)
    expect(reasons).toEqual([])
    clock.advance(1)
    expect(reasons).toEqual(['index'])
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
    clock.advance(800)
    expect(reasons).toEqual(['head'])
    watcher.close()
  })

  it('drops a notification already scheduled when our own Git command starts', () => {
    const gitDirectory = gitDirectoryFixture()
    const { watcher, clock, watch } = createWatcher()
    const reasons = []
    watcher.watch(gitDirectory, ({ reason }) => reasons.push(reason))
    const listener = listenerFor(watch, gitDirectory)
    listener('change', 'index')
    // A GitGlass Git command starts before the 800ms debounce fires.
    watcher.notifyIgnored(1500)
    clock.advance(800)
    expect(reasons).toEqual([])
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
    expect(reasons).toEqual([])
    expect(() => watcher.close()).not.toThrow()
  })

  it('replaces the previous watch when watch() is called again', () => {
    const first = gitDirectoryFixture()
    const { watcher, watch } = createWatcher()
    watcher.watch(first, () => {})
    const second = gitDirectoryFixture()
    watcher.watch(second, () => {})
    expect(watch.calls.filter((call) => call.closed)).toHaveLength(4)
    expect(watch.calls.slice(4).every((call) => !call.closed)).toBe(true)
    expect(watch.calls.slice(4).every((call) => call.target.startsWith(second))).toBe(true)
    watcher.close()
    fs.rmSync(path.dirname(first), { recursive: true, force: true })
  })
})
