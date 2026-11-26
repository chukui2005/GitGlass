// 克隆的真实窗口验收：真 Electron 窗口 + dist/ + 真实 Git。
//
// 探针在一个临时沙箱里建 bare 远程，让工作台从「没有仓库」开始，用界面本身
// （顶栏「克隆仓库」→ 填地址与目标位置 → 预览克隆 → 开始克隆）完成一次克隆，
// 再用同一个对话框验证带内嵌凭据的地址被拒绝；最后把窗口里读到的事实和磁盘上
// 的事实一起打印成一行 JSON。所有等待都是轮询目标状态，不用固定 sleep。
//
// 以 Electron 主进程方式运行：npx electron tests/support/clone-window.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..', '..')
const MARKER = '[CLONE-WINDOW] '
const TARGET_NAME = 'probe-clone'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-clone-window-'))
app.setPath('userData', path.join(sandbox, 'user-data'))
app.disableHardwareAcceleration()

function finish(exitCode) {
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  try {
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    // A leftover temp folder is not a probe failure.
  }
  app.exit(exitCode)
}

const fail = (error) => {
  console.error('[CLONE-WINDOW-ERROR] ' + (error && error.stack ? error.stack : error))
  finish(1)
}
process.on('uncaughtException', fail)
process.on('unhandledRejection', fail)
const watchdog = setTimeout(() => fail(new Error('克隆验收探针 120 秒未完成')), 120_000)
watchdog.unref?.()

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim()
}

async function main() {
  const seed = path.join(sandbox, 'seed')
  fs.mkdirSync(seed)
  git(seed, ['init', '-b', 'main'])
  git(seed, ['config', 'user.name', 'Clone Window Probe'])
  git(seed, ['config', 'user.email', 'clone-window@test.local'])
  fs.writeFileSync(path.join(seed, 'readme.txt'), 'probe origin\n')
  git(seed, ['add', '-A'])
  git(seed, ['commit', '-m', 'chore: probe origin'])
  const head = git(seed, ['rev-parse', 'HEAD'])
  const origin = path.join(sandbox, 'origin.git')
  git(sandbox, ['clone', '--bare', seed, origin])
  const parent = path.join(sandbox, 'targets')
  fs.mkdirSync(parent)

  const win = new BrowserWindow({
    width: 1200,
    height: 840,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'clone-window-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  await win.loadFile(path.join(ROOT, 'dist', 'index.html'))
  const js = (code) => win.webContents.executeJavaScript(code)

  const facts = await js(`(async () => {
    const waitFor = async (predicate, label, timeout = 15000) => {
      const startedAt = Date.now()
      while (Date.now() - startedAt < timeout) {
        const value = predicate()
        if (value) return value
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const error = document.querySelector('.clone-error')?.textContent || ''
      const notice = document.querySelector('.app-notice')?.textContent || ''
      throw new Error('等待超时：' + label + '；克隆错误=' + error.trim() + '；提示=' + notice.trim())
    }
    const byText = (selector, text) => [...document.querySelectorAll(selector)].find((element) => element.textContent.trim() === text)
    const setValue = (element, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const text = (selector) => (document.querySelector(selector)?.textContent || '').trim()
    const cloneRecords = async () => (await window.gitglass.getLedger()).filter((record) => record.intent === 'Clone repository')

    await waitFor(() => document.querySelector('button[aria-label="克隆仓库"]'), '顶栏克隆入口')
    // 空工作台：左栏空态与右栏引导块都提供同一个入口。
    const emptyGuide = Boolean(byText('.empty-repo button', '克隆仓库')) && Boolean(byText('.repository-guide button', '克隆仓库'))
    const before = await window.gitglass.getState()

    document.querySelector('button[aria-label="克隆仓库"]').click()
    await waitFor(() => document.querySelector('dialog.clone-dialog'), '克隆对话框')
    setValue(document.querySelector('#clone-source'), ${JSON.stringify(origin)})
    setValue(document.querySelector('#clone-parent'), ${JSON.stringify(parent)})
    setValue(document.querySelector('#clone-name'), ${JSON.stringify(TARGET_NAME)})
    document.querySelector('.clone-footer .primary-action').click()
    await waitFor(() => document.querySelector('.clone-target-path'), '预览最终目录')
    const targetLabel = text('.clone-target-path')
    const plannedCommand = text('.clone-plan .planned-command')

    document.querySelector('.clone-footer .primary-action').click()
    await waitFor(() => /已克隆并打开仓库/.test(text('.app-notice')), '克隆成功提示')
    const notice = text('.app-notice')
    const state = await window.gitglass.getState()
    const ledger = (await cloneRecords()).map((record) => ({ intent: record.intent, argv: record.argv, cwd: record.cwd, ok: record.ok, source: record.source }))

    // 同一个窗口里再试一次带内嵌凭据的地址：必须被拒绝，且不能再启动一条命令。
    document.querySelector('button[aria-label="克隆仓库"]').click()
    await waitFor(() => document.querySelector('dialog.clone-dialog'), '第二次克隆对话框')
    setValue(document.querySelector('#clone-source'), 'https://user:tok3n@example.com/owner/repo.git')
    setValue(document.querySelector('#clone-parent'), ${JSON.stringify(parent)})
    setValue(document.querySelector('#clone-name'), 'leaky')
    document.querySelector('.clone-footer .primary-action').click()
    await waitFor(() => document.querySelector('.clone-error'), '凭据拒绝提示')
    const rejectedReason = text('.clone-error')
    const dialogStillOpen = Boolean(document.querySelector('dialog.clone-dialog'))
    const canConfirm = Boolean(byText('.clone-footer .primary-action', '开始克隆'))
    const cloneRecordsAfterRejection = (await cloneRecords()).length

    return {
      emptyGuide,
      emptyStatePath: before?.path || '',
      targetLabel,
      plannedCommand,
      notice,
      repository: text('.brand strong'),
      statePath: state?.path || '',
      branch: state?.branch || '',
      ledger,
      rejectedReason,
      dialogStillOpen,
      canConfirm,
      cloneRecordsAfterRejection,
    }
  })()`)

  const target = path.join(parent, TARGET_NAME)
  console.log(
    MARKER +
      JSON.stringify({
        ok: true,
        target,
        expectedHead: head,
        origin,
        head: fs.existsSync(path.join(target, '.git')) ? git(target, ['rev-parse', 'HEAD']) : '',
        originUrl: fs.existsSync(path.join(target, '.git')) ? git(target, ['remote', 'get-url', 'origin']) : '',
        leakyCreated: fs.existsSync(path.join(parent, 'leaky')),
        ...facts,
      }),
  )
  finish(0)
}

app.whenReady().then(main).catch(fail)
