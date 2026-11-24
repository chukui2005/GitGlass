const fs = require('node:fs')
const path = require('node:path')

// Git reports repository state changes through a small number of files. Watching
// the working tree would report every editor save, so only the git directory
// itself and the refs/logs directories Git rewrites on commit, checkout, merge,
// rebase and stash are watched.
const WATCHED_DIRECTORIES = ['', 'refs', 'logs']
const DEBOUNCE_MS = 800
// A stream of writes (a 200-ref fetch, a batch of branches) must not postpone the
// notification forever: after this long the batch is reported even if it never
// pauses.
const MAX_WAIT_MS = 2000
const SILENT_MS = 1500

// The renderer treats `head` and `refs` as external changes and lets them through
// its quiet window, so a merged batch must report the strongest reason it saw.
const REASON_PRIORITY = { index: 1, refs: 2, head: 3 }

const HEAD_ENTRIES = new Set(['head', 'orig_head', 'merge_head', 'cherry_pick_head', 'revert_head'])
const INDEX_ENTRY = 'index'
const REFS_ENTRY = 'refs'
const PACKED_REFS_ENTRY = 'packed-refs'
const LOGS_ENTRY = 'logs'
const OPERATION_DIRECTORIES = new Set(['rebase-merge', 'rebase-apply'])

function splitWatchPath(filename) {
  if (typeof filename !== 'string') return []
  const normalized = filename
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\.git\//i, '')
    .replace(/\/+$/, '')
  if (!normalized || normalized === '.' || normalized === '..') return []
  return normalized.split('/').filter((segment) => segment && segment !== '.')
}

function mergeReasons(current, next) {
  if (!current) return next
  if (!next) return current
  return (REASON_PRIORITY[next] || 0) > (REASON_PRIORITY[current] || 0) ? next : current
}

// Pure: which repository fact one fs.watch event can change.
// Returns 'head' (branch tip / in-progress operation), 'index' (staged state)
// or 'refs' (branches, tags, packed refs); null means the event is not
// interesting. `directory` is the watched directory the filename is relative to:
// fs.watch reports bare names, so a branch called `feature` inside refs/heads is
// a ref change even though the name alone says nothing.
// Lock files are classified as the file they protect because Git writes them
// first and some platforms only surface the lock name before the rename; the
// debounce merges the pair into one notification.
function classifyWatchEvent(filename, { directory = 'git' } = {}) {
  const segments = splitWatchPath(filename)
  if (!segments.length) return null
  // Everything inside refs/ is a ref by definition (branch, tag, remote-tracking
  // or stash), including `.lock` files and new subdirectories.
  if (directory === 'refs' || directory === 'refs/heads') return 'refs'
  if (directory === 'logs') {
    // Only logs/HEAD follows the checked-out branch. Other reflogs duplicate the
    // refs/* events we already receive, so they are ignored instead of waking the
    // renderer a second time (measured: 0-2 such events per operation, always
    // accompanied by a refs/heads or HEAD event).
    return segments.length === 1 && segments[0].toLowerCase() === 'head' ? 'head' : null
  }
  const first = segments[0].toLowerCase()
  const last = segments[segments.length - 1].toLowerCase().replace(/\.lock$/, '')
  if (segments.length === 1) {
    if (HEAD_ENTRIES.has(last)) return 'head'
    if (last === INDEX_ENTRY) return 'index'
    if (last === REFS_ENTRY || last === PACKED_REFS_ENTRY) return 'refs'
    // A bare `logs` event means something below the logs directory changed. It is
    // usually a reflog for a ref (Windows also bumps the directory mtime for
    // nested writes), while the checked-out branch's reflog is reported as `HEAD`
    // by the logs watcher itself, so this one is only a ref change.
    if (last === LOGS_ENTRY) return 'refs'
    if (OPERATION_DIRECTORIES.has(last)) return 'head'
    return null
  }
  if (first === REFS_ENTRY) return 'refs'
  // logs/HEAD is the reflog of the checked-out branch; other log files follow refs.
  if (first === LOGS_ENTRY) return last === 'head' ? 'head' : 'refs'
  if (OPERATION_DIRECTORIES.has(first)) return 'head'
  // objects/, hooks/, worktrees/ and friends never need a refresh on their own.
  return null
}

