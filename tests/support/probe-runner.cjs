// 以 Electron 主进程方式运行探针脚本的统一入口。
//
// 两个动机：
// 1. 探针偶尔整进程退出。负载高时 Chromium 的 GPU / utility 子进程会崩，日志里只有一行
//    `GPU process exited unexpectedly`，stdout 里也就没有标记行，测试于是报出
//    "expected undefined to be truthy" 这种与被测代码无关的失败（0.6.5 发版 CI 撞过一次）。
// 2. 探针加载的是 `dist/`，所以好几个测试会先跑一次 `vite build`。Windows 上 Electron
//    退出后偶尔还占着 `dist/` 的句柄，嵌套 build 会以 EBUSY 失败。
//
// 探针是子进程，这两类失败重跑一次即可；这里统一重试，并把退出码与 stderr 尾巴写进错误
// 信息，免得下次只看到一句断言失败。
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const electronPath = require('electron')

const ROOT = path.join(__dirname, '..', '..')
const ATTEMPTS = 3
const PROBE_TIMEOUT_MS = 90_000

function tail(text, limit = 400) {
  const value = String(text || '').trim()
  return value.length > limit ? `…${value.slice(-limit)}` : value
}

function probePath(fileName) {
  return path.join(__dirname, fileName)
}

function describeFailure(attempt, error) {
  const stderr = error && error.stderr ? `；stderr=${tail(error.stderr)}` : ''
  return `第 ${attempt} 次：${error && error.message ? error.message : String(error)}${stderr}`
}

/**
 * 跑一个探针并返回它的完整 stdout，前提是输出里出现了 `marker`。
 *
 * @param {string} fileName `tests/support` 下的探针文件名
 * @param {{ marker: string, env?: Record<string, string> }} options
 * @returns {string} 探针的 stdout
 */
function runElectronProbe(fileName, { marker, env = {} } = {}) {
  const failures = []
  // ELECTRON_RUN_AS_NODE 会让 electron 以纯 Node 启动，探针拿不到 app / BrowserWindow。
  const environment = { ...process.env, ...env }
  delete environment.ELECTRON_RUN_AS_NODE
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const stdout = execFileSync(electronPath, [probePath(fileName)], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
        env: environment,
      })
      if (!marker || stdout.includes(marker)) return stdout
      failures.push(`第 ${attempt} 次：没有输出 ${marker}；stdout=${tail(stdout)}`)
    } catch (error) {
      failures.push(describeFailure(attempt, error))
    }
  }
  throw new Error(`探针 ${fileName} 连续 ${ATTEMPTS} 次没有给出结果：\n${failures.join('\n')}`)
}

/**
 * 取回探针打印的某个标记行，返回标记之后的文本（通常是 JSON）。
 *
 * @param {string} fileName `tests/support` 下的探针文件名
 * @param {string} marker 标记前缀，例如 `'[LAYOUT] '`
 * @param {{ env?: Record<string, string> }} [options]
 * @returns {string}
 */
function runProbe(fileName, marker, { env } = {}) {
  const output = runElectronProbe(fileName, { marker, env })
  const line = output.split(/\r?\n/).find((entry) => entry.startsWith(marker))
  return line.slice(marker.length)
}

/**
 * 用当前源码构建一次 `dist/`，失败时重试（Windows 上 Electron 句柄未释放会导致 EBUSY）。
 * 真正的编译错误每次都会失败，并在错误里带上编译器输出。
 *
 * @param {string} [root] 仓库根目录
 */
function buildApplication(root = ROOT) {
  const failures = []
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      execFileSync(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
        cwd: root,
        env: { ...process.env, NODE_ENV: 'production' },
        windowsHide: true,
        timeout: PROBE_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return
    } catch (error) {
      failures.push(describeFailure(attempt, error))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
    }
  }
  throw new Error(`vite build 连续 ${ATTEMPTS} 次失败：\n${failures.join('\n')}`)
}

module.exports = { runElectronProbe, runProbe, buildApplication }
