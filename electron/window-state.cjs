const fs = require('node:fs')
const path = require('node:path')

// Remembers the main window's normal bounds in `userData/window-state.json`,
// following the same rules as RecentRepositories: a missing, oversized or
// damaged file falls back to defaults and never blocks launch. The file only
// ever holds four integers (width/height/x/y) — no repository data.
const MAX_FILE_BYTES = 64 * 1024
// Default size: a ratio of the work area, capped so huge monitors do not get a
// huge window, and clamped to minWidth/minHeight so small laptops still get a
// usable window (issue #19: the old fixed 1500×940 overflowed 1366×768).
const DEFAULT_WIDTH = 1400
const DEFAULT_HEIGHT = 940
const WORK_AREA_RATIO = 0.8
// A saved position only survives when enough of the window is still visible on
// some display's work area: 200×100 px of body plus at least half of a 64px
// title strip (the self-drawn title bar is 48px), so the window controls stay
// reachable after a monitor is unplugged or a resolution changes.
const MIN_VISIBLE_WIDTH = 200
const MIN_VISIBLE_HEIGHT = 100
const TITLE_STRIP_HEIGHT = 64

class WindowStateStore {
  constructor(file) {
    this.file = file
    this.value = this.load()
  }

  // Raw passthrough: numeric validation lives in resolveLaunchBounds, so a
  // partially damaged file can still contribute whatever part is valid.
  load() {
    try {
      if (fs.statSync(this.file).size > MAX_FILE_BYTES) return null
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null
      return { width: saved.width, height: saved.height, x: saved.x, y: saved.y }
    } catch {
      // A missing or damaged state file is not an error worth reporting.
      return null
    }
  }

  save(bounds) {
    const value = { width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y }
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporary, this.file)
    this.value = value
  }
}

function savedSize(saved) {
  if (!saved || typeof saved !== 'object') return null
  const { width, height } = saved
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return null
  return { width, height }
}

function savedPoint(saved) {
  if (!saved || typeof saved !== 'object') return null
  const { x, y } = saved
  // Absurd coordinates (the -32000 minimized artifact, or a monitor that is
  // gone) are not rejected here: they simply never pass the visibility check.
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null
  return { x, y }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function overlapLength(start, span, areaStart, areaSpan) {
  return Math.min(start + span, areaStart + areaSpan) - Math.max(start, areaStart)
}

// Returns the work area the window is mostly visible on, or null when the
// position must be discarded (monitor disconnected, minimized artifact…).
function visibleWorkArea(point, size, workAreas) {
  let best = null
  let bestArea = 0
  for (const workArea of workAreas) {
    const width = overlapLength(point.x, size.width, workArea.x, workArea.width)
    const height = overlapLength(point.y, size.height, workArea.y, workArea.height)
    const strip = overlapLength(point.y, TITLE_STRIP_HEIGHT, workArea.y, workArea.height)
    if (width < MIN_VISIBLE_WIDTH || height < MIN_VISIBLE_HEIGHT || strip < TITLE_STRIP_HEIGHT / 2) continue
    const area = width * height
    if (area > bestArea) {
      bestArea = area
      best = workArea
    }
  }
  return best
}

function defaultSize(workArea, limits) {
  return {
    width: clamp(Math.min(DEFAULT_WIDTH, Math.round(workArea.width * WORK_AREA_RATIO)), limits.minWidth, workArea.width),
    height: clamp(Math.min(DEFAULT_HEIGHT, Math.round(workArea.height * WORK_AREA_RATIO)), limits.minHeight, workArea.height),
  }
}

/**
 * Decide the bounds the main window is launched with.
 *
 * @param {{ width?: unknown, height?: unknown, x?: unknown, y?: unknown } | null} saved
 *   whatever WindowStateStore loaded from disk (already tolerant of garbage).
 * @param {{ primaryWorkArea: { x: number, y: number, width: number, height: number }, workAreas: Array<{ x: number, y: number, width: number, height: number }>, minWidth: number, minHeight: number }} options
 * @returns {{ width: number, height: number, x?: number, y?: number }}
 *   x/y are omitted when the window should be centered by the OS.
 */
function resolveLaunchBounds(saved, { primaryWorkArea, workAreas, minWidth, minHeight }) {
  const limits = { minWidth, minHeight }
  const size = savedSize(saved)
  const point = savedPoint(saved)
  // Visibility is judged with the size that will actually be used; when the
  // saved size is damaged, the default size stands in for the check.
  const placement = point ? visibleWorkArea(point, size ?? defaultSize(primaryWorkArea, limits), workAreas) : null
  // The size is clamped against the display the window will actually appear
  // on: a 2560×1400 window survives while the big monitor is attached and
  // falls back to the primary work area once it is gone. The saved size is
  // only kept together with an accepted position — when no display shows the
  // window anymore, issue #19 ① asks for the default size instead of the old
  // dimensions re-centered.
  const target = placement ?? primaryWorkArea
  const bounds = size && placement
    ? { width: clamp(size.width, limits.minWidth, target.width), height: clamp(size.height, limits.minHeight, target.height) }
    : defaultSize(target, limits)
  return placement ? { ...bounds, x: point.x, y: point.y } : bounds
}

// Record the window's normal bounds while it is used and write them once on
// close. Maximized, minimized and full-screen readings are skipped: Windows
// moves minimized windows to x=-32000 and maximized bounds are not the user's
// chosen size, so neither may reach the state file (issue #19 ③).
function trackWindowBounds(window, store) {
  let bounds = null
  const capture = () => {
    if (window.isDestroyed() || window.isMinimized() || window.isMaximized() || window.isFullScreen()) return
    bounds = window.getBounds()
  }
  window.on('resize', capture)
  window.on('move', capture)
  capture()
  window.once('close', () => {
    if (!bounds) return
    try {
      store.save(bounds)
    } catch {
      // A failed state write must never block the window from closing.
    }
  })
}

module.exports = { WindowStateStore, resolveLaunchBounds, trackWindowBounds }
