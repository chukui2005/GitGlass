const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { WindowStateStore, resolveLaunchBounds, trackWindowBounds } = require('../../electron/window-state.cjs')

let directory
afterEach(() => { if (directory) fs.rmSync(directory, { recursive: true, force: true }); directory = null })

function store(fileName = 'window-state.json') {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-window-state-'))
  return new WindowStateStore(path.join(directory, fileName))
}

// 1920×1040 的工作区（1080 屏去掉任务栏）与 1366×728（768 屏去掉任务栏）。
const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 }
const LAPTOP = { x: 0, y: 0, width: 1366, height: 728 }
const LIMITS = { minWidth: 1024, minHeight: 680 }
const primaryOnly = { primaryWorkArea: PRIMARY, workAreas: [PRIMARY], ...LIMITS }

describe('WindowStateStore', () => {
  it('starts empty and survives a missing file', () => {
    expect(store().value).toBeNull()
  })

  it('ignores damaged and non-object files', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-window-state-'))
    const file = path.join(directory, 'window-state.json')
    fs.writeFileSync(file, 'not json')
    expect(new WindowStateStore(file).value).toBeNull()

    fs.writeFileSync(file, '42')
    expect(new WindowStateStore(file).value).toBeNull()

    fs.writeFileSync(file, JSON.stringify([{ width: 1200 }]))
    expect(new WindowStateStore(file).value).toBeNull()
  })

  it('does not read a huge file', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-window-state-'))
    const file = path.join(directory, 'window-state.json')
    fs.writeFileSync(file, 'x'.repeat(128 * 1024))
    expect(new WindowStateStore(file).value).toBeNull()
  })

  it('passes a valid file through for resolveLaunchBounds to judge', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-window-state-'))
    const file = path.join(directory, 'window-state.json')
    fs.writeFileSync(file, JSON.stringify({ width: 1200, height: 800, x: 100, y: 50 }))
    expect(new WindowStateStore(file).value).toEqual({ width: 1200, height: 800, x: 100, y: 50 })
  })

  it('persists across instances with an atomic write', () => {
    const first = store()
    first.save({ width: 1100, height: 700, x: 120, y: 80 })
    expect(fs.existsSync(`${first.file}.tmp`)).toBe(false)
    const reopened = new WindowStateStore(first.file)
    expect(reopened.value).toEqual({ width: 1100, height: 700, x: 120, y: 80 })
  })

  it('creates the directory when it does not exist yet', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-window-state-'))
    const nested = path.join(directory, 'nested', 'window-state.json')
    const created = new WindowStateStore(nested)
    created.save({ width: 1100, height: 700, x: 0, y: 0 })
    expect(JSON.parse(fs.readFileSync(nested, 'utf8'))).toEqual({ width: 1100, height: 700, x: 0, y: 0 })
  })
})

describe('resolveLaunchBounds defaults', () => {
  it('sizes the window to 80% of the work area capped at 1400×940, centered', () => {
    expect(resolveLaunchBounds(null, primaryOnly)).toEqual({ width: 1400, height: 832 })
    expect(resolveLaunchBounds(undefined, primaryOnly)).toEqual({ width: 1400, height: 832 })
    expect(resolveLaunchBounds({}, primaryOnly)).toEqual({ width: 1400, height: 832 })
  })

  it('fits a 1366×768 laptop: never smaller than minWidth/minHeight, never larger than the work area', () => {
    const bounds = resolveLaunchBounds(null, { primaryWorkArea: LAPTOP, workAreas: [LAPTOP], ...LIMITS })
    expect(bounds).toEqual({ width: 1093, height: 680 })
    expect(bounds.width).toBeLessThanOrEqual(LAPTOP.width)
    expect(bounds.height).toBeLessThanOrEqual(LAPTOP.height)
    expect(bounds.width).toBeGreaterThanOrEqual(LIMITS.minWidth)
    expect(bounds.height).toBeGreaterThanOrEqual(LIMITS.minHeight)
  })
})

