// 启动报告：重复启动打包后的 GitGlass，测「进程启动 → 窗口可显示」的毫秒数与内存占用。
//
// 用法：
//   node scripts/report-startup.mjs                 # 3 次取中位数，人类可读
//   node scripts/report-startup.mjs --runs=5        # 自定义次数
//   node scripts/report-startup.mjs --json          # 机器可读
//
// 计时来源有两层，互不干扰：
//   1. 外部墙钟：spawn 到探针文件出现「渲染层就绪」行的时间差（含 Electron 自身引导）；
//   2. 进程内探针：electron/startup-probe.cjs 在 GITGLASS_STARTUP_PROBE 存在时把各阶段
//      时间戳与 app.getAppMetrics() 写进同一个文件，用于把总耗时拆成阶段。
// 「渲染层就绪」优先取 ready-to-show（窗口可显示首帧），没等到就退到 did-finish-load。
// 每次运行都用一个临时 --user-data-dir，跑完杀掉整棵进程树，不碰用户真实数据。

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_EXE = path.join(rootDirectory, 'release', 'win-unpacked', 'GitGlass.exe')
const PHASE_MARKS = ['whenReady', 'updates-ready', 'window-created', 'did-finish-load', 'ready-to-show']
const READY_MARKS = ['ready-to-show', 'did-finish-load']

export function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  if (sorted.length === 0) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle]
}

// 探针以 JSON Lines 追加写入；进程被杀时最后一行可能不完整，这里逐行容错解析。
export function readProbeMarks(file) {
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

export function summarizeRun({ totalMs, marks, peakMemoryKb }) {
  const byMark = Object.fromEntries(marks.map((mark) => [mark.mark, mark.ms]))
  // 主指标：优先 ready-to-show（首帧可显示），没等到就退到 did-finish-load。
  const readyMark = READY_MARKS.find((name) => name in byMark) ?? null
  const readyAt = readyMark === null ? null : byMark[readyMark]
  const memory = marks.find((mark) => READY_MARKS.includes(mark.mark) && mark.memory)?.memory ?? null
  return {
    totalMs,
    readyMark,
    bootstrapMs: readyAt === null ? null : totalMs - readyAt,
    phases: Object.fromEntries(PHASE_MARKS.filter((name) => name in byMark).map((name) => [name, byMark[name]])),
    updaterMs: 'updates-ready' in byMark && 'whenReady' in byMark ? byMark['updates-ready'] - byMark['whenReady'] : null,
    windowMs: 'window-created' in byMark && 'updates-ready' in byMark ? byMark['window-created'] - byMark['updates-ready'] : null,
    paintMs: readyAt !== null && 'window-created' in byMark ? readyAt - byMark['window-created'] : null,
    memory,
    peakMemoryKb,
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => resolve())
    else { try { process.kill(-pid, 'SIGKILL') } catch { /* 已退出 */ } resolve() }
  })
}

async function runOnce({ exe, timeoutMs, warmUp }) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-startup-'))
  const probeFile = path.join(sandbox, 'probe.jsonl')
  const userData = path.join(sandbox, 'user-data')
  const { spawn } = await import('node:child_process')
  const child = spawn(exe, [`--user-data-dir=${userData}`], {
    env: { ...process.env, GITGLASS_STARTUP_PROBE: probeFile, ELECTRON_ENABLE_LOGGING: '' },
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  })
  const startedAt = Date.now()
  let marks = []
  let detectedAt = null
  while (Date.now() - startedAt < timeoutMs) {
    marks = readProbeMarks(probeFile)
    if (marks.some((mark) => READY_MARKS.includes(mark.mark))) { detectedAt = Date.now(); break }
    if (child.exitCode !== null) break
    await sleep(10)
  }
  // 再给第二个就绪标记 300ms：ready-to-show 与 did-finish-load 先后不定，两个都记下来。
  if (detectedAt !== null) {
    const graceUntil = Date.now() + 300
    while (Date.now() < graceUntil) {
      const current = readProbeMarks(probeFile)
      if (READY_MARKS.every((name) => current.some((mark) => mark.mark === name))) { marks = current; break }
      marks = current
      await sleep(20)
    }
  }
  const peakMemoryKb = await readPeakMemoryKb(child.pid)
  await killTree(child.pid)
  try { child.kill('SIGKILL') } catch { /* 已退出 */ }
  // Chromium 的子进程刚被杀时还握着 user-data 里的句柄，删不掉不是错误，重试几次即可。
  await sleep(150)
  try { fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch { /* 留给系统清理临时目录 */ }
  if (detectedAt === null) {
    throw new Error(`未在 ${timeoutMs}ms 内等到 ${READY_MARKS.join('/')} 探针，确认构建包含 electron/startup-probe.cjs 且设置了 GITGLASS_STARTUP_PROBE。`)
  }
  return summarizeRun({ totalMs: detectedAt - startedAt, marks, peakMemoryKb, warmUp })
}

