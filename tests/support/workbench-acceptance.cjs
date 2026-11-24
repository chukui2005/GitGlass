// 0.7 工作台改版验收探针：真实 Electron 窗口 + 真实临时 Git 仓库 + 真实 dist/ 构建。
//
// 它在三个目标尺寸（1440×900 / 1366×768 / 1024×680）下逐项检查交接稿的 P0 通过条件：
// 顶栏不与原生窗口控件重叠、首屏可见 Diff 与提交区、全局无横向滚动、键盘能到达提交与计划按钮；
// 并截三张界面图（外加一张「丢弃改动」计划态）到 .screenshots/ui-redesign/。
//
// 所有等待都是轮询目标状态（布局稳定、焦点到位、Diff 内容对应当前选中的文件），
// 不用固定 sleep：CI 冷启动比本地慢，固定延时一定会翻车。
//
// 以 Electron 主进程方式运行：npx electron tests/support/workbench-acceptance.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const root = path.join(__dirname, '..', '..')
const screenshotRoot = process.env.GITGLASS_SCREENSHOT_DIR || path.join(root, '.screenshots', 'ui-redesign')
const temporaryRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-acceptance-')))
const temporaryProfile = path.join(temporaryRoot, 'profile')
const repository = path.join(temporaryRoot, 'GitGlass-demo')
fs.mkdirSync(temporaryProfile)
fs.mkdirSync(repository)

app.setPath('userData', temporaryProfile)
app.disableHardwareAcceleration()
// 截图按 1x 设备像素比输出（1440×900），与 README 现有截图的尺寸一致，也便于和交接稿逐像素对照。
app.commandLine.appendSwitch('force-device-scale-factor', '1')

