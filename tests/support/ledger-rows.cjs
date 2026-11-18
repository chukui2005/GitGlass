const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-ledger-rows-'))
app.setPath('userData', temporary)
app.disableHardwareAcceleration()
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// CI 冷启动比本地慢：每一步都轮询到目标状态，不用固定 sleep。
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

async function openWindow(mode) {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    useContentSize: true,
    webPreferences: {
      preload: path.join(__dirname, 'ledger-rows-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      offscreen: true,
      additionalArguments: [`--ledger-rows-probe=${mode}`],
    },
  })
  await window.loadFile(path.join(__dirname, '../../dist/index.html'))
  return window
}

app.whenReady().then(async () => {
  const windows = []
  try {
    // ---------- 场景一：有仓库的工作区 ----------
    const repoWindow = await openWindow('repo')
    windows.push(repoWindow)
    const js = (body) => repoWindow.webContents.executeJavaScript(body)

    await waitUntil(() => js(`Boolean(document.querySelector('.top-actions'))`), '顶栏渲染')

    // 顶栏：两个次按钮 + 四个低权重工具条，且没有任何实心主按钮。
    const topbar = await js(`(() => {
      const actions = document.querySelector('.top-actions')
      const buttons = [...actions.querySelectorAll('button')]
      return {
        toolbar: buttons.filter((button) => button.classList.contains('toolbar-button')).length,
        secondary: buttons.filter((button) => button.classList.contains('secondary-button')).length,
        icons: buttons.filter((button) => button.classList.contains('icon-button')).length,
        primary: buttons.filter((button) => button.classList.contains('primary-button') || button.classList.contains('primary-action')).length,
        heights: buttons.map((button) => Math.round(button.getBoundingClientRect().height)),
        labels: buttons.map((button) => button.getAttribute('aria-label')),
      }
    })()`)
    assert.equal(topbar.toolbar, 4, `顶栏应有 4 个图标 + 小字工具条：${JSON.stringify(topbar.labels)}`)
    assert.equal(topbar.secondary, 2, `顶栏应有「打开仓库」「获取…」两个次按钮：${JSON.stringify(topbar.labels)}`)
    // 没有可用更新时「更新」是 30×30 的纯图标按钮（检查更新），不占文字宽度。
    assert.equal(topbar.icons, 1, `顶栏应有一颗纯图标按钮（检查更新）：${JSON.stringify(topbar.labels)}`)
    assert.equal(topbar.primary, 0, '没有可用更新时顶栏不允许出现实心主按钮')
    assert.ok(
      topbar.heights.every((height) => height === 30),
      `顶栏按钮高度应统一为 dbx 的 30px：${JSON.stringify(topbar.heights)}`,
    )

    // 工作区 + 文件详情里的主动作：页面同一时刻最多一个"可点"的主按钮。
    const primeButton = await js(`(() => {
      const all = [...document.querySelectorAll('.primary-button, .primary-action')]
      return { total: all.length, enabled: all.filter((button) => !button.disabled).length }
    })()`)
    assert.ok(primeButton.enabled <= 1, `默认工作区最多一个可点的主按钮，实际 ${primeButton.enabled} 个（共 ${primeButton.total} 个）`)

    // 展开命令账本。
    await js(`document.querySelector('.ledger-title').click()`)
    await waitUntil(() => js(`document.querySelectorAll('.ledger-entry').length > 0`), '账本展开并渲染记录')

    // 切到「全部」，让用户操作与系统读取同时出现。
    await js(`(() => {
      const all = [...document.querySelectorAll('.ledger-filter button')].find((button) => button.textContent.trim().startsWith('全部'))
      all.click()
    })()`)
    // 同一轮刷新的系统读取会折叠成一个分组；展开它才能看到每条记录的两行结构。
    await waitUntil(() => js(`Boolean(document.querySelector('.ledger-refresh-summary'))`), '后台读取按刷新轮次分组')
    await js(`document.querySelector('.ledger-refresh-summary').click()`)
    await waitUntil(() => js(`document.querySelectorAll('.ledger-entry').length === 3`), '账本显示三条记录')

    const rows = await js(`(() => {
      const entries = [...document.querySelectorAll('.ledger-entry')]
      return entries.map((entry) => {
        const button = entry.querySelector('.ledger-summary')
        const main = button.querySelector('.ledger-entry-main')
        const primaryLine = main ? main.querySelector(':scope > .ledger-entry-line') : null
        const metaLine = main ? main.querySelector(':scope > .ledger-entry-meta') : null
        const command = entry.querySelector('.ledger-command')
        const intent = entry.querySelector('.ledger-intent')
        return {
          hasMain: Boolean(main),
          lineCount: main ? main.children.length : 0,
          primaryText: primaryLine ? primaryLine.textContent : '',
          metaText: metaLine ? metaLine.textContent : '',
          metaHasExitCode: metaLine ? metaLine.textContent.includes('退出码') : false,
          metaHasSource: metaLine ? /用户执行|系统读取/.test(metaLine.textContent) : false,
          metaHasTime: Boolean(metaLine && metaLine.querySelector('time')),
          intentFont: intent ? getComputedStyle(intent).fontSize : '',
          commandFont: command ? getComputedStyle(command).fontSize : '',
          metaFont: metaLine ? getComputedStyle(metaLine).fontSize : '',
          commandTitle: command ? command.getAttribute('title') : null,
          commandNowrap: command ? getComputedStyle(command).whiteSpace : '',
          commandOverflow: command ? getComputedStyle(command).textOverflow : '',
          entryOverflowX: entry.scrollWidth - entry.clientWidth,
          expanded: button.getAttribute('aria-expanded'),
        }
      })
    })()`)

    assert.equal(rows.length, 3)
    for (const row of rows) {
      assert.equal(row.hasMain, true, '每条记录必须有 .ledger-entry-main 容器')
      assert.equal(row.lineCount, 2, `每条记录必须是两行，实际 ${row.lineCount} 行`)
      assert.ok(row.intentFont === '13px', `意图是正文 13px，实际 ${row.intentFont}`)
      assert.ok(row.commandFont === '12px', `命令是等宽 12px，实际 ${row.commandFont}`)
      assert.ok(row.metaFont === '11px', `元信息是辅助 11px，实际 ${row.metaFont}`)
      assert.equal(row.metaHasExitCode, true, `第二行必须包含退出码：${row.metaText}`)
      assert.equal(row.metaHasSource, true, `第二行必须包含来源：${row.metaText}`)
      assert.equal(row.metaHasTime, true, `第二行必须包含时间：${row.metaText}`)
      assert.equal(row.commandNowrap, 'nowrap', '命令必须单行显示')
      assert.equal(row.commandOverflow, 'ellipsis', '命令必须用省略号截断')
      assert.ok(row.commandTitle && row.commandTitle.length > 0, '命令必须有 title 提供全文')
      assert.ok(row.entryOverflowX <= 0, `账本行不允许横向溢出，实际超出 ${row.entryOverflowX}px`)
    }
    // 记录展开后第一行同时有意图和命令。
    assert.match(rows[0].primaryText, /暂存文件/)
    assert.match(rows[0].primaryText, /git add -- src\/main\.jsx/)
    assert.equal(rows[2].expanded, 'false', '系统读取默认收起，但两行摘要仍完整')

    // 整页不允许横向滚动条。
    const overflow = await js(`document.documentElement.scrollWidth - document.documentElement.clientWidth`)
    assert.ok(overflow <= 1, `页面不允许横向溢出，实际 ${overflow}px`)

    // ---------- 场景二：没有仓库的空状态 ----------
    const emptyWindow = await openWindow('empty')
    windows.push(emptyWindow)
    const emptyJs = (body) => emptyWindow.webContents.executeJavaScript(body)

    const empty = await waitUntil(
      async () => {
        const snapshot = await emptyJs(`(() => {
          const empty = document.querySelector('.empty-repo')
          if (!empty) return null
          const button = empty.querySelector('.primary-button')
          const allPrimaries = [...document.querySelectorAll('.primary-button, .primary-action')]
          return {
            hasButton: Boolean(button),
            text: button ? button.textContent.trim() : '',
            height: button ? Math.round(button.getBoundingClientRect().height) : 0,
            primaries: allPrimaries.length,
            enabledPrimaries: allPrimaries.filter((entry) => !entry.disabled).length,
            enabledText: allPrimaries.filter((entry) => !entry.disabled).map((entry) => entry.textContent.trim()).join('|'),
            topbarPrimaries: document.querySelectorAll('.top-actions .primary-button, .top-actions .primary-action').length,
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            topbarToolbar: document.querySelectorAll('.top-actions .toolbar-button').length,
          }
        })()`)
        return snapshot && snapshot.hasButton ? snapshot : null
      },
      '空状态渲染「打开仓库」主按钮',
    )
    assert.equal(empty.text, '打开仓库')
    assert.ok(empty.height >= 30, `主按钮高度应为 32px，实际 ${empty.height}`)
    assert.equal(empty.enabledPrimaries, 1, `空状态只能有一个可点的主按钮，实际 ${empty.enabledPrimaries} 个：${empty.enabledText}`)
    assert.equal(empty.enabledText, '打开仓库', '空状态唯一的主动作必须是「打开仓库」')
    assert.equal(empty.topbarPrimaries, 0, '顶栏不放主按钮')
    assert.equal(empty.topbarToolbar, 4, '空状态顶栏同样保留 4 个低权重工具条')
    assert.ok(empty.overflow <= 1, `空状态不允许横向溢出，实际 ${empty.overflow}px`)

    // 密度（对齐 dbx）：列表行 26px、分组标题 28px、账本单行 32px、Diff 行 20–21px。
    const density = await js(`(() => {
      const height = (selector) => {
        const element = document.querySelector(selector)
        return element ? Math.round(element.getBoundingClientRect().height) : null
      }
      const sidebar = document.querySelector('.status-panel')
      return {
        fileRow: height('.file-row'),
        branchRow: height('.branch-row'),
        sectionLabel: height('.status-panel .section-label'),
        ledgerRow: height('.ledger-summary'),
        diffLine: height('.diff-line:not(.file):not(.file-path):not(.metadata):not(.hunk)'),
        sidebarOverflowX: sidebar ? sidebar.scrollWidth - sidebar.clientWidth : null,
      }
    })()`)

    console.log('[LEDGER-ROWS] ' + JSON.stringify({
      topbar: { toolbar: topbar.toolbar, secondary: topbar.secondary, icons: topbar.icons, primary: topbar.primary },
      rows: rows.map((row) => ({ intentFont: row.intentFont, commandFont: row.commandFont, metaFont: row.metaFont })),
      emptyPrimary: empty.text,
      density,
    }))
    app.exit(0)
  } catch (error) {
    console.error('[LEDGER-ROWS-ERROR] ' + error.stack)
    app.exit(1)
  } finally {
    for (const window of windows) window?.destroy()
  }
}).finally(() => {
  try {
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {}
})
