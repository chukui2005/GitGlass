const fs = require('node:fs')
const path = require('node:path')

// Git reports repository state changes through a small number of files. Watching
// the working tree would report every editor save, so only the git directory
// itself and the refs/logs directories Git rewrites on commit, checkout, merge,
// rebase and stash are watched.
const WATCHED_DIRECTORIES = ['', 'refs', 'refs/heads', 'logs']
const DEBOUNCE_MS = 800
const SILENT_MS = 1500

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

// Pure: which repository fact an fs.watch filename can change.
// Returns 'head' (branch tip / in-progress operation), 'index' (staged state)
// or 'refs' (branches, tags, packed refs); null means the event is not
// interesting. Lock files are classified as the file they protect because Git
// writes them first and some platforms only surface the lock name before the
// rename, while the debounce merges the pair into one notification.
function classifyWatchEvent(filename) {
  const segments = splitWatchPath(filename)
  if (!segments.length) return null
  const first = segments[0].toLowerCase()
  const last = segments[segments.length - 1].toLowerCase().replace(/\.lock$/, '')
  if (segments.length === 1) {
    if (HEAD_ENTRIES.has(last)) return 'head'
    if (last === INDEX_ENTRY) return 'index'
    if (last === REFS_ENTRY || last === PACKED_REFS_ENTRY) return 'refs'
    if (last === LOGS_ENTRY) return 'head'
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

// Pure: merge a burst of watcher events into one onFire(reason) call.
// The first interesting reason of the round wins; the timer restarts on every
// push so a burst of writes ends in exactly one notification.
function createDebouncer({ delay, onFire, setTimeout: schedule = setTimeout, clearTimeout: cancel = clearTimeout }) {
  let timer = null
  let pendingReason = null
  return {
    push(reason) {
      if (!reason) return false
      if (pendingReason === null) pendingReason = reason
      if (timer !== null) cancel(timer)
      timer = schedule(() => {
        timer = null
        const reasonToReport = pendingReason
        pendingReason = null
        if (reasonToReport !== null) onFire(reasonToReport)
      }, delay)
      return true
    },
    cancel() {
      if (timer !== null) cancel(timer)
      timer = null
      pendingReason = null
    },
    get pending() {
      return pendingReason !== null
    },
  }
}

// Watches the .git directory of one repository and reports debounced changes.
// `notifyIgnored(ms)` opens a silent window so the Git commands GitGlass runs
// itself are not reported back as an external change.
class RepositoryWatcher {
  constructor({
    debounceMs = DEBOUNCE_MS,
    silentMs = SILENT_MS,
    watch = fs.watch,
    existsSync = fs.existsSync,
    now = Date.now,
    setTimeout: schedule = setTimeout,
    clearTimeout: cancel = clearTimeout,
  } = {}) {
    this.debounceMs = debounceMs
    this.silentMs = silentMs
    this.watchFileSystem = watch
    this.existsSync = existsSync
    this.now = now
    this.schedule = schedule
    this.cancel = cancel
    this.handles = []
    this.debouncer = null
    this.onChange = null
    this.ignoredUntil = 0
  }

  // Starts watching `gitDirectory`; a previous watch() is closed first so a
  // repository switch cannot leave an old watcher behind. Returns false when no
  // path could be watched at all.
  watch(gitDirectory, onChange) {
    this.close()
    if (typeof gitDirectory !== 'string' || !gitDirectory) return false
    if (typeof onChange === 'function') this.onChange = onChange
    this.ignoredUntil = 0
    this.debouncer = createDebouncer({
      delay: this.debounceMs,
      setTimeout: this.schedule,
      clearTimeout: this.cancel,
      onFire: (reason) => {
        if (this.now() < this.ignoredUntil) return
        if (this.onChange) this.onChange({ reason })
      },
    })
    for (const directory of WATCHED_DIRECTORIES) {
      const target = directory ? path.join(gitDirectory, ...directory.split('/')) : gitDirectory
      // refs/heads can be absent (packed refs only) and rebase/merge state comes
      // and goes while the app runs, so missing paths are expected.
      if (!this.existsSync(target)) continue
      try {
        this.handles.push(this.watchFileSystem(target, { persistent: false }, (_event, filename) => this.handleEvent(filename)))
      } catch {
        // The directory can disappear between existsSync and watch().
      }
    }
    return this.handles.length > 0
  }

  // Feeds one filesystem event through the filename filter and the silent
  // window. Exposed for tests; real callers come from fs.watch above.
  handleEvent(filename) {
    const reason = classifyWatchEvent(filename)
    if (!reason) return false
    if (this.now() < this.ignoredUntil) return false
    if (!this.debouncer) return false
    return this.debouncer.push(reason)
  }

  // Drops every event for the next `ms`; GitGlass calls this around the Git
  // commands it runs so their writes do not look like an external change.
  notifyIgnored(ms) {
    const duration = Number.isFinite(ms) && ms > 0 ? ms : this.silentMs
    this.ignoredUntil = Math.max(this.ignoredUntil, this.now() + duration)
    return this.ignoredUntil
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

module.exports = { RepositoryWatcher, classifyWatchEvent, createDebouncer, WATCHED_DIRECTORIES, DEBOUNCE_MS, SILENT_MS }
