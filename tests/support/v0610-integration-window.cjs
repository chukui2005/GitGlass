// v0.6.10 end-to-end acceptance: real Electron window + real local bare remote.
//
// Flow: empty workbench -> clone -> check out origin/feature -> create branch ->
// commit -> local tag -> first push -> history graph locate by tag. The preload
// reuses the production RepositoryService/GitCommandService/cloner so the UI
// exercises the merged remote and history code, not a second implementation.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const root = path.join(__dirname, '..', '..')
const screenshotRoot = process.env.GITGLASS_SCREENSHOT_DIR || path.join(root, '.screenshots', 'v0610-integration')
const temporaryRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-v0610-integration-')))
const seed = path.join(temporaryRoot, 'seed')
const bare = path.join(temporaryRoot, 'origin.git')
const cloneParent = path.join(temporaryRoot, 'clones')
const profile = path.join(temporaryRoot, 'profile')
const repository = path.join(cloneParent, 'GitGlass-e2e')
const COMMIT_MESSAGE = 'feat: integration demo commit'
fs.mkdirSync(seed)
fs.mkdirSync(cloneParent)
fs.mkdirSync(profile)

app.setPath('userData', profile)
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('force-device-scale-factor', '1')

function finish(code) {
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  delete process.env.GITGLASS_INTEGRATION_ROOT
  try {
    fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {}
  app.exit(code)
}
const fail = (error) => {
  console.error('[V0610-INTEGRATION-ERROR] ' + (error && error.stack ? error.stack : error))
  finish(1)
}
process.on('uncaughtException', fail)
process.on('unhandledRejection', fail)
const watchdog = setTimeout(() => fail(new Error('联调探针 240 秒未完成')), 240_000)
watchdog.unref?.()

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitUntil(check, label, timeout = 25_000) {
  const deadline = Date.now() + timeout
  let last
  for (;;) {
    last = await check()
    if (last) return last
    if (Date.now() >= deadline) throw new Error(`等待超时：${label}；最后观测值=${JSON.stringify(last)}`)
    await pause(25)
  }
}

const git = (args, cwd = seed) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
const gitBare = (args) => execFileSync('git', ['--git-dir', bare, ...args], { encoding: 'utf8', windowsHide: true })
const write = (relative, content) => fs.writeFileSync(path.join(seed, relative), content, 'utf8')

function buildRemoteFixture() {
  execFileSync('git', ['init', '-q', '-b', 'main', seed], { encoding: 'utf8', windowsHide: true })
  git(['config', 'user.name', 'Integration Probe'])
  git(['config', 'user.email', 'integration@test.local'])
  write('root.txt', 'root\n')
  git(['add', '--', 'root.txt'])
  git(['commit', '-q', '-m', 'chore: seed integration remote'])
  git(['switch', '-q', '-c', 'feature'])
  write('feature.txt', 'feature\n')
  git(['add', '--', 'feature.txt'])
  git(['commit', '-q', '-m', 'feat: remote feature branch'])
  const feature = git(['rev-parse', 'HEAD']).trim()
  git(['switch', '-q', 'main'])

  execFileSync('git', ['init', '--bare', '-q', bare], { cwd: temporaryRoot, encoding: 'utf8', windowsHide: true })
  git(['remote', 'add', 'origin', bare])
  git(['push', '-q', 'origin', 'main'])
  git(['push', '-q', 'origin', 'refs/heads/feature:refs/heads/feature'])
  gitBare(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(['remote', 'set-head', 'origin', '-a'])
  return { feature }
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
    const fixture = buildRemoteFixture()
    process.env.GITGLASS_INTEGRATION_ROOT = temporaryRoot

    window = new BrowserWindow({
      width: 1440,
      height: 900,
      show: false,
      useContentSize: true,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        preload: path.join(__dirname, 'v0610-integration-preload.cjs'),
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
    await waitUntil(() => js(`Boolean(document.querySelector('.empty-repo'))`), '空工作台出现')
    // Keep the window visible from the start so the compositor follows every
    // React state change; a hidden window can hand the first capture a stale
    // pre-history frame after a resize.
    window.show()
    await waitUntil(() => js('document.hasFocus() && !document.hidden'), '联调窗口可见')

    const setInput = (selector, value) => js(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)})
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(value)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return input.value
    })()`)

    // Clone from the empty workbench, using the local bare remote.
    await js(`(() => {
      const button = [...document.querySelectorAll('.empty-repo button')].find((node) => node.textContent.includes('克隆仓库'))
      button.click()
    })()`)
    await waitUntil(() => js(`Boolean(document.querySelector('#clone-source'))`), '克隆对话框')
    await setInput('#clone-source', bare)
    await js(`[...document.querySelectorAll('.clone-target-row button')].find((node) => node.textContent.includes('选择目录')).click()`)
    await waitUntil(() => js(`document.querySelector('#clone-parent')?.value === ${JSON.stringify(cloneParent)}`), '克隆父目录')
    await setInput('#clone-name', 'GitGlass-e2e')
    await js(`[...document.querySelectorAll('.clone-footer button')].find((node) => node.textContent.includes('预览克隆')).click()`)
    await waitUntil(() => js(`Boolean(document.querySelector('.clone-plan'))`), '克隆预览')
    const clonePlan = await js(`document.querySelector('.clone-plan .planned-command code')?.textContent || ''`)
    await js(`[...document.querySelectorAll('.clone-footer button')].find((node) => node.textContent.includes('开始克隆')).click()`)
    const cloneOutcome = await waitUntil(() => js(`(() => {
      if (document.querySelector('.brand strong')?.textContent.includes('GitGlass-e2e') && document.querySelector('.status-panel')) return { ok: true }
      const error = document.querySelector('.clone-error')?.textContent
      if (error) return { ok: false, error }
      return false
    })()`), '克隆后打开仓库')
    if (!cloneOutcome.ok) throw new Error(`克隆失败：${cloneOutcome.error}`)

    // A CI runner has no personal global Git identity. The workbench commit must
    // carry a real author, so configure the cloned worktree before committing.
    git(['config', 'user.name', 'Integration Probe'], repository)
    git(['config', 'user.email', 'integration@test.local'], repository)

    // Remote management entry is still present after the merge.
    await waitUntil(() => js(`Boolean([...document.querySelectorAll('.remote-summary .section-label span')].find((node) => node.textContent === '远程')) && Boolean(document.querySelector('[aria-label="检出远程分支 origin/feature"]'))`), '远程管理与远程跟踪分支入口')

    // Check out origin/feature through its reviewed plan.
    await js(`document.querySelector('[aria-label="检出远程分支 origin/feature"]').click()`)
    await waitUntil(() => js(`Boolean(document.querySelector('.inspector-flow .primary-action')) && document.querySelector('.inspector-flow h2')?.textContent.includes('检出远程跟踪分支')`), '检出远程分支计划')
    await js(`document.querySelector('.inspector-flow .primary-action').click()`)
    await waitUntil(() => js(`document.querySelector('.top-state code')?.textContent === 'feature'`), '检出后位于 feature 分支')

    // Create the demo branch through the existing branch plan.
    await setInput('input[name="branch-name"]', 'integration/demo')
    await waitUntil(() => js(`document.querySelector('input[name="branch-name"]')?.value === 'integration/demo' && !([...document.querySelectorAll('.branch-create button')].find((node) => node.textContent.includes('创建'))?.disabled)`), '创建分支按钮可用')
    await js(`[...document.querySelectorAll('.branch-create button')].find((node) => node.textContent.includes('创建')).click()`)
    await waitUntil(() => js(`document.querySelector('.inspector-flow .primary-action')?.textContent.includes('确认创建分支')`), '创建分支计划')
    await js(`document.querySelector('.inspector-flow .primary-action').click()`)
    await waitUntil(() => js(`document.querySelector('.top-state code')?.textContent === 'integration/demo' && !document.querySelector('button[aria-label="打开仓库"]').disabled`), '创建后位于 integration/demo 分支且刷新完成')

    // The harness writes the worktree file, then uses the same watcher signal
    // the real app receives; the rest of the stage/commit flow is the UI.
    fs.writeFileSync(path.join(repository, 'integration-demo.txt'), 'integration demo\n', 'utf8')
    await js(`window.gitglass.__notifyRepositoryChanged('refs')`)
    await waitUntil(() => js(`Boolean([...document.querySelectorAll('.status-panel .file-select')].find((node) => node.getAttribute('title') === 'integration-demo.txt'))`), '工作区新文件出现')
    await js(`[...document.querySelectorAll('.status-panel .file-select')].find((node) => node.getAttribute('title') === 'integration-demo.txt').click()`)
    await waitUntil(() => js(`Boolean(document.querySelector('.current-file-actions button'))`), '文件操作可用')
    await js(`document.querySelector('.current-file-actions button').click()`)
    await waitUntil(() => js(`[...document.querySelectorAll('.file-section')].some((section) => section.textContent.includes('已暂存改动') && section.textContent.includes('integration-demo.txt'))`), '文件已暂存')

    await js(`(() => {
      const textarea = document.querySelector('#commit-message')
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(textarea, ${JSON.stringify(COMMIT_MESSAGE)})
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await waitUntil(() => js(`!document.querySelector('.commit-submit')?.disabled`), '提交按钮可用')
    await js(`document.querySelector('.commit-submit').click()`)
    await waitUntil(() => {
      try {
        return git(['log', '-1', '--pretty=%s'], repository).trim() === COMMIT_MESSAGE
      } catch {
        return false
      }
    }, '真实提交生成')
    const localCommit = git(['rev-parse', 'HEAD'], repository).trim()

    // A local tag exists before first push: it must NOT follow the branch.
    git(['tag', 'demo-tag', localCommit], repository)
    await js(`window.gitglass.__notifyRepositoryChanged('refs')`)
    const remoteTagsBeforePush = gitBare(['for-each-ref', '--format=%(refname)', 'refs/tags']).trim()
    if (remoteTagsBeforePush) throw new Error(`首次推送前远端不应有标签：${remoteTagsBeforePush}`)

    await waitUntil(() => js(`(() => {
      const button = [...document.querySelectorAll('.remote-summary button')].find((node) => node.textContent.includes('首次推送并设置上游'))
      return Boolean(button) && !button.disabled
    })()`), '首次推送入口')
    await js(`[...document.querySelectorAll('.remote-summary button')].find((node) => node.textContent.includes('首次推送并设置上游')).click()`)
    const firstPushPlan = await waitUntil(() => js(`(() => {
      const heading = document.querySelector('.inspector-flow h2')?.textContent || ''
      const primary = document.querySelector('.inspector-flow .primary-action')
      if (heading.includes('首次推送并设置上游') && primary) return { ok: true }
      const alert = document.querySelector('.inspector-flow [role="alert"]')?.textContent
      if (alert) return { ok: false, error: alert }
      return false
    })()`), '首次推送计划')
    if (!firstPushPlan.ok) throw new Error(`首次推送计划失败：${firstPushPlan.error}`)
    const firstPushCommand = await js(`document.querySelector('.inspector-flow .planned-command code')?.textContent || ''`)
    await js(`document.querySelector('.inspector-flow .primary-action').click()`)
    await waitUntil(() => js(`document.querySelector('.app-notice')?.textContent.includes('已推送并设置上游')`), '首次推送成功')
    await waitUntil(() => js(`!document.querySelector('.remote-summary')?.textContent.includes('首次推送并设置上游')`), '推送后上游入口收起')

    const remoteCommit = gitBare(['rev-parse', 'refs/heads/integration/demo']).trim()
    const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], repository).trim()
    const counts = git(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], repository).trim().split(/\s+/).map(Number)
    const remoteBranches = gitBare(['for-each-ref', '--format=%(refname)', 'refs/heads']).trim().split(/\r?\n/).filter(Boolean)
    const remoteTagsAfterPush = gitBare(['for-each-ref', '--format=%(refname)', 'refs/tags']).trim()
    const remoteTracking = git(['rev-parse', 'refs/remotes/origin/integration/demo'], repository).trim()
    const ledger = await js(`window.gitglass.getLedger()`)
    const firstPushRecord = ledger.find((record) => record.intent === 'Push branch and set upstream' && record.ok)

    if (localCommit !== remoteCommit) throw new Error('本地提交与远端分支不一致')
    if (upstream !== 'origin/integration/demo') throw new Error(`上游不一致：${upstream}`)
    if (counts[0] !== 0 || counts[1] !== 0) throw new Error(`ahead/behind 不是 0/0：${counts.join('/')}`)
    if (remoteTagsAfterPush) throw new Error(`首次推送意外发送了标签：${remoteTagsAfterPush}`)
    if (!remoteBranches.includes('refs/heads/integration/demo')) throw new Error('远端缺少 integration/demo')
    if (remoteTracking !== localCommit) throw new Error('本地 origin/integration/demo 与提交不一致')

    // History graph: remote tracking branch + local tag, both from the merged UI.
    await js(`[...document.querySelectorAll('header.topbar button')].find((node) => node.getAttribute('aria-label') === '历史审查').click()`)
    await waitUntil(() => js(`Boolean(document.querySelector('.reference-panel'))`), '历史图引用面板')
    await waitUntil(() => js(`Boolean(document.querySelector('[data-ref-name="refs/remotes/origin/integration/demo"]')) && Boolean(document.querySelector('[data-ref-name="refs/tags/demo-tag"]'))`), '历史图显示远端分支和本地标签')
    const graphRemoteCommit = await js(`document.querySelector('[data-ref-name="refs/remotes/origin/integration/demo"]')?.getAttribute('data-ref-commit')`)
    if (graphRemoteCommit !== localCommit) throw new Error('历史图的 origin/integration/demo 与提交不一致')
    await js(`document.querySelector('[data-ref-name="refs/tags/demo-tag"]').click()`)
    await waitUntil(() => js(`document.querySelector('.inspector-heading h2')?.textContent === ${JSON.stringify(COMMIT_MESSAGE)} && document.querySelector('.file-facts code')?.textContent === ${JSON.stringify(localCommit)}`), '历史图标签定位提交')

    const sizes = []
    for (const size of [{ width: 1440, height: 900, name: 'v0610-integration-1440' }, { width: 1024, height: 680, name: 'v0610-integration-1024' }]) {
      window.setContentSize(size.width, size.height)
      await waitUntil(() => js(`window.innerWidth === ${size.width} && window.innerHeight === ${size.height}`), `布局稳定在 ${size.width}×${size.height}`)
      // A window focus can race a silent refresh; re-apply the tag selection
      // before each capture so both screenshots show the located commit.
      await js(`document.querySelector('[data-ref-name="refs/tags/demo-tag"]').click()`)
      await waitUntil(() => js(`document.querySelector('.inspector-heading h2')?.textContent === ${JSON.stringify(COMMIT_MESSAGE)} && document.querySelector('.file-facts code')?.textContent === ${JSON.stringify(localCommit)}`), `标签定位在 ${size.width}×${size.height}`)
      await waitUntil(() => js(`document.querySelector('.context-panel button.secondary-button') && !document.querySelector('.context-panel button.secondary-button').disabled`), '标签详情读取完成')
      await js(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`)
      await js('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      const measured = await js(`(() => {
        const workspace = document.querySelector('#workspace-main')
        return {
          viewport: { width: window.innerWidth, height: window.innerHeight },
          documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          workspaceOverflow: workspace ? workspace.scrollWidth - workspace.clientWidth : null,
          graph: Boolean(document.querySelector('.commit-graph')),
          refs: document.querySelectorAll('.ref-row[data-ref-name]').length,
        }
      })()`)
      const screenshotBytes = await capture(window, size.name)
      sizes.push({ ...measured, screenshotBytes })
    }

    console.log('[V0610-INTEGRATION] ' + JSON.stringify({
      clonePlan,
      repository,
      fixtureFeature: fixture.feature,
      localCommit,
      remoteCommit,
      remoteTracking,
      upstream,
      counts,
      remoteBranches,
      remoteTagsBeforePush,
      remoteTagsAfterPush,
      firstPushCommand,
      firstPushArgv: firstPushRecord?.argv || [],
      graphRemoteCommit,
      tagJump: { tag: 'refs/tags/demo-tag', commit: localCommit },
      sizes,
      screenshots: screenshotRoot,
    }))
    finish(0)
  } catch (error) {
    fail(error)
  }
})