describe('resolveLaunchBounds with saved state', () => {
  it('keeps bounds that still fit the primary work area', () => {
    const saved = { width: 1200, height: 800, x: 100, y: 50 }
    expect(resolveLaunchBounds(saved, primaryOnly)).toEqual(saved)
  })

  it('clamps an oversized saved window to the work area without moving it', () => {
    expect(resolveLaunchBounds({ width: 2560, height: 1400, x: 0, y: 0 }, primaryOnly))
      .toEqual({ width: 1920, height: 1040, x: 0, y: 0 })
  })

  it('raises an undersized saved window to minWidth/minHeight', () => {
    expect(resolveLaunchBounds({ width: 800, height: 500, x: 10, y: 10 }, primaryOnly))
      .toEqual({ width: 1024, height: 680, x: 10, y: 10 })
  })

  it('keeps a valid position even when the saved size is damaged', () => {
    expect(resolveLaunchBounds({ width: 'oops', height: 800, x: 100, y: 50 }, primaryOnly))
      .toEqual({ width: 1400, height: 832, x: 100, y: 50 })
  })

  it('centers again when the saved monitor is gone', () => {
    expect(resolveLaunchBounds({ width: 1200, height: 800, x: 5000, y: 0 }, primaryOnly))
      .toEqual({ width: 1400, height: 832 })
  })

  it('centers again on the minimized artifact coordinates', () => {
    expect(resolveLaunchBounds({ width: 1200, height: 800, x: -32000, y: -32000 }, primaryOnly))
      .toEqual({ width: 1400, height: 832 })
  })

  it('centers a window that is barely visible on the right edge', () => {
    // 1920 − 1800 = 120px 可见，小于 200px 阈值：不够拖拽标题栏，回居中。
    expect(resolveLaunchBounds({ width: 1400, height: 800, x: 1800, y: 50 }, primaryOnly))
      .toEqual({ width: 1400, height: 832 })
  })

  it('keeps a window that hangs off the right edge but is still usable', () => {
    expect(resolveLaunchBounds({ width: 1400, height: 800, x: 1600, y: 50 }, primaryOnly))
      .toEqual({ width: 1400, height: 800, x: 1600, y: 50 })
  })

  it('centers a window whose title strip is above every screen', () => {
    expect(resolveLaunchBounds({ width: 1200, height: 800, x: 100, y: -400 }, primaryOnly))
      .toEqual({ width: 1400, height: 832 })
  })

  it('sizes against a secondary display and keeps its coordinates', () => {
    const secondary = { x: 1920, y: 0, width: 2560, height: 1440 }
    const options = { primaryWorkArea: PRIMARY, workAreas: [PRIMARY, secondary], ...LIMITS }
    expect(resolveLaunchBounds({ width: 2500, height: 1300, x: 2000, y: 100 }, options))
      .toEqual({ width: 2500, height: 1300, x: 2000, y: 100 })
    expect(resolveLaunchBounds({ width: 3000, height: 1600, x: 2000, y: 100 }, options))
      .toEqual({ width: 2560, height: 1440, x: 2000, y: 100 })
  })
})

describe('trackWindowBounds', () => {
  function fakeWindow(initial) {
    const emitter = new EventEmitter()
    const state = { x: 0, y: 0, width: 1400, height: 832, maximized: false, minimized: false, fullscreen: false, destroyed: false, ...initial }
    const win = Object.assign(emitter, {
      getBounds: () => ({ x: state.x, y: state.y, width: state.width, height: state.height }),
      isMaximized: () => state.maximized,
      isMinimized: () => state.minimized,
      isFullScreen: () => state.fullscreen,
      isDestroyed: () => state.destroyed,
    })
    return { win, state }
  }

  function recordingStore(records) {
    return { save: (bounds) => { records.push(bounds) } }
  }

  it('writes the initial bounds on close when nothing changed', () => {
    const records = []
    const { win } = fakeWindow({ x: 10, y: 20 })
    trackWindowBounds(win, recordingStore(records))
    win.emit('close')
    expect(records).toEqual([{ x: 10, y: 20, width: 1400, height: 832 }])
  })

  it('follows move and resize events and writes the latest bounds', () => {
    const records = []
    const { win, state } = fakeWindow()
    trackWindowBounds(win, recordingStore(records))
    Object.assign(state, { x: 100, y: 60, width: 1100, height: 700 })
    win.emit('move')
    win.emit('resize')
    win.emit('close')
    expect(records).toEqual([{ x: 100, y: 60, width: 1100, height: 700 }])
  })

  it('reads the bounds once more at close time, so a late OS confirmation cannot leave stale values', () => {
    const records = []
    const { win, state } = fakeWindow()
    trackWindowBounds(win, recordingStore(records))
    // 不发事件、直接改 bounds：模拟 move/resize 尚未派发完就关窗的竞态。
    Object.assign(state, { x: 120, y: 80, width: 1100, height: 700 })
    win.emit('close')
    expect(records).toEqual([{ x: 120, y: 80, width: 1100, height: 700 }])
  })

  it('skips maximized readings and keeps the restored normal bounds', () => {
    const records = []
    const { win, state } = fakeWindow({ x: 10, y: 20, width: 1200, height: 800 })
    trackWindowBounds(win, recordingStore(records))
    Object.assign(state, { maximized: true, x: 0, y: 0, width: 1920, height: 1040 })
    win.emit('resize')
    win.emit('move')
    Object.assign(state, { maximized: false, x: 10, y: 20, width: 1200, height: 800 })
    win.emit('resize')
    win.emit('close')
    expect(records).toEqual([{ x: 10, y: 20, width: 1200, height: 800 }])
  })

  it('never records the minimized -32000 coordinates', () => {
    const records = []
    const { win, state } = fakeWindow({ x: 10, y: 10, width: 1200, height: 800 })
    trackWindowBounds(win, recordingStore(records))
    Object.assign(state, { minimized: true, x: -32000, y: -32000 })
    win.emit('move')
    win.emit('resize')
    win.emit('close')
    expect(records).toEqual([{ x: 10, y: 10, width: 1200, height: 800 }])
  })

  it('does not throw when the state file cannot be written on close', () => {
    const { win } = fakeWindow()
    trackWindowBounds(win, { save: () => { throw new Error('EACCES') } })
    expect(() => win.emit('close')).not.toThrow()
  })
})
