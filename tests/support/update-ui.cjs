const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')

const temporary = process.env.GITGLASS_UPDATE_TEST_DIRECTORY || fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-update-ui-'))
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

app.whenReady().then(async () => {
  let window
  try {
    window = new BrowserWindow({ width: 1024, height: 780, show: false, useContentSize: true,
      webPreferences: { preload: path.join(__dirname, 'update-ui-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true } })
    const failures = []
    window.webContents.on('console-message', (event) => { if (event.level === 'error') failures.push(event.message) })
    const js = (body) => window.webContents.executeJavaScript(body)
    await window.loadFile(path.join(__dirname, '../../dist/index.html'))
    const restored = await waitUntil(async () => {
      const snapshot = await js(`({ draft: document.querySelector('#commit-message')?.value, ...window.gitglassUpdateTest.result(), overflow: document.documentElement.scrollWidth > innerWidth })`)
      return snapshot.draft && snapshot.consumed ? snapshot : null
    }, '重启草稿回填完成')
    assert.equal(restored.draft, '更新前尚未提交的说明')
    assert.equal(restored.consumed, true)
    assert.equal(restored.overflow, false)
    assert.equal(await js(`Boolean(document.querySelector('.update-dot'))`), false)
    await js(`document.querySelector('[aria-label="软件更新"]').click()`)
    await waitUntil(() => js(`Boolean(document.querySelector('dialog')?.matches(':modal'))`), '更新面板以模态方式打开')
    await js(`window.gitglassUpdateTest.publish({ phase: 'downloading', progress: 42, latestVersion: '0.5.7-beta.1' })`)
    await waitUntil(() => js(`document.querySelector('progress')?.value === 42`), '下载进度渲染为 42')
    assert.equal(await js(`Boolean(document.querySelector('.update-dot'))`), false)
    await js(`document.querySelector('[aria-label="关闭软件更新"]').click()`)
    await waitUntil(() => js(`Boolean(document.querySelector('dialog')) === false`), '更新面板关闭')
    await js(`window.gitglassUpdateTest.publish({ phase: 'ready', notes: '<p>改进更新体验</p>', progress: 100 })`)
    await waitUntil(() => js(`Boolean(document.querySelector('.update-dot'))`), '更新就绪红点出现')
    await js(`document.querySelector('[aria-label="更新已就绪"]').click()`)
    await waitUntil(async () => (await js(`document.querySelector('.update-notes pre')?.textContent`)) === '改进更新体验', '更新说明以纯文本渲染')
    const output = process.env.GITGLASS_UPDATE_SCREENSHOT
    if (output) {
      window.webContents.invalidate()
      await pause(250)
      fs.mkdirSync(path.dirname(output), { recursive: true })
      fs.writeFileSync(output, (await window.webContents.capturePage()).toPNG())
    }
    await js(`document.querySelector('dialog').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))`)
    assert.equal((await js(`window.gitglassUpdateTest.result()`)).operations, 0)
    await js(`Array.from(document.querySelectorAll('dialog button')).find(button => button.textContent === '重启并更新').click()`)
    const result = await waitUntil(async () => {
      const current = await js(`window.gitglassUpdateTest.result()`)
      return current.installedSession ? current : null
    }, '重启并更新提交安装会话')
    assert.deepEqual(result.installedSession, { commitMessage: '更新前尚未提交的说明', historyMode: false })
    const alertText = await waitUntil(() => js(`document.querySelector('dialog [role="alert"]')?.textContent`), '安装失败提示渲染')
    assert.equal(alertText, '测试安装器启动失败，可以重试。')
    assert.equal(await js(`Array.from(document.querySelectorAll('dialog button')).find(button => button.textContent === '重启并更新').disabled`), false)
    assert.equal(failures.length, 0, failures.join('\n'))
    console.log('[UPDATE-UI] ' + JSON.stringify({ restored: true, progress: true, modal: true, failedInstallRetry: true, width: 1024 }))
    app.exit(0)
  } catch (error) {
    console.error('[UPDATE-UI-ERROR] ' + error.stack)
    app.exit(1)
  } finally {
    window?.destroy()
  }
}).finally(() => { try { fs.rmSync(temporary, { recursive: true, force: true }) } catch {} })