// 探针必须有明确的失败出口：Electron 在主进程未捕获异常时会弹一个原生「Error」对话框，
// 那会让 CI 一直挂着等一个没人点的窗口。
function finish(exitCode) {
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  delete process.env.GITGLASS_WORKBENCH_REPO
  try {
    fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {}
  app.exit(exitCode)
}

const fail = (error) => {
  console.error('[WORKBENCH-ERROR] ' + (error && error.stack ? error.stack : error))
  finish(1)
}
process.on('uncaughtException', fail)
process.on('unhandledRejection', fail)
const watchdog = setTimeout(() => fail(new Error('验收探针 180 秒未完成')), 180_000)
watchdog.unref?.()

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 每一步都轮询到目标状态：等待期间只做一次 25ms 的让步，超时信息里带最后观测值。
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

const git = (args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', windowsHide: true })

const write = (relative, content) => {
  const target = path.join(repository, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, 'utf8')
}

const REVIEW_PATH = 'src/settings/configuration.ts'
const REVIEW_SNIPPET = 'retryLimit: 3'

const CONFIGURATION_OLD = [
  'import { readEnv } from "./env";',
  '',
  'export const configuration = {',
  '  retryLimit: 2,',
  '  retryDelayMs: 250,',
  '  timeoutMs: 5000,',
  '};',
  '',
  'export function resolveRegion() {',
  '  return readEnv("REGION") ?? "local";',
  '}',
  '',
].join('\n')

const CONFIGURATION_NEW = [
  'import { readEnv } from "./env";',
  '',
  'export const configuration = {',
  '  retryLimit: 3,',
  '  retryDelayMs: 400,',
  '  timeoutMs: 5000,',
  '};',
  'export const configVersion = 2;',
  '',
  'export function resolveRegion() {',
  '  return readEnv("REGION") ?? "local";',
  '}',
  '',
].join('\n')

// 三个未暂存（修改 / 修改 / 新增）+ 一个已暂存，和交接稿的示例仓库一致。
function buildRepository() {
  git(['init', '-q'])
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(['config', 'user.email', 'dev@example.com'])
  git(['config', 'user.name', 'GitGlass Dev'])
  write(`src/settings/configuration.ts`, CONFIGURATION_OLD)
  write('src/settings/configuration.test.ts', 'import { configuration } from "./configuration";\n\nexport function assertRetry() {\n  return configuration.retryLimit;\n}\n')
  write('docs/quickstart.md', '# Quickstart\n\nOpen a repository.\n\nStage a file.\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'chore: seed the workbench fixture'])
  // 未暂存：两个修改 + 一个新增文件。
  write(`src/settings/configuration.ts`, CONFIGURATION_NEW)
  write('src/settings/configuration.test.ts', 'import { configuration } from "./configuration";\n\nexport function assertRetry() {\n  return configuration.retryLimit > 0;\n}\n')
  write('src/settings/defaults.ts', 'export const defaults = {\n  retryLimit: 3,\n  retryDelayMs: 400,\n};\n')
  // 已暂存：修改一个文件后暂存。
  write('docs/quickstart.md', '# Quickstart\n\nOpen a repository.\n\nStage a file.\n\nReview the diff before you commit.\n')
  git(['add', '--', 'docs/quickstart.md'])
}

// 仓库快照：文件内容 + 暂存区 + 工作区，用于确认「看计划 → 返回」不改变任何东西。
function repositorySnapshot() {
  return {
    status: git(['status', '--porcelain']),
    staged: git(['diff', '--cached', '--stat']),
    unstaged: git(['diff', '--stat']),
    files: {
      configuration: fs.readFileSync(path.join(repository, REVIEW_PATH), 'utf8'),
      quickstart: fs.readFileSync(path.join(repository, 'docs/quickstart.md'), 'utf8'),
    },
  }
}

const measureScript = `(() => {
  const rect = (selector) => {
    const element = document.querySelector(selector)
    if (!element) return null
    const box = element.getBoundingClientRect()
    return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height }
  }
  const visible = (selector) => {
    const box = rect(selector)
    return Boolean(box) && box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < window.innerHeight
  }
  const focusable = (element) => Boolean(element) && element.tabIndex >= 0 && !element.disabled && element.getClientRects().length > 0
  const text = (selector) => {
    const element = document.querySelector(selector)
    return element ? element.textContent.replace(/\\s+/g, ' ').trim() : null
  }
  const panel = document.querySelector('.context-panel')
  const sidebar = document.querySelector('.status-panel')
  const workspace = document.querySelector('.workspace')
  const commit = document.querySelector('.commit-submit')
  const stage = document.querySelector('.current-file-actions button')
  const discard = document.querySelector('.current-file-actions .danger-text')
  const title = document.querySelector('.diff-title')
  const selectedRow = [...document.querySelectorAll('.status-panel .file-row.selected')]
    .map((row) => row.querySelector('.file-select').getAttribute('title'))
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    workspaceScrollX: workspace.scrollWidth - workspace.clientWidth,
    topbar: {
      height: Math.round(document.querySelector('.topbar').getBoundingClientRect().height),
      actionsRight: Math.round(document.querySelector('.top-actions').getBoundingClientRect().right),
      viewportRight: window.innerWidth,
      buttons: [...document.querySelectorAll('header.topbar button')].map((element) => element.getAttribute('aria-label') || element.textContent.trim()),
    },
    diffTitle: { text: text('.diff-title'), rect: rect('.diff-title'), overflowX: title.scrollWidth - title.clientWidth },
    diff: {
      visible: visible('.diff-content'),
      lines: document.querySelectorAll('.diff-content .diff-line').length,
      fileHeaders: document.querySelectorAll('.diff-content .diff-line.file').length,
      showsSelectedFile: Boolean(title && title.textContent.includes('src/settings/configuration.ts')),
      selectedRows: selectedRow,
    },
    commit: {
      heading: text('.commit-panel .section-label h2'),
      visible: visible('.commit-panel'),
      buttonVisible: visible('.commit-submit'),
      buttonLabel: commit ? commit.textContent.trim() : null,
      buttonFocusable: focusable(commit),
    },
    currentFile: {
      heading: text('.current-file .section-label h2'),
      stageLabel: stage ? stage.textContent.trim() : null,
      stageFocusable: focusable(stage),
      discardVisible: Boolean(discard),
      preview: text('.current-file .command-preview'),
      previewCommand: document.querySelector('.current-file .command-preview code')
        ? document.querySelector('.current-file .command-preview code').textContent
        : null,
      textareaVisible: visible('#commit-message'),
    },
    sidebar: {
      rows: [...document.querySelectorAll('.status-panel .file-row')].map((row) => ({
        path: row.querySelector('.file-select').getAttribute('title'),
        name: row.querySelector('.file-name') ? row.querySelector('.file-name').textContent : '',
        dir: row.querySelector('.file-dir') ? row.querySelector('.file-dir').textContent : '',
        status: row.querySelector('.status') ? row.querySelector('.status').textContent : '',
        selected: row.classList.contains('selected'),
      })),
      rowHeight: Math.round(document.querySelector('.status-panel .file-row').getBoundingClientRect().height),
      overflowX: sidebar.scrollWidth - sidebar.clientWidth,
    },
    rightPanel: {
      headings: [...panel.querySelectorAll('.section-label h2')].map((element) => element.textContent),
      overflowX: panel.scrollWidth - panel.clientWidth,
      scrollable: panel.scrollHeight > panel.clientHeight,
    },
    ledger: {
      height: Math.round(document.querySelector('.command-ledger').getBoundingClientRect().height),
      glance: text('.ledger-glance'),
      expanded: document.querySelector('.ledger-title').getAttribute('aria-expanded'),
    },
  }
})()`

async function capture(window, name, rect) {
  const image = rect
    ? await window.webContents.capturePage(rect)
    : await window.webContents.capturePage()
  const png = image.toPNG()
  fs.mkdirSync(screenshotRoot, { recursive: true })
  fs.writeFileSync(path.join(screenshotRoot, `${name}.png`), png)
  return png.length
}

const sizes = [
  { width: 1440, height: 900, name: 'workbench-1440' },
  { width: 1366, height: 768, name: 'workbench-1366' },
  { width: 1024, height: 680, name: 'workbench-1024' },
]

app.whenReady().then(async () => {
  let window
  try {
    buildRepository()
    process.env.GITGLASS_WORKBENCH_REPO = repository

    window = new BrowserWindow({
      width: sizes[0].width,
      height: sizes[0].height,
      show: false,
      useContentSize: true,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        preload: path.join(__dirname, 'workbench-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    })
    const js = (body) => window.webContents.executeJavaScript(body)
    window.webContents.on('console-message', (event) => {
      if (event.level === 'error') console.error('[RENDERER] ' + event.message)
    })
    await window.loadFile(path.join(root, 'dist', 'index.html'))
    await waitUntil(() => js(`Boolean(document.querySelector('.status-panel .file-row'))`), '工作区文件列表渲染')

    // —— 轮询式等待器 ——
    const waitForLayout = (size) => waitUntil(() => js(`(() => {
      const title = document.querySelector('.diff-title')
      const workspace = document.querySelector('#workspace-main')
      if (!title || !workspace) return false
      const box = title.getBoundingClientRect()
      return window.innerWidth === ${size.width}
        && window.innerHeight === ${size.height}
        && Math.round(box.height) === 56
        && Math.round(workspace.clientWidth) === Math.round(window.innerWidth)
    })()`), `布局稳定在 ${size.width}×${size.height}`)

    const waitForDiffOf = (filePath, snippet) => waitUntil(() => js(`(() => {
      const title = document.querySelector('.diff-title')
      const content = document.querySelector('.diff-content')
      const selected = [...document.querySelectorAll('.status-panel .file-row.selected')]
        .map((row) => row.querySelector('.file-select').getAttribute('title'))
      if (!title || !content) return false
      return title.textContent.includes(${JSON.stringify(filePath)})
        && content.textContent.includes(${JSON.stringify(snippet)})
        && selected.length === 1
        && selected[0] === ${JSON.stringify(filePath)}
    })()`), `Diff 内容对应当前选中的 ${filePath}`)

    // 选中示例仓库里正在审阅的那个文件，并确认 Diff 真的是它的内容。
    const selectReviewFile = async () => {
      const clicked = await js(`(() => {
        const node = [...document.querySelectorAll('.status-panel .file-select')]
          .find((element) => element.getAttribute('title') === ${JSON.stringify(REVIEW_PATH)})
        if (!node) return false
        node.click()
        return true
      })()`)
      if (!clicked) throw new Error(`没有找到示例文件行：${REVIEW_PATH}`)
      await waitForDiffOf(REVIEW_PATH, REVIEW_SNIPPET)
    }

    const waitForBlur = async () => {
      await js(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`)
      await waitUntil(() => js(`document.activeElement === document.body || document.activeElement === null`), '焦点回到文档')
      // 等两帧，确保合成器拿到的是「没有焦点环」的那一帧。
      await js('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    }

    await selectReviewFile()

    // 窗口需要真实可见，Chromium 才会处理合成键盘事件与 capturePage。
    window.show()
    await waitUntil(() => js('document.hasFocus() && !document.hidden'), '验收窗口获得焦点且可见')
    await selectReviewFile()

    // 键盘：写一句提交说明后，从说明框按 Tab 必须能到达提交按钮（禁用按钮按设计不可聚焦）。
    const setCommitMessage = async (value) => js(`(() => {
      const area = document.querySelector('#commit-message')
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(area, ${JSON.stringify(value)})
      area.dispatchEvent(new Event('input', { bubbles: true }))
      return area.value
    })()`)

    const results = []
    for (const size of sizes) {
      window.setContentSize(size.width, size.height)
      await waitForLayout(size)
      await selectReviewFile()
      await waitForBlur()
      const measured = await js(measureScript)
      const bytes = await capture(window, size.name)

      await setCommitMessage('整理重试参数')
      await waitUntil(() => js(`!document.querySelector('.commit-submit').disabled`), '填写说明后提交按钮可用')
      await js(`document.querySelector('#commit-message').focus()`)
      const order = []
      for (let step = 0; step < 6 && !order.includes('primary-action commit-submit'); step += 1) {
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
        await pause(30)
        order.push(await js(`document.activeElement.className`))
      }
      const commitReachable = order.includes('primary-action commit-submit')
      const commitPreview = await js(`(() => {
        const preview = document.querySelector('.commit-panel .command-preview')
        return preview ? preview.textContent.replace(/\\s+/g, ' ').trim() : null
      })()`)
      await setCommitMessage('')
      await waitUntil(() => js(`document.querySelector('.commit-submit').disabled`), '清空说明后提交按钮恢复禁用')
      results.push({ ...measured, size: { width: size.width, height: size.height }, screenshotBytes: bytes, tabOrder: order, commitReachable, commitPreview })
    }

    // 计划态：打开「丢弃改动…」，确认只出现计划、仓库（内容 + 暂存区）没有变化，再返回。
    window.setContentSize(1440, 900)
    await waitForLayout({ width: 1440, height: 900 })
    await selectReviewFile()
    const beforePlan = repositorySnapshot()
    await js(`document.querySelector('.current-file-actions .danger-text').click()`)
    await waitUntil(() => js(`Boolean(document.querySelector('.planned-command'))`), '丢弃计划出现')
    const plan = await js(`(() => ({
      heading: document.querySelector('.inspector-flow .inspector-heading h2').textContent,
      command: document.querySelector('.planned-command code').textContent,
      label: document.querySelector('.planned-command span').textContent,
      confirm: document.querySelector('.inspector-flow .primary-action').textContent.trim(),
      back: Boolean(document.querySelector('.inspector-flow .text-action')),
      risk: document.querySelector('.risk-label') ? document.querySelector('.risk-label').textContent : null,
      backFocusable: (() => { const back = document.querySelector('.inspector-flow .text-action'); return Boolean(back) && back.tabIndex >= 0 && !back.disabled })(),
    }))()`)
    await waitForBlur()
    window.moveTop()
    const planBytes = await capture(window, 'workbench-1440-plan')
    const duringPlan = repositorySnapshot()
    await js(`document.querySelector('.inspector-flow .text-action').click()`)
    await waitUntil(() => js(`!document.querySelector('.planned-command')`), '返回后计划面板关闭')
    const afterCancel = repositorySnapshot()
    // 快照里同时有文件内容、暂存区与工作区状态：三者都必须与打开计划之前完全一致。
    const planUnchanged = JSON.stringify(beforePlan) === JSON.stringify(duringPlan)
      && JSON.stringify(beforePlan) === JSON.stringify(afterCancel)

    // 真实暂存一次：预览里的命令必须与账本记录的命令逐字一致，且只命中这一个文件。
    const previewCommand = await js(`(() => {
      const node = document.querySelector('.current-file .command-preview code')
      return node ? node.textContent : null
    })()`)
    await js(`document.querySelector('.current-file-actions button').click()`)
    await waitUntil(() => js(`(() => {
      const staged = [...document.querySelectorAll('.file-section')]
        .find((section) => section.textContent.includes('已暂存改动'))
      if (!staged) return false
      return [...staged.querySelectorAll('.file-select')]
        .some((node) => node.getAttribute('title') === ${JSON.stringify(REVIEW_PATH)})
    })()`), '暂存后文件出现在已暂存区')
    const ledgerRecords = await js(`window.gitglass.getLedger()`)
    const stageRecord = ledgerRecords.find((record) => record.source === 'user'
      && record.intent === 'Stage file'
      && (record.argv || []).includes(REVIEW_PATH))
    const stageCheck = {
      previewCommand,
      recordedCommand: stageRecord ? stageRecord.displayCommand : null,
      // 暂存区里只有这一个文件被移动过来（另一个已暂存文件保持原样）。
      stagedInIndex: git(['status', '--porcelain']).includes(`M  ${REVIEW_PATH}`),
      matches: Boolean(previewCommand) && Boolean(stageRecord) && previewCommand === stageRecord.displayCommand,
    }

    // 命令账本展开态：README 的「命令账本」截图与 P1 的账本两行结构都靠这一张。
    // 先关掉暂存成功的提示条，截到的是稳定的常态界面（不是一条六秒后自己消失的通知）。
    const dismissed = await js(`(() => {
      const dismiss = document.querySelector('.app-notice-dismiss')
      if (!dismiss) return false
      dismiss.click()
      return true
    })()`)
    if (dismissed) await waitUntil(() => js(`!document.querySelector('.app-notice')`), '暂存提示条已关闭')
    await js(`document.querySelector('.ledger-title').click()`)
    await waitUntil(() => js(`Boolean(document.querySelector('.ledger-list .ledger-entry'))`), '账本展开并渲染记录')
    await waitForBlur()
    // 裁剪到「顶栏 + 面板 + 账本」：README 里那张命令账本图要聚焦账本，而不是整页。
    const ledgerBox = await js(`(() => {
      const box = document.querySelector('.command-ledger').getBoundingClientRect()
      return { top: Math.round(box.top), height: Math.round(box.height), viewport: window.innerHeight }
    })()`)
    const ledgerBytes = await capture(window, 'workbench-1440-ledger', {
      x: 0,
      y: 0,
      width: 1440,
      height: Math.min(ledgerBox.viewport, ledgerBox.top + Math.min(ledgerBox.height, 260)),
    })
    const ledgerView = await js(`(() => ({
      expanded: document.querySelector('.ledger-title').getAttribute('aria-expanded'),
      height: Math.round(document.querySelector('.command-ledger').getBoundingClientRect().height),
      filters: [...document.querySelectorAll('.ledger-filter button')].map((node) => node.textContent.trim()),
      active: document.querySelector('.ledger-filter button.active')
        ? document.querySelector('.ledger-filter button.active').textContent.trim()
        : null,
      rows: document.querySelectorAll('.ledger-list .ledger-entry').length,
      firstCommand: document.querySelector('.ledger-command') ? document.querySelector('.ledger-command').textContent : null,
    }))()`)

    console.log('[WORKBENCH] ' + JSON.stringify({
      repository,
      sizes: results.map((entry) => ({
        size: entry.size,
        viewport: entry.viewport,
        overflowX: entry.overflowX,
        workspaceScrollX: entry.workspaceScrollX,
        topbar: entry.topbar,
        diffTitle: entry.diffTitle.text,
        diffTitleHeight: Math.round(entry.diffTitle.rect.height),
        diffTitleOverflowX: entry.diffTitle.overflowX,
        diffLines: entry.diff.lines,
        diffFileHeaders: entry.diff.fileHeaders,
        diffShowsSelectedFile: entry.diff.showsSelectedFile,
        diffSelectedRows: entry.diff.selectedRows,
        commit: entry.commit,
        currentFile: entry.currentFile,
        sidebar: entry.sidebar,
        rightPanel: entry.rightPanel,
        ledger: entry.ledger,
        tabOrder: entry.tabOrder,
        commitReachable: entry.commitReachable,
        commitPreview: entry.commitPreview,
        screenshotBytes: entry.screenshotBytes,
      })),
      plan: { ...plan, statusUnchanged: planUnchanged, screenshotBytes: planBytes },
      stageCheck,
      ledgerView: { ...ledgerView, screenshotBytes: ledgerBytes },
      screenshots: screenshotRoot,
    }))
    finish(0)
  } catch (error) {
    fail(error)
  }
})
