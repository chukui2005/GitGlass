const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')

const temporary = process.env.GITGLASS_RECENT_UI_DIRECTORY || fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-recent-ui-'))
app.setPath('userData', temporary)
app.disableHardwareAcceleration()
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// CI runners are slower than a developer machine and the window is offscreen, so
// every step waits for the UI to reach the expected state instead of guessing a delay.
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

const fixtures = [
  { path: 'C:/test/repository', name: 'repository', exists: true },
  { path: 'C:/test/gone', name: 'gone', exists: false },
]

app.whenReady().then(async () => {
  let window
  try {
    window = new BrowserWindow({
      width: 1024, height: 780, show: false, useContentSize: true,
      webPreferences: {
        preload: path.join(__dirname, 'update-ui-preload.cjs'),
        contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true,
        additionalArguments: [`--recent-repositories-probe=${encodeURIComponent(JSON.stringify(fixtures))}`],
      },
    })
    const failures = []
    window.webContents.on('console-message', (event) => { if (event.level === 'error') failures.push(event.message) })
    const js = (body) => window.webContents.executeJavaScript(body)
    await window.loadFile(path.join(__dirname, '../../dist/index.html'))

    await waitUntil(() => js(`Boolean(document.querySelector('[aria-label="最近仓库"]'))`), '最近仓库触发器渲染')
    assert.equal(await js(`document.querySelector('[aria-label="最近仓库"]').getAttribute('aria-expanded')`), 'false')
    // The extra trigger must still fit the 1024px title bar.
    assert.equal(await js(`document.documentElement.scrollWidth > innerWidth`), false)

    // ArrowDown on the trigger opens the menu and focuses the first entry.
    await js(`(() => {
      const trigger = document.querySelector('[aria-label="最近仓库"]')
      trigger.focus()
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })()`)
    const menu = await waitUntil(async () => {
      const snapshot = await js(`(() => {
        const menu = document.querySelector('[role="menu"]')
        if (!menu) return null
        return {
          items: menu.querySelectorAll('[role="menuitem"]').length,
          focusedRole: document.activeElement?.getAttribute('role') || '',
          current: menu.querySelector('[aria-current="true"]')?.textContent || '',
          text: menu.textContent,
          expanded: document.querySelector('[aria-label="最近仓库"]').getAttribute('aria-expanded'),
        }
      })()`)
      return snapshot && snapshot.focusedRole === 'menuitem' ? snapshot : null
    }, '菜单打开并把焦点放到第一项')
    assert.equal(menu.items, 2, '菜单应渲染出两条最近仓库')
    assert.equal(menu.expanded, 'true')
    assert.match(menu.current, /repository/)
    assert.match(menu.text, /路径不存在/)

    // ArrowDown moves the highlight and Home returns to the first entry.
    await js(`document.querySelector('[role="menu"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`)
    await waitUntil(() => js(`document.activeElement?.textContent?.includes('gone') === true`), '方向键移动到第二项')
    await js(`document.querySelector('[role="menu"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))`)
    await waitUntil(() => js(`document.activeElement?.textContent?.includes('repository') === true`), 'Home 跳回第一项')

    // Removing the missing entry keeps the menu open with the remaining one.
    await js(`document.querySelector('[aria-label="从最近仓库移除 gone"]').click()`)
    await waitUntil(() => js(`document.querySelectorAll('[role="menuitem"]').length === 1`), '移除失效路径后只剩一条')

    // Escape closes the menu and returns focus to the trigger.
    await js(`document.querySelector('[role="menu"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await waitUntil(() => js(`!document.querySelector('[role="menu"]') && document.activeElement === document.querySelector('[aria-label="最近仓库"]')`), 'Esc 关闭菜单并归还焦点')

    // Choosing an entry calls the openRepository IPC with the remembered path.
    await js(`document.querySelector('[aria-label="最近仓库"]').click()`)
    await waitUntil(() => js(`Boolean(document.querySelector('[role="menuitem"]'))`), '菜单再次打开')
    await js(`document.querySelector('[role="menuitem"]').click()`)
    const opened = await waitUntil(async () => {
      const value = await js(`window.gitglassUpdateTest.result().openedRepository`)
      return value || null
    }, '选中最近仓库调用 openRepository')
    assert.equal(opened, 'C:/test/repository')

    assert.equal(failures.length, 0, failures.join('\n'))
    console.log('[RECENT-UI] ' + JSON.stringify({ items: menu.items, keyboard: true, missingRemoved: true, opened }))
    app.exit(0)
  } catch (error) {
    console.error('[RECENT-UI-ERROR] ' + error.stack)
    app.exit(1)
  } finally {
    window?.destroy()
  }
}).finally(() => { try { fs.rmSync(temporary, { recursive: true, force: true }) } catch {} })
