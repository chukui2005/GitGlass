const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// #12 / #18：对 npm run dist:win 的真实产物（release/win-unpacked/GitGlass.exe）做一次
// 外壳冒烟。探针窗口复刻不了 titleBarOverlay / exe 图标 / 菜单移除（conventions 第 4 节），
// 唯一可信的证据来自打包进程本身：主进程在 GITGLASS_STARTUP_PROBE 开启时把 shell-facts
// 写进探针文件（electron/main.cjs），本文件启动产物、等探针、断言、杀进程树。
// CI 的 Quality job 在 dist:win 之后单独跑本文件；本地没有产物时跳过（先 npm run dist:win）。
const ROOT = path.join(__dirname, '..', '..')
const EXE = path.join(ROOT, 'release', 'win-unpacked', 'GitGlass.exe')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function killTree(pid) {
  return new Promise((resolve) => {
    const { execFile } = require('node:child_process')
    if (process.platform === 'win32') execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => resolve())
    else { try { process.kill(-pid, 'SIGKILL') } catch { /* 已退出 */ } resolve() }
  })
}

// 与 scripts/report-startup.mjs 的 readProbeMarks 相同的容错解析（JSON Lines，半行跳过）。
function readProbeMarks(file) {
  if (!fs.existsSync(file)) return []
  const marks = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim().startsWith('{')) continue
    try {
      const parsed = JSON.parse(line)
      if (typeof parsed?.mark === 'string' && Number.isFinite(parsed?.ms)) marks.push(parsed)
    } catch { /* 半行写入，跳过 */ }
  }
  return marks
}

function launchPackagedShell() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-shell-'))
  const probeFile = path.join(sandbox, 'probe.jsonl')
  const userData = path.join(sandbox, 'user-data')
  // --user-data-dir 让 Electron 的 userData 指向临时目录：不撞维护者正在运行的应用的
  // 单实例锁，也不读真实的最近仓库（scripts/report-startup.mjs 同款做法）。
  const child = spawn(EXE, [`--user-data-dir=${userData}`], {
    env: (() => {
      const environment = { ...process.env, GITGLASS_STARTUP_PROBE: probeFile }
      // ELECTRON_RUN_AS_NODE 会让打包产物以纯 Node 启动（probe-runner 的铁律同款处理）。
      delete environment.ELECTRON_RUN_AS_NODE
      return environment
    })(),
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  })
  return { child, probeFile, sandbox }
}

describe('packaged shell smoke test (release/win-unpacked/GitGlass.exe)', () => {
  const exeAvailable = fs.existsSync(EXE)

  it('launches the real packaged shell: GitGlass exe, packaged version, hidden title bar with a visible overlay and no native menu', async () => {
    if (!exeAvailable) {
      console.warn('跳过外壳冒烟：缺少 release/win-unpacked/GitGlass.exe（先 npm run dist:win；CI 在 dist:win 之后单独跑本文件）')
      return
    }
    const expectedVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
    const { child, probeFile, sandbox } = launchPackagedShell()
    try {
      const startedAt = Date.now()
      let shell = null
      while (Date.now() - startedAt < 60_000) {
        const marks = readProbeMarks(probeFile)
        shell = marks.find((mark) => mark.mark === 'shell-facts')?.shell ?? null
        if (shell) break
        const failure = marks.find((mark) => mark.mark === 'shell-facts-error')
        if (failure) throw new Error(`主进程探针在打包产物上失败：${failure.error}`)
        if (child.exitCode !== null) throw new Error(`打包进程提前退出（code=${child.exitCode}），没有产出 shell-facts 探针。`)
        await sleep(50)
      }
      if (!shell) throw new Error('60s 内没有等到 shell-facts 探针，确认产物包含 electron/startup-probe.cjs 且设置了 GITGLASS_STARTUP_PROBE。')
      // exe 是 GitGlass 而不是 electron：productName 与图标都由 electron-builder 打进产物。
      expect(shell.exeName).toBe('GitGlass.exe')
      expect(shell.isPackaged).toBe(true)
      expect(shell.version).toBe(expectedVersion)
      // win32 上原生菜单必须已移除；titleBarStyle=hidden 且渲染层确认 Overlay 可见（自绘 48px 标题栏）。
      expect(shell.hasApplicationMenu).toBe(false)
      expect(shell.titleBarStyle).toBe('hidden')
      expect(shell.overlayVisible).toBe(true)
    } finally {
      await killTree(child.pid)
      try { child.kill('SIGKILL') } catch { /* 已退出 */ }
      await sleep(150)
      try { fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch { /* 留给系统清理临时目录 */ }
    }
  }, 120_000)
})
