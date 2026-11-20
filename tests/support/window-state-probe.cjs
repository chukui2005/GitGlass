// 真启动 electron/main.cjs 的窗口状态探针（tests/ui/window-state.test.cjs 用）。
//
// 先把 userData 指到测试给的临时目录，再 require 真正的 main.cjs，走的是产品建窗
// 路径：resolveLaunchBounds 读 window-state.json、trackWindowBounds 在 close 时落盘。
// 窗口加载的 dist/index.html 不需要存在——窗口边界行为与渲染页无关，所以这个探针
// 不调用 buildApplication。
//
// GITGLASS_PROBE_PHASE=save：等主窗口出现 → 打印首启 bounds → setBounds 到固定矩形 →
//   等 move/resize 事件派发完 → close → 读回 window-state.json → 打印。
// GITGLASS_PROBE_PHASE=restore：等主窗口出现 → 打印实际 bounds（应与上次保存的一致）。
// 阶段一拦截 before-quit：main.cjs 在 window-all-closed 里会 app.quit()，探针必须
// 先读到落盘文件，最后用 app.exit(0) 直接结束。
const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow, screen } = require('electron')

const userData = process.env.GITGLASS_PROBE_USERDATA
const phase = process.env.GITGLASS_PROBE_PHASE === 'restore' ? 'restore' : 'save'

function waitUntil(check, { timeout = 30_000, step = 50, label = '条件' } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const tick = () => {
      let value
      try {
        value = check()
      } catch (error) {
        if (error && error.code === 'ENOENT') value = null
        else {
          reject(error)
          return
        }
      }
      if (value) {
        resolve(value)
        return
      }
      if (Date.now() - startedAt > timeout) {
        reject(new Error(`等待${label}超时`))
        return
      }
      setTimeout(tick, step)
    }
    tick()
  })
}

function onceEvent(emitter, event, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); emitter.off(event, handler) }
    const timer = setTimeout(() => { cleanup(); reject(new Error(`等待 ${event} 事件超时`)) }, timeout)
    const handler = () => { cleanup(); resolve() }
    emitter.once(event, handler)
  })
}

if (!userData) {
  console.error('[WINDOW-STATE-FAILED] 缺少 GITGLASS_PROBE_USERDATA')
  app.exit(1)
} else {
  app.setPath('userData', userData)
  require(path.join(__dirname, '..', '..', 'electron', 'main.cjs'))

  let quitBlocked = false
  app.on('before-quit', (event) => {
    if (quitBlocked) return
    quitBlocked = true
    event.preventDefault()
  })

  app.whenReady().then(async () => {
    try {
      const window = await waitUntil(() => BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed()), { label: '主窗口出现' })
      const workArea = screen.getPrimaryDisplay().workArea
      if (phase === 'restore') {
        const bounds = window.getBounds()
        console.log(`[WINDOW-STATE] ${JSON.stringify({ phase, bounds, workArea })}`)
        app.exit(0)
        return
      }
      const initial = window.getBounds()
      const target = { x: 120, y: 80, width: 1100, height: 700 }
      // 先挂事件监听再 setBounds；Windows 上 move/resize 由系统确认后异步派发，
      // 两个事件都落地才关窗，保证 trackWindowBounds 记下的是新 bounds。
      const settled = Promise.allSettled([onceEvent(window, 'move'), onceEvent(window, 'resize')])
      window.setBounds(target)
      await settled
      window.close()
      const stateFile = path.join(userData, 'window-state.json')
      const saved = await waitUntil(() => JSON.parse(fs.readFileSync(stateFile, 'utf8')), { label: 'window-state.json 落盘' })
      console.log(`[WINDOW-STATE] ${JSON.stringify({ phase, initial, target, saved, workArea })}`)
      app.exit(0)
    } catch (error) {
      console.error(`[WINDOW-STATE-FAILED] ${error && error.message ? error.message : String(error)}`)
      app.exit(1)
    }
  })
}