// Pure: coalesce a burst of watcher events into as few onFire(reason) calls as
// possible without losing the final state.
// - The first event of a quiet period is reported immediately (leading edge), so
//   the renderer does not wait for a long fetch to finish.
// - Further events are merged (highest-priority reason wins) and reported once
//   the burst has been quiet for `delay`.
// - A burst that never pauses is still reported every `maxWait` milliseconds.
function createDebouncer({
  delay = DEBOUNCE_MS,
  maxWait = MAX_WAIT_MS,
  onFire,
  now = Date.now,
  setTimeout: schedule = setTimeout,
  clearTimeout: cancelTimer = clearTimeout,
}) {
  let timer = null
  let pendingReason = null
  let batchStartedAt = null
  let lastEventAt = null
  const reportPending = () => {
    const reason = pendingReason
    pendingReason = null
    if (reason) onFire(reason)
  }
  return {
    push(reason) {
      if (!reason) return false
      const current = now()
      // A quiet gap of one full debounce window ends the previous burst; the next
      // event leads so a fresh external change is visible immediately.
      const idle = batchStartedAt === null || current - lastEventAt >= delay
      lastEventAt = current
      if (idle) {
        batchStartedAt = current
        if (timer !== null) cancelTimer(timer)
        timer = null
        pendingReason = null
        onFire(reason)
        return true
      }
      pendingReason = mergeReasons(pendingReason, reason)
      const elapsed = current - batchStartedAt
      if (elapsed >= maxWait) {
        // The burst is still producing events at the hard limit: report now and
        // restart the accounting instead of postponing the update again.
        reportPending()
        batchStartedAt = current
        if (timer !== null) cancelTimer(timer)
        timer = null
        return true
      }
      if (timer !== null) cancelTimer(timer)
      timer = schedule(() => {
        timer = null
        // Restart the max-wait accounting from the report, not from the first
        // event, so a stream that keeps writing cannot fire twice in a row.
        batchStartedAt = now()
        reportPending()
      }, Math.min(delay, maxWait - elapsed))
      return true
    },
    cancel() {
      if (timer !== null) cancelTimer(timer)
      timer = null
      pendingReason = null
      batchStartedAt = null
      lastEventAt = null
    },
    get pending() {
      return pendingReason !== null || timer !== null
    },
  }
}

// Watches the .git directory of one repository and reports coalesced changes.
// `notifyIgnored(ms)` opens a silent window so the Git commands GitGlass runs
// itself are not reported back as an external change.
class RepositoryWatcher {
  constructor({
    debounceMs = DEBOUNCE_MS,
    maxWaitMs = MAX_WAIT_MS,
    silentMs = SILENT_MS,
    watch = fs.watch,
    existsSync = fs.existsSync,
    now = Date.now,
    setTimeout: schedule = setTimeout,
    clearTimeout: cancel = clearTimeout,
    onError = null,
  } = {}) {
    this.debounceMs = debounceMs
    this.maxWaitMs = maxWaitMs
    this.silentMs = silentMs
    this.watchFileSystem = watch
    this.existsSync = existsSync
    this.now = now
    this.schedule = schedule
    this.cancel = cancel
    // Called when the last fs.watch handle dies asynchronously; the main process
    // turns this into a renderer-visible "automatic refresh unavailable" signal.
    this.onError = onError
    this.handles = []
    this.debouncer = null
    this.onChange = null
    this.ignoredWindows = []
  }