// 峰值工作集来自系统进程表：探针只在 ready-to-show 抓一次 app.getAppMetrics()。
function readPeakMemoryKb(pid) {
  if (process.platform !== 'win32') return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).PeakWorkingSet64`], (error, stdout) => {
      const value = Number.parseInt(String(stdout).trim(), 10)
      resolve(error || !Number.isFinite(value) ? null : Math.round(value / 1024))
    })
  })
}

export async function collectStartupReport({ exe = DEFAULT_EXE, runs = 3, timeoutMs = 60_000, installed = false } = {}) {
  if (!fs.existsSync(exe)) throw new Error(`缺少 ${path.relative(rootDirectory, exe)}，请先执行 npm run dist:win。`)
  // win-unpacked 里没有 NSIS 安装时写入的 gitglass-installed 标记，主进程据此把更新服务
  // 判成“不支持”并跳过 electron-updater 的加载。--installed 临时补上这个标记，
  // 用来测安装版真实的启动代价（含 require('electron-updater')），跑完再删掉。
  const installedMarker = path.join(path.dirname(exe), 'resources', 'gitglass-installed')
  const createdMarker = installed && !fs.existsSync(installedMarker)
  if (createdMarker) fs.writeFileSync(installedMarker, '')
  const samples = []
  try {
    for (let index = 0; index < runs; index += 1) {
      // 第一次运行同时充当即刻的预热：Chromium 会把首次启动的磁盘缓存写进临时目录，
      // 因此第一次的数据只记录、不参与中位数之外的解读。
      samples.push(await runOnce({ exe, timeoutMs, warmUp: index === 0 }))
    }
  } finally {
    if (createdMarker) fs.rmSync(installedMarker, { force: true })
  }
  const pick = (key) => median(samples.map((sample) => sample[key]).filter((value) => Number.isFinite(value)))
  const phaseKeys = [...new Set(samples.flatMap((sample) => Object.keys(sample.phases)))]
  const memoryTypes = [...new Set(samples.flatMap((sample) => (sample.memory ?? []).map((entry) => entry.type)))]
  const readyMark = READY_MARKS.find((name) => samples.every((sample) => sample.readyMark === name))
    ?? samples.map((sample) => sample.readyMark).find(Boolean) ?? null
  return {
    exe: path.relative(rootDirectory, exe),
    generatedAt: new Date().toISOString(),
    runs,
    installed,
    samples,
    median: {
      readyMark,
      totalMs: pick('totalMs'),
      bootstrapMs: pick('bootstrapMs'),
      updaterMs: pick('updaterMs'),
      windowMs: pick('windowMs'),
      paintMs: pick('paintMs'),
      peakMemoryKb: pick('peakMemoryKb'),
      phases: Object.fromEntries(phaseKeys.map((key) => [key, median(samples.map((sample) => sample.phases[key]).filter((value) => Number.isFinite(value)))])),
      memory: Object.fromEntries(memoryTypes.map((type) => [
        type,
        median(samples.flatMap((sample) => (sample.memory ?? []).filter((entry) => entry.type === type).map((entry) => entry.workingSetKb))),
      ])),
    },
  }
}

function printReport(report) {
  const lines = []
  const push = (line = '') => lines.push(line)
  const mb = (kb) => (kb === null || kb === undefined ? '—' : `${(kb / 1024).toFixed(1)} MB`)
  push(`GitGlass 启动报告（${report.generatedAt}，${report.runs} 次取中位数）`)
  push(`可执行文件：${report.exe}${report.installed ? '（模拟安装版：更新服务已启用）' : '（未安装：更新服务按“不支持”跳过）'}`)
  push('')
  push('== 每次运行 ==')
  push(`  ${'次数'.padEnd(6)}${'总耗时'.padStart(10)}${'引导'.padStart(10)}${'更新服务'.padStart(12)}${'建窗'.padStart(10)}${'首帧'.padStart(10)}${'峰值内存'.padStart(12)}  就绪信号`)
  report.samples.forEach((sample, index) => {
    push(`  ${`#${index + 1}`.padEnd(6)}${`${sample.totalMs}ms`.padStart(10)}${`${sample.bootstrapMs}ms`.padStart(10)}${`${sample.updaterMs ?? '—'}ms`.padStart(12)}${`${sample.windowMs ?? '—'}ms`.padStart(10)}${`${sample.paintMs ?? '—'}ms`.padStart(10)}${mb(sample.peakMemoryKb).padStart(12)}  ${sample.readyMark ?? '—'}`)
  })
  const med = report.median
  push('')
  push('== 中位数 ==')
  push(`  进程启动 → 渲染层就绪（${med.readyMark ?? '未观测到'}）：${med.totalMs} ms`)
  push(`  其中 Electron 引导（main.cjs 之前）：${med.bootstrapMs} ms`)
  push(`  其中更新服务初始化（app.whenReady → updates.initialize 完成）：${med.updaterMs ?? '—'} ms`)
  push(`  其中建窗（updates-ready → new BrowserWindow）：${med.windowMs ?? '—'} ms`)
  push(`  其中首屏（window-created → 渲染层就绪）：${med.paintMs ?? '—'} ms`)
  const observed = Object.entries(med.phases)
  if (observed.length > 0) push(`  阶段时间戳（相对 main.cjs 载入）：${observed.map(([name, ms]) => `${name}=${ms}ms`).join('，')}`)
  push('')
  push('== 内存（app.getAppMetrics，渲染层就绪时刻） ==')
  for (const [type, kb] of Object.entries(med.memory)) push(`  ${type.padEnd(10)} ${mb(kb)}`)
  push(`  主进程峰值工作集：${mb(med.peakMemoryKb)}`)
  return lines.join('\n')
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const runsArgument = process.argv.find((argument) => argument.startsWith('--runs='))
  const runs = runsArgument ? Number.parseInt(runsArgument.split('=')[1], 10) : 3
  try {
    const report = await collectStartupReport({
      runs: Number.isFinite(runs) && runs > 0 ? runs : 3,
      installed: process.argv.includes('--installed'),
    })
    if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2))
    else console.log(printReport(report))
  } catch (error) {
    console.error(`错误：${error.message}`)
    process.exitCode = 1
  }
}
