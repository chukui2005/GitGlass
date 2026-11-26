// Real Electron window + real temporary Git repository + real dist/ build for
// v0.6.10 PR3. It verifies ref navigation (including a commit outside the main
// page), every parent edge of a merge, keyboard focus and layout at 1440 and at
// the minimum 1024x680 window, then writes screenshots for the handoff.
//
// Run with: npx electron tests/support/history-graph-window.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const root = path.join(__dirname, '..', '..')
const screenshotRoot = process.env.GITGLASS_SCREENSHOT_DIR || path.join(root, '.screenshots', 'history-graph')
const temporaryRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-history-graph-')))
const repository = path.join(temporaryRoot, 'GitGlass-history')
const bare = path.join(temporaryRoot, 'origin.git')
const profile = path.join(temporaryRoot, 'profile')
fs.mkdirSync(repository)
fs.mkdirSync(profile)

app.setPath('userData', profile)
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('force-device-scale-factor', '1')

function finish(code) {
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  delete process.env.GITGLASS_WORKBENCH_REPO
  try {
    fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {}
  app.exit(code)
}

const fail = (error) => {
  console.error('[HISTORY-GRAPH-ERROR] ' + (error && error.stack ? error.stack : error))
  finish(1)
}
process.on('uncaughtException', fail)
process.on('unhandledRejection', fail)
const watchdog = setTimeout(() => fail(new Error('历史图验收探针 180 秒未完成')), 180_000)
watchdog.unref?.()

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
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

const git = (args, cwd = repository) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
const gitBare = (args) => execFileSync('git', ['--git-dir', bare, ...args], { encoding: 'utf8', windowsHide: true })
const write = (relative, content) => {
  const target = path.join(repository, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, 'utf8')
}
const commit = (file, content, message) => {
  write(file, content)
  git(['add', '--', file])
  git(['commit', '-q', '-m', message])
  return git(['rev-parse', 'HEAD']).trim()
}

function buildRepository() {
  fs.mkdirSync(bare)
  git(['init', '-q', '-b', 'main'])
  execFileSync('git', ['init', '--bare', '-q', bare], { cwd: repository, encoding: 'utf8', windowsHide: true })
  git(['config', 'user.name', 'History Graph Probe'])
  git(['config', 'user.email', 'graph@test.local'])

  const initial = commit('initial.txt', 'root\n', 'feat: initial commit')
  for (let index = 0; index < 6; index += 1) commit('filler.txt', `filler ${index}\n`, `chore: filler ${index}`)

  git(['switch', '-q', '-c', 'feature'])
  const feature = commit('feature.txt', 'feature\n', 'feat: feature work')
  git(['switch', '-q', 'main'])
  commit('main.txt', 'main\n', 'feat: main work')
  git(['merge', '--no-ff', 'feature', '-q', '-m', 'merge: feature into main'])
  const merge = git(['rev-parse', 'HEAD']).trim()

  git(['branch', 'release', feature])
  git(['tag', 'release', feature])
  git(['tag', '-a', 'v1.0.0', '-m', 'release 1.0.0', merge])
  git(['tag', '-a', 'v0.1.0', '-m', 'root release', initial])

  // A tagged commit that is deliberately outside main's history (and therefore
  // outside the first history page): the ref must read it by full id.
  git(['switch', '-q', '--detach', initial])
  commit('archived.txt', 'archived\n', 'feat: archived outside')
  const outside = git(['rev-parse', 'HEAD']).trim()
  git(['tag', '-a', 'outside', '-m', 'archived outside', outside])
  git(['switch', '-q', 'main'])

  git(['remote', 'add', 'origin', bare])
  git(['push', '-q', '-u', 'origin', 'main'])
  git(['push', '-q', 'origin', 'refs/heads/feature:refs/heads/feature', 'refs/heads/release:refs/heads/release'])
  gitBare(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(['remote', 'set-head', 'origin', '-a'])

  return { initial, feature, merge, outside }
}

function snapshot() {
  const files = ['initial.txt', 'feature.txt', 'main.txt', 'filler.txt']
  return {
    head: git(['rev-parse', 'HEAD']).trim(),
    refs: git(['for-each-ref', '--format=%(refname) %(objectname)']),
    index: git(['status', '--porcelain=v1']),
    diff: git(['diff']),
    cached: git(['diff', '--cached']),
    files: files.map((name) => `${name}:${fs.readFileSync(path.join(repository, name), 'utf8')}`),
  }
}

async function capture(window, name) {
  const image = await window.webContents.capturePage()
  fs.mkdirSync(screenshotRoot, { recursive: true })
  fs.writeFileSync(path.join(screenshotRoot, `${name}.png`), image.toPNG())
  return image.toPNG().length
}

app.whenReady().then(async () => {
  let window
  try {
    const commits = buildRepository()
    process.env.GITGLASS_WORKBENCH_REPO = repository
    const before = snapshot()

    window = new BrowserWindow({
      width: 1440,
      height: 900,
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
    await waitUntil(() => js(`Boolean(document.querySelector('.status-panel .file-row, .empty-repo'))`), '首屏渲染')

    await js(`[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '历史审查').click()`)
    await waitUntil(() => js(`Boolean(document.querySelector('.reference-panel [data-ref-name="refs/tags/release"]'))`), '引用面板渲染')

    const refs = await js(`window.gitglass.getRefs()`)
    const branchRef = refs.refs.find((ref) => ref.fullName === 'refs/heads/release')
    const tagRef = refs.refs.find((ref) => ref.fullName === 'refs/tags/release')
    const alias = refs.refs.find((ref) => ref.fullName === 'refs/remotes/origin/HEAD')
    const outsideRef = refs.refs.find((ref) => ref.fullName === 'refs/tags/outside')
    if (!branchRef || !tagRef || !alias || !outsideRef) throw new Error('引用读取缺少分支、标签或远程默认别名')
    if (branchRef.commit !== tagRef.commit) throw new Error('同名分支和标签没有指向同一个已验证提交')
    if (alias.targetRef !== 'refs/remotes/origin/main') throw new Error(`远程默认别名错误：${alias.targetRef}`)
    if (outsideRef.commit !== commits.outside) throw new Error('外部标签没有解析到真实提交')

    // Same short name, different full ref + kind.
    const sameName = await js(`(() => ({
      branch: document.querySelector('[data-ref-name="refs/heads/release"]')?.getAttribute('data-ref-commit'),
      tag: document.querySelector('[data-ref-name="refs/tags/release"]')?.getAttribute('data-ref-commit'),
      alias: document.querySelector('[data-ref-name="refs/remotes/origin/HEAD"] .ref-name')?.textContent,
    }))()`)
    if (sameName.branch !== tagRef.commit || sameName.tag !== tagRef.commit) throw new Error('引用面板的完整提交 ID 不一致')

    // Click the in-page tag: detail must come from the existing commit detail read.
    await js(`document.querySelector('[data-ref-name="refs/tags/release"]').click()`)
    await waitUntil(() => js(`document.querySelector('.ref-feedback')?.textContent.includes('已从标签') && document.querySelector('.inspector-heading h2')?.textContent === 'feat: feature work'`), '标签定位当前列表提交')

    // Click the outside tag: full-id read, selection and explicit feedback.
    await js(`document.querySelector('[data-ref-name="refs/tags/outside"]').click()`)
    await waitUntil(() => js(`document.querySelector('.ref-feedback')?.textContent.includes('已按完整 ID') && document.querySelector('.inspector-heading h2')?.textContent === 'feat: archived outside'`), '标签按完整 ID 定位列表外提交')
    const outsideView = await js(`(() => ({
      feedback: document.querySelector('.ref-feedback')?.textContent || '',
      note: document.querySelector('.history-selection-note')?.textContent || '',
      hashes: [...document.querySelectorAll('.ref-row[data-ref-name="refs/tags/outside"]')].map((node) => node.getAttribute('data-ref-commit')),
    }))()`)

    // Show the window before the first screenshot so the compositor has
    // produced real frames for both the tag-jump feedback and the graph.
    window.show()
    await waitUntil(() => js('document.hasFocus() && !document.hidden'), '验收窗口可见且获得焦点')
    const tagJumpScreenshotBytes = await capture(window, 'history-graph-tag-jump-1440')

    // Select the merge row and inspect every parent edge it drew.
    await js(`[...document.querySelectorAll('.commit-select')].find((button) => button.getAttribute('aria-label') === '查看提交 merge: feature into main').click()`)
    await waitUntil(() => js(`document.querySelector('.inspector-heading h2')?.textContent === 'merge: feature into main'`), '合并提交详情')
    const graph = await js(`(() => {
      const row = [...document.querySelectorAll('.commit-select')].find((button) => button.getAttribute('aria-label') === '查看提交 merge: feature into main')
      return {
        edges: [...row.querySelectorAll('svg.commit-graph [data-parent]')].map((node) => node.getAttribute('data-parent')),
        nodes: row.querySelectorAll('svg.commit-graph .graph-node').length,
        notice: document.querySelector('.history-graph-notice')?.textContent || '',
      }
    })()`)
    if (graph.edges.length !== 2) throw new Error(`合并提交只画了 ${graph.edges.length} 条父边`)

    // Keyboard: refs and commit rows use the same native buttons as the mouse.
    const keyboard = await js(`(() => {
      const first = document.querySelector('[data-ref-name="refs/heads/main"]')
      first.focus()
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      const refNext = document.activeElement?.getAttribute('data-ref-name')
      const mergeRow = [...document.querySelectorAll('.commit-select')].find((button) => button.getAttribute('aria-label') === '查看提交 merge: feature into main')
      mergeRow.focus()
      mergeRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      return { refNext, commitNext: document.activeElement?.getAttribute('aria-label') }
    })()`)

    const sizes = []
    for (const size of [{ width: 1440, height: 900, name: 'history-graph-1440' }, { width: 1024, height: 680, name: 'history-graph-1024' }]) {
      window.setContentSize(size.width, size.height)
      await waitUntil(() => js(`window.innerWidth === ${size.width} && window.innerHeight === ${size.height} && Boolean(document.querySelector('.commit-graph'))`), `布局稳定在 ${size.width}×${size.height}`)
      await js(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`)
      await waitUntil(() => js(`document.activeElement === document.body || document.activeElement === null`), '焦点回到文档')
      // Two frames ensure the compositor captures the un-focused frame rather
      // than the browser's transient focus ring.
      await js('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      const measured = await js(`(() => {
        const box = (selector) => {
          const node = document.querySelector(selector)
          if (!node) return null
          const rect = node.getBoundingClientRect()
          return { left: rect.left, right: rect.right, width: rect.width, height: rect.height }
        }
        const workspace = document.querySelector('#workspace-main')
        const reference = document.querySelector('.reference-panel')
        return {
          viewport: { width: window.innerWidth, height: window.innerHeight },
          documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          workspaceOverflow: workspace ? workspace.scrollWidth - workspace.clientWidth : null,
          referenceOverflow: reference ? reference.scrollWidth - reference.clientWidth : null,
          reference: box('.reference-panel'),
          main: box('.main-panel'),
          graph: box('.commit-graph'),
          commitRowHeight: Math.round(document.querySelector('.history-row').getBoundingClientRect().height),
          refs: document.querySelectorAll('.ref-row[data-ref-name]').length,
          graphNotice: document.querySelector('.history-graph-notice')?.textContent || '',
        }
      })()`)
      const screenshotBytes = await capture(window, size.name)
      sizes.push({ ...measured, size: { width: size.width, height: size.height }, screenshotBytes })
    }

    const after = snapshot()
    console.log('[HISTORY-GRAPH] ' + JSON.stringify({
      commits,
      refs: {
        branch: { fullName: branchRef.fullName, commit: branchRef.commit },
        tag: { fullName: tagRef.fullName, commit: tagRef.commit, annotated: tagRef.annotated },
        alias: { fullName: alias.fullName, targetRef: alias.targetRef, commit: alias.commit },
        outside: { fullName: outsideRef.fullName, commit: outsideRef.commit },
        sameName,
      },
      outsideView,
      tagJumpScreenshotBytes,
      graph,
      keyboard,
      repositoryUnchanged: JSON.stringify(before) === JSON.stringify(after),
      sizes,
      screenshots: screenshotRoot,
    }))
    finish(0)
  } catch (error) {
    fail(error)
  }
})