  // Starts watching `gitDirectory`; a previous watch() is closed first so a
  // repository switch cannot leave an old watcher behind. Returns false when no
  // path could be watched at all.
  watch(gitDirectory, onChange) {
    this.close()
    if (typeof gitDirectory !== 'string' || !gitDirectory) return false
    if (typeof onChange === 'function') this.onChange = onChange
    this.ignoredWindows = []
    this.debouncer = createDebouncer({
      delay: this.debounceMs,
      maxWait: this.maxWaitMs,
      now: this.now,
      setTimeout: this.schedule,
      clearTimeout: this.cancel,
      onFire: (reason) => {
        if (this.isIgnored(reason)) return
        if (this.onChange) this.onChange({ reason })
      },
    })
    for (const directory of WATCHED_DIRECTORIES) {
      const target = directory ? path.join(gitDirectory, ...directory.split('/')) : gitDirectory
      // refs can be absent (packed refs only) and rebase/merge state comes
      // and goes while the app runs, so missing paths are expected.
      if (!this.existsSync(target)) continue
      const kind = directory || 'git'
      try {
        // Fetch writes remote-tracking refs below refs/remotes/<remote>, which
        // a non-recursive watch on refs does not see on Windows.
        const options = { persistent: false, recursive: directory === 'refs' }
        const handle = this.watchFileSystem(target, options, (_event, filename) => this.handleEvent(filename, kind))
        // fs.watch can also die asynchronously (network drive dropped, directory
        // deleted): drop the dead handle and report when the last one is gone,
        // so the app can tell the user automatic refresh is unavailable (#21).
        if (typeof handle.on === 'function') handle.on('error', () => this.handleWatchFailure(handle))
        this.handles.push(handle)
      } catch {
        // The directory can disappear between existsSync and watch(); a watch()
        // that throws for every directory leaves zero handles, which the return
        // value reports as unavailable.
      }
    }
    return this.handles.length > 0
  }

  // Feeds one filesystem event through the filename filter, the silent window and
  // the coalescing debouncer. Exposed for tests; real callers come from fs.watch.
  handleEvent(filename, directory = 'git') {
    const reason = classifyWatchEvent(filename, { directory })
    if (!reason) return false
    if (this.isIgnored(reason)) return false
    if (!this.debouncer) return false
    return this.debouncer.push(reason)
  }

  // Drops events for the next `ms`. Without `reasons` every event is dropped
  // (GitGlass uses that around the Git commands it runs so their writes are not
  // reported as external changes). With `reasons` only those kinds are dropped:
  // `git status` rewrites .git/index, so reads silence `index` alone and keep
  // reporting external HEAD/ref changes that happen while a refresh is running.
  /**
   * @param {number} [ms]
   * @param {{ reasons?: string[] }} [options]
   */
  notifyIgnored(ms, options = {}) {
    const duration = Number.isFinite(ms) && ms > 0 ? ms : this.silentMs
    const current = this.now()
    const until = current + duration
    const reasons = options.reasons
    const filter = Array.isArray(reasons) && reasons.length > 0 ? new Set(reasons) : null
    this.ignoredWindows = this.ignoredWindows.filter((window) => window.until > current)
    this.ignoredWindows.push({ until, reasons: filter })
    return until
  }

  isIgnored(reason) {
    const current = this.now()
    this.ignoredWindows = this.ignoredWindows.filter((window) => window.until > current)
    return this.ignoredWindows.some((window) => window.reasons === null || window.reasons.has(reason))
  }

  // One fs.watch handle died asynchronously. Total loss (no handles left) is
  // reported through onError so the main process can downgrade the UI; partial
  // loss keeps watching the remaining directories.
  handleWatchFailure(handle) {
    const index = this.handles.indexOf(handle)
    if (index === -1) return
    this.handles.splice(index, 1)
    try {
      handle.close()
    } catch {
      // Already dead; nothing to release.
    }
    if (!this.handles.length && this.debouncer && typeof this.onError === 'function') this.onError()
  }

  // Idempotent: safe to call on every window close, quit and repository switch.
  close() {
    for (const handle of this.handles) {
      try {
        handle.close()
      } catch {
        // Already closed; nothing to release.
      }
    }
    this.handles = []
    if (this.debouncer) {
      this.debouncer.cancel()
      this.debouncer = null
    }
  }

  get watching() {
    return this.handles.length > 0
  }
}

module.exports = { RepositoryWatcher, classifyWatchEvent, createDebouncer, mergeReasons, WATCHED_DIRECTORIES, DEBOUNCE_MS, MAX_WAIT_MS, SILENT_MS }
