const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')

const temporary = process.env.GITGLASS_PANEL_SPLITTER_DIRECTORY || fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-panel-splitter-'))
app.setPath('userData', temporary)
app.disableHardwareAcceleration()
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Every step waits for the UI to reach the expected state; fixed delays are not
// reliable on cold CI runners.
async function waitUntil(check, label, timeout = 20_000) {
  const deadline = Date.now() + timeout
  let last
  for (;;) {
    last = await check()
    if (last) return last
    if (Date.now() >= deadline) throw new Error(`等待超时：${label}；最后观测值=${JSON.stringify(last)}`)
    await pause(25)
  }
}

const clamp = (value, min, max) => Math.round(Math.max(min, Math.min(max, value)))
// Mirrors the production rule: other panel + 440px main + two 1px splitter lines.
const leftLimit = (workspaceWidth, otherWidth) => clamp(workspaceWidth - otherWidth - 440 - 2, 190, 420)
const rightLimit = (workspaceWidth, otherWidth) => clamp(workspaceWidth - otherWidth - 440 - 2, 240, 420)

app.whenReady().then(async () => {
  let window
  try {
    window = new BrowserWindow({
      width: 1440, height: 820, show: true, useContentSize: true, paintWhenInitiallyHidden: true,
      webPreferences: {
        preload: path.join(__dirname, 'panel-splitter-preload.cjs'),
        contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
      },
    })
    const failures = []
    window.webContents.on('console-message', (event) => { if (event.level === 'error') failures.push(event.message) })
    const js = (body) => window.webContents.executeJavaScript(body)
    const width = (side) => js(`document.querySelector('.workspace').style.getPropertyValue('--${side}-panel-width')`)
    const storedWidth = (side) => js(`(() => { try { return JSON.parse(localStorage.getItem('gitglass.panel-widths'))?.${side} ?? null } catch { return null } })()`)
    const workspaceWidth = () => js(`document.querySelector('.workspace').clientWidth`)
    const splitterBox = (side) => js(`(() => {
      const splitter = document.querySelector('.panel-splitter-${side}')
      const rect = splitter.getBoundingClientRect()
      const before = getComputedStyle(splitter, '::before')
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, beforeLeft: before.left, beforeRight: before.right }
    })()`)
    const key = (side, name) => js(`document.querySelector('.panel-splitter-${side}').dispatchEvent(new KeyboardEvent('keydown', { key: '${name}', bubbles: true }))`)

    await window.loadFile(path.join(__dirname, '../../dist/index.html'))
    await waitUntil(() => js(`Boolean(document.querySelector('.panel-splitter-left') && document.querySelector('.panel-splitter-right'))`), '工作区分割条渲染')
    const viewport = await workspaceWidth()
    const leftMaximum = leftLimit(viewport, 296)
    // A narrow window clamps the defaults on mount, so derive the expected start.
    const initialLeft = Math.min(224, leftMaximum)
    const initialRight = Math.min(296, rightLimit(viewport, initialLeft))
    const resetLeft = Math.min(224, leftMaximum)

    // 1. 常态：1px 细线；命中区向主内容一侧扩展 8px（共 9px），不覆盖侧栏滚动条。
    const initial = await splitterBox('left')
    assert.equal(Math.round(initial.width), 1, '分割条本身应为 1px')
    assert.ok(parseFloat(initial.beforeLeft) >= 0, `左侧分割条不应向侧栏扩展，实际 ${initial.beforeLeft}`)
    assert.ok(parseFloat(initial.beforeRight) <= -8, `左侧分割条应向主内容扩展 8px，实际 ${initial.beforeRight}`)
    const hitArea = await js(`(() => {
      const splitter = document.querySelector('.panel-splitter-left')
      const rect = splitter.getBoundingClientRect()
      const y = rect.top + rect.height / 2
      const offsets = []
      for (let dx = -14; dx <= 14; dx += 1) {
        if (document.elementFromPoint(rect.left + dx, y)?.closest?.('.panel-splitter') === splitter) offsets.push(dx)
      }
      return { min: Math.min(...offsets), max: Math.max(...offsets), count: offsets.length }
    })()`)
    assert.ok(hitArea.count >= 9, `命中区至少 9px，实际 ${hitArea.count}px`)
    assert.equal(hitArea.min, 0, '左侧命中区不应覆盖侧栏滚动条')
    assert.ok(hitArea.max >= 8, '左侧命中区应向主内容延伸 8px')
    const rightInitial = await splitterBox('right')
    assert.equal(Math.round(rightInitial.width), 1, '右侧分割条本身应为 1px')
    assert.ok(parseFloat(rightInitial.beforeLeft) <= -8, `右侧分割条应向主内容扩展 8px，实际 ${rightInitial.beforeLeft}`)
    assert.ok(parseFloat(rightInitial.beforeRight) >= 0, `右侧分割条不应向右侧面板扩展，实际 ${rightInitial.beforeRight}`)
    const rightHit = await js(`(() => {
      const splitter = document.querySelector('.panel-splitter-right')
      const rect = splitter.getBoundingClientRect()
      const y = rect.top + rect.height / 2
      const offsets = []
      for (let dx = -14; dx <= 14; dx += 1) {
        if (document.elementFromPoint(rect.left + dx, y)?.closest?.('.panel-splitter') === splitter) offsets.push(dx)
      }
      return { min: Math.min(...offsets), max: Math.max(...offsets), count: offsets.length }
    })()`)
    assert.ok(rightHit.count >= 9, `右侧命中区至少 9px，实际 ${rightHit.count}px`)
    assert.equal(rightHit.max, 0, '右侧命中区不应覆盖右侧面板')
    assert.ok(rightHit.min <= -8, '右侧命中区应向主内容延伸 8px')
    assert.equal(await width('left'), `${initialLeft}px`)
    assert.equal(await width('right'), `${initialRight}px`)
    const aria = await js(`(() => {
      const splitter = document.querySelector('.panel-splitter-left')
      return { role: splitter.getAttribute('role'), orientation: splitter.getAttribute('aria-orientation'), now: splitter.getAttribute('aria-valuenow'), min: splitter.getAttribute('aria-valuemin'), max: splitter.getAttribute('aria-valuemax') }
    })()`)
    assert.deepEqual(aria, { role: 'separator', orientation: 'vertical', now: String(initialLeft), min: '190', max: String(leftMaximum) })

    // 1b. 左栏滚动条不能被命中区覆盖：可点、可滚轮、不会误触面板拖拽。
    const scrollbar = await js(`(() => {
      const panel = document.querySelector('.status-panel')
      const rect = panel.getBoundingClientRect()
      const scrollbarWidth = panel.offsetWidth - panel.clientWidth
      const splitter = document.querySelector('.panel-splitter-left')
      const y = rect.top + rect.height / 2
      const isSplitter = (x) => document.elementFromPoint(x, y)?.closest?.('.panel-splitter') === splitter
      return { scrollbarWidth, scrollable: panel.scrollHeight > panel.clientHeight, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height, y, atCenter: isSplitter(rect.right - scrollbarWidth / 2), atEdge: isSplitter(rect.right - 1) }
    })()`)
    assert.ok(scrollbar.scrollable, '左栏应出现纵向滚动条')
    assert.ok(scrollbar.scrollbarWidth > 0, '应测得滚动条宽度')
    assert.equal(scrollbar.atCenter, false, '滚动条中段不能被分割条命中区覆盖')
    assert.equal(scrollbar.atEdge, false, '滚动条最右侧也不能被分割条命中区覆盖')
    const scrollbarX = Math.round(scrollbar.right - scrollbar.scrollbarWidth / 2)
    const scrollbarY = Math.round(scrollbar.y)
    const contentX = Math.round(scrollbar.left + 80)
    // Chromium 只在获得焦点的可见窗口里处理原生滚动与滚轮，所以这一段临时显示窗口。
    window.show()
    window.focus()
    try {
      await waitUntil(() => js(`document.hasFocus()`), '探针窗口获得焦点')
      await pause(400)
      // 滚轮在侧栏内容上有效，命中区没有伸进侧栏。
      await js(`document.querySelector('.status-panel').scrollTop = 0`)
      window.webContents.sendInputEvent({ type: 'mouseMove', x: contentX, y: scrollbarY })
      window.webContents.sendInputEvent({ type: 'mouseWheel', x: contentX, y: scrollbarY, deltaY: -120, wheelTicksY: -1, canScroll: true })
      await waitUntil(() => js(`document.querySelector('.status-panel').scrollTop > 0`), '滚轮在侧栏内容上有效')
      // 紧邻滚动条的内容区也不能被分割条命中区拦截。
      assert.equal(await js(`document.elementFromPoint(${Math.round(scrollbar.right - scrollbar.scrollbarWidth - 4)}, ${scrollbarY})?.closest?.('.panel-splitter') === null`), true, '滚动条左侧的内容区不应命中分割条')
      // 点击滚动条轨道可以翻页：点滑块下方的轨道，避免点在滑块上。
      await js(`document.querySelector('.status-panel').scrollTop = 0`)
      const trackY = Math.round(scrollbar.bottom - 24)
      window.webContents.sendInputEvent({ type: 'mouseMove', x: scrollbarX, y: trackY })
      window.webContents.sendInputEvent({ type: 'mouseDown', x: scrollbarX, y: trackY, button: 'left', clickCount: 1 })
      window.webContents.sendInputEvent({ type: 'mouseUp', x: scrollbarX, y: trackY, button: 'left', clickCount: 1 })
      await waitUntil(() => js(`document.querySelector('.status-panel').scrollTop > 0`), '点击滚动条轨道可以翻页')
      // 拖动滚动条滑块：先断言滑块位置命中侧栏（不是分割条），再拖一次。
      // 原生滚动条拖拽依赖真实桌面输入，无头 CI 可能无法合成；本地必须真的滚动。
      await js(`document.querySelector('.status-panel').scrollTop = 0`)
      const thumbY = Math.round(scrollbar.top + 40)
      assert.equal(await js(`document.elementFromPoint(${scrollbarX}, ${thumbY})?.closest?.('.panel-splitter') === null`), true, '滚动条滑块不应被分割条命中区覆盖')
      window.webContents.sendInputEvent({ type: 'mouseMove', x: scrollbarX, y: thumbY })
      window.webContents.sendInputEvent({ type: 'mouseDown', x: scrollbarX, y: thumbY, button: 'left', clickCount: 1 })
      window.webContents.sendInputEvent({ type: 'mouseMove', x: scrollbarX, y: thumbY + 80 })
      window.webContents.sendInputEvent({ type: 'mouseUp', x: scrollbarX, y: thumbY + 80, button: 'left', clickCount: 1 })
      let draggedScrollTop = 0
      const dragDeadline = Date.now() + 2_000
      while (Date.now() < dragDeadline) {
        draggedScrollTop = await js(`document.querySelector('.status-panel').scrollTop`)
        if (draggedScrollTop > 0) break
        await pause(50)
      }
      assert.equal(await js(`document.body.classList.contains('is-resizing-panels')`), false, '拖动滚动条不应启动面板拖拽')
      if (!process.env.CI) {
        assert.ok(draggedScrollTop > 0, `本地应能拖动滚动条，实际 scrollTop=${draggedScrollTop}`)
      }
      await js(`document.querySelector('.status-panel').scrollTop = 0`)
    } finally {
      // 后续步骤（窗口缩放、分割条拖拽）在可见窗口里同样成立，保持显示即可。
      window.showInactive()
    }

    // 2. 拖拽：pointerdown + pointermove 用 rAF 节流写宽度，拖拽期间挂 is-resizing-panels。
    const dragDelta = initialLeft < leftMaximum ? Math.min(40, leftMaximum - initialLeft) : -Math.min(40, initialLeft - 190)
    const dragStart = await splitterBox('left')
    const startX = Math.round(dragStart.x + 0.5)
    const startY = Math.round(dragStart.y + dragStart.height / 2)
    window.webContents.sendInputEvent({ type: 'mouseMove', x: startX, y: startY })
    window.webContents.sendInputEvent({ type: 'mouseDown', x: startX, y: startY, button: 'left', clickCount: 1 })
    await waitUntil(() => js(`document.body.classList.contains('is-resizing-panels')`), '拖拽开始并挂上 is-resizing-panels')
    for (const offset of [Math.round(dragDelta / 3), Math.round((dragDelta * 2) / 3), dragDelta]) {
      window.webContents.sendInputEvent({ type: 'mouseMove', x: startX + offset, y: startY })
    }
    // 合成拖拽在离屏 CI 上不保证精确像素；这里只断言「朝拖拽方向变化且被夹紧」，
    // 精确宽度由 tests/unit/panel-resize.test.mjs 与键盘步进覆盖。
    const draggedWidth = await waitUntil(async () => {
      const value = parseFloat(await width('left'))
      if (!Number.isFinite(value)) return null
      return dragDelta > 0 ? (value > initialLeft ? value : null) : value < initialLeft ? value : null
    }, '拖拽后左侧面板宽度发生变化')
    assert.ok(draggedWidth >= 190 && draggedWidth <= 420, `拖拽后宽度应保持夹紧，实际 ${draggedWidth}`)
    assert.equal(await js(`Boolean(document.querySelector('.panel-resize-overlay'))`), true, '拖拽期间应有全屏 overlay')
    assert.equal(await js(`getComputedStyle(document.body).cursor`), 'col-resize')
    await waitUntil(async () => (await storedWidth('left')) === draggedWidth, '拖拽后的宽度写入 localStorage')
    window.webContents.sendInputEvent({ type: 'mouseUp', x: startX + dragDelta, y: startY, button: 'left', clickCount: 1 })
    await waitUntil(() => js(`!document.body.classList.contains('is-resizing-panels')`), '拖拽结束并移除 is-resizing-panels')
    assert.equal(await js(`Boolean(document.querySelector('.panel-resize-overlay'))`), false, '拖拽结束后 overlay 应移除')

    // 3. 双击重置为默认宽度（左 224 / 右 296；窄窗口按布局上限夹紧）。
    await js(`document.querySelector('.panel-splitter-left').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
    await waitUntil(async () => (await width('left')) === `${resetLeft}px`, `双击左侧分割条重置为 ${resetLeft}px`)
    await waitUntil(async () => (await storedWidth('left')) === resetLeft, '重置后的宽度写入 localStorage')

    // 4. 键盘：←/→ 每次 8px，Home/End 到最小/最大。
    await js(`document.querySelector('.panel-splitter-left').focus()`)
    await key('left', 'ArrowLeft')
    await waitUntil(async () => (await width('left')) === `${Math.max(190, resetLeft - 8)}px`, '← 键把左侧面板收窄 8px')
    await key('left', 'ArrowRight')
    await waitUntil(async () => (await width('left')) === `${resetLeft}px`, '→ 键把左侧面板加宽 8px')
    await key('left', 'End')
    await waitUntil(async () => (await width('left')) === `${leftMaximum}px`, 'End 键到达当前布局上限')
    await key('left', 'Home')
    await waitUntil(async () => (await width('left')) === '190px', 'Home 键到达最小宽度')
    await key('left', 'Enter')
    await waitUntil(async () => (await width('left')) === `${resetLeft}px`, 'Enter 键重置为默认宽度')
    assert.equal(await js(`document.querySelector('.panel-splitter-left').getAttribute('aria-valuenow')`), `${resetLeft}`, 'aria-valuenow 应随宽度更新')

    // 4b. Tab 能自然聚焦到分割条（侧栏最后一个可聚焦元素之后）。
    const tabStart = await js(`(() => {
      const panel = document.querySelector('.status-panel')
      const focusable = [...panel.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((element) => !element.disabled && element.getClientRects().length > 0)
      const last = focusable.at(-1)
      last?.focus()
      return { found: Boolean(last), active: document.activeElement === last }
    })()`)
    assert.equal(tabStart.found, true, '侧栏应存在可聚焦元素')
    assert.equal(tabStart.active, true, '应能把焦点放到侧栏最后一个可聚焦元素')
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
    await waitUntil(() => js(`document.activeElement === document.querySelector('.panel-splitter-left')`), 'Tab 能聚焦到左侧分割条')

    // 5. 持久化：写入的值在重新加载后恢复；脏数据回退默认值。
    const saved = { left: Math.min(260, leftMaximum), right: Math.min(250, rightLimit(viewport, Math.min(260, leftMaximum))) }
    await js(`localStorage.setItem('gitglass.panel-widths', JSON.stringify(${JSON.stringify(saved)}))`)
    window.webContents.reload()
    await waitUntil(() => js(`Boolean(document.querySelector('.panel-splitter-left'))`), '重新加载后工作区渲染')
    await waitUntil(async () => (await width('left')) === `${saved.left}px` && (await width('right')) === `${saved.right}px`, '重新加载后恢复持久化宽度')

    await js(`localStorage.setItem('gitglass.panel-widths', 'not json')`)
    window.webContents.reload()
    await waitUntil(() => js(`Boolean(document.querySelector('.panel-splitter-left'))`), '脏数据重新加载后工作区渲染')
    await waitUntil(async () => (await width('left')) === `${initialLeft}px` && (await width('right')) === `${initialRight}px`, '脏数据回退默认宽度')

    // 6. 1440 → 1024：先推到两侧上限，再验证缩窄后自动夹紧、中间仍 ≥440px。
    await js(`document.querySelector('.panel-splitter-left').focus()`)
    await key('left', 'End')
    await waitUntil(async () => (await width('left')) === `${leftMaximum}px`, 'End 把左栏推到当前上限')
    await key('right', 'End')
    await waitUntil(async () => (await width('right')) === `${rightLimit(viewport, leftMaximum)}px`, 'End 把右栏推到当前上限')
    const wideLeft = parseFloat(await width('left'))
    const wideRight = parseFloat(await width('right'))
    if (viewport > 1024) {
      window.setContentSize(1024, 820)
      // 有些无头环境会忽略缩小请求；最多等 3 秒，随后按实际视口验证夹紧结果。
      const resizeDeadline = Date.now() + 3_000
      while (Date.now() < resizeDeadline && (await workspaceWidth()) > 1024) await pause(50)
    }
    const narrowedWidth = await workspaceWidth()
    const expectedLeft = Math.min(wideLeft, leftLimit(narrowedWidth, wideRight))
    const expectedRight = Math.min(wideRight, rightLimit(narrowedWidth, expectedLeft))
    await waitUntil(async () => (await width('left')) === `${expectedLeft}px` && (await width('right')) === `${expectedRight}px`, '缩窄后两侧按布局上限自动夹紧')
    const narrowed = await js(`(() => ({
      left: document.querySelector('.workspace').style.getPropertyValue('--left-panel-width'),
      right: document.querySelector('.workspace').style.getPropertyValue('--right-panel-width'),
      main: document.querySelector('.main-panel').getBoundingClientRect().width,
      workspace: document.querySelector('.workspace').clientWidth,
    }))()`)
    assert.equal(narrowed.left, `${expectedLeft}px`, '缩窄后左侧面板应按布局上限夹紧')
    assert.equal(narrowed.right, `${expectedRight}px`, '缩窄后右侧面板应按布局上限夹紧')
    // 窗口低于 190+240+440+2=872px 时三栏最小宽度本身放不下（真实应用 minWidth 为 1024）。
    if (narrowed.workspace >= 872) {
      assert.ok(narrowed.main >= 439.5, `中间栏至少 440px，实际 ${narrowed.main}（视口 ${narrowed.workspace}）`)
    }

    assert.equal(failures.length, 0, failures.join('\n'))
    console.log('[PANEL-SPLITTER] ' + JSON.stringify({ line: initial.width, hitArea: 9, drag: draggedWidth, reset: resetLeft, keyboard: [resetLeft - 8, 190, leftMaximum], persisted: saved, viewport }))
    app.exit(0)
  } catch (error) {
    console.error('[PANEL-SPLITTER-ERROR] ' + error.stack)
    app.exit(1)
  } finally {
    window?.destroy()
  }
}).finally(() => { try { fs.rmSync(temporary, { recursive: true, force: true }) } catch {} })
