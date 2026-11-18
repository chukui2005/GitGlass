// 体积报告：一条命令打印 Windows 产物、解压目录与 app.asar 的体积构成。
//
// 用法：
//   node scripts/report-size.mjs            # 人类可读表格
//   node scripts/report-size.mjs --json     # 机器可读（CI / 对比脚本用）
//
// 只读 release/，不构建、不联网。先跑 npm run dist:win 再跑本脚本。
// asar 头按 Electron 的 pickle 格式手工解析，避免依赖构建工具链里的 asar 包。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// app.asar 头部格式：8 字节 pickle 头（[payloadSize=4][headerSize]），随后是
// header pickle（[payloadSize][stringLength][JSON]）。偏移量相对 header 结束处。
export function readAsarHeader(archivePath) {
  const descriptor = fs.openSync(archivePath, 'r')
  try {
    const sizeBuffer = Buffer.alloc(8)
    fs.readSync(descriptor, sizeBuffer, 0, 8, 0)
    const headerSize = sizeBuffer.readUInt32LE(4)
    const headerBuffer = Buffer.alloc(headerSize)
    fs.readSync(descriptor, headerBuffer, 0, headerSize, 8)
    const stringLength = headerBuffer.readUInt32LE(4)
    return JSON.parse(headerBuffer.toString('utf8', 8, 8 + stringLength))
  } finally {
    fs.closeSync(descriptor)
  }
}

// 把 asar 头里的文件树摊平成 [路径, 字节数] 列表。目录节点带 files，文件节点带 size。
export function flattenAsarEntries(header, prefix = '', entries = []) {
  for (const [name, entry] of Object.entries(header.files ?? {})) {
    const entryPath = prefix ? `${prefix}/${name}` : name
    if (entry.files) flattenAsarEntries(entry, entryPath, entries)
    else entries.push({ path: entryPath, size: entry.size ?? 0, unpacked: entry.unpacked === true })
  }
  return entries
}

export function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

// 递归统计目录：返回总字节数、文件数，以及每个直接子项的字节数。
export function measureDirectory(directory) {
  const children = []
  let total = 0
  let files = 0
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      const nested = measureDirectory(entryPath)
      total += nested.total
      files += nested.files
      children.push({ name: entry.name, size: nested.total, files: nested.files, directory: true })
    } else {
      const size = fs.statSync(entryPath).size
      total += size
      files += 1
      children.push({ name: entry.name, size, files: 1, directory: false })
    }
  }
  return { total, files, children }
}

// asar 内按顶层目录聚合；node_modules 再按包名聚合（含 @scope/name 两段）。
export function summarizeAsar(entries) {
  const topLevel = new Map()
  const packages = new Map()
  let mapBytes = 0
  let mapCount = 0
  for (const entry of entries) {
    const segments = entry.path.split('/')
    const top = segments[0]
    topLevel.set(top, (topLevel.get(top) ?? 0) + entry.size)
    if (top === 'node_modules' && segments.length > 1) {
      const packageName = segments[1].startsWith('@') ? `${segments[1]}/${segments[2] ?? ''}` : segments[1]
      packages.set(packageName, (packages.get(packageName) ?? 0) + entry.size)
    }
    if (entry.path.endsWith('.map')) {
      mapBytes += entry.size
      mapCount += 1
    }
  }
  const sorted = (map) => [...map.entries()].map(([name, size]) => ({ name, size })).sort((left, right) => right.size - left.size)
  return {
    totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    fileCount: entries.length,
    unpackedCount: entries.filter((entry) => entry.unpacked).length,
    topLevel: sorted(topLevel),
    packages: sorted(packages),
    sourceMapBytes: mapBytes,
    sourceMapCount: mapCount,
  }
}

export function collectSizeReport({ root = rootDirectory } = {}) {
  const releaseDirectory = path.join(root, 'release')
  const unpackedDirectory = path.join(releaseDirectory, 'win-unpacked')
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  if (!fs.existsSync(unpackedDirectory)) {
    throw new Error(`缺少 ${path.relative(root, unpackedDirectory)}，请先执行 npm run dist:win。`)
  }
  const artifacts = fs.existsSync(releaseDirectory)
    ? fs.readdirSync(releaseDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => ({ name: entry.name, size: fs.statSync(path.join(releaseDirectory, entry.name)).size }))
      .sort((left, right) => right.size - left.size)
    : []

  const unpacked = measureDirectory(unpackedDirectory)
  const resources = unpacked.children.find((child) => child.name === 'resources')
  const resourceBreakdown = resources ? measureDirectory(path.join(unpackedDirectory, 'resources')) : { children: [], total: 0 }
  const locales = unpacked.children.find((child) => child.name === 'locales')
  const localeFiles = locales ? fs.readdirSync(path.join(unpackedDirectory, 'locales')) : []

  const asarPath = path.join(unpackedDirectory, 'resources', 'app.asar')
  const asarHeader = fs.existsSync(asarPath) ? readAsarHeader(asarPath) : null
  const asarEntries = asarHeader ? flattenAsarEntries(asarHeader) : []
  const asar = summarizeAsar(asarEntries)
  const asarPackedBytes = fs.existsSync(asarPath) ? fs.statSync(asarPath).size : 0

  // Electron 运行时 = 解压目录里除 app.asar 之外的一切（exe/dll/locales/pak 等）。
  const appBytes = asarPackedBytes
  const runtimeBytes = unpacked.total - appBytes

  return {
    version,
    generatedAt: new Date().toISOString(),
    artifacts,
    unpacked: { total: unpacked.total, files: unpacked.files, children: unpacked.children },
    resources: resourceBreakdown.children,
    locales: { count: localeFiles.length, size: locales?.size ?? 0, names: localeFiles },
    asar: { ...asar, packedBytes: asarPackedBytes, fileCount: asar.fileCount, entries: asarEntries.length },
    split: { runtimeBytes, appBytes, runtimePercent: (runtimeBytes / unpacked.total) * 100 },
  }
}

function printReport(report) {
  const lines = []
  const push = (line = '') => lines.push(line)
  push(`GitGlass ${report.version} 体积报告（${report.generatedAt}）`)
  push('')
  push('== 产物（release/） ==')
  for (const artifact of report.artifacts) push(`  ${artifact.name.padEnd(44)} ${formatBytes(artifact.size).padStart(10)}  ${artifact.size} B`)
  push('')
  push(`== 解压目录（release/win-unpacked） ==  ${formatBytes(report.unpacked.total)} / ${report.unpacked.files} 个文件`)
  const top = [...report.unpacked.children].sort((left, right) => right.size - left.size).slice(0, 15)
  for (const child of top) {
    const share = ((child.size / report.unpacked.total) * 100).toFixed(1)
    push(`  ${`${child.name}${child.directory ? '/' : ''}`.padEnd(34)} ${formatBytes(child.size).padStart(10)}  ${share.padStart(5)}%`)
  }
  push('')
  push('== resources/ ==')
  for (const child of [...report.resources].sort((left, right) => right.size - left.size)) {
    push(`  ${`${child.name}${child.directory ? '/' : ''}`.padEnd(34)} ${formatBytes(child.size).padStart(10)}`)
  }
  push('')
  push(`== locales/ ==  ${report.locales.count} 个语言包，合计 ${formatBytes(report.locales.size)}`)
  push(`  ${report.locales.names.join(', ')}`)
  push('')
  push(`== app.asar 内部 ==  打包后 ${formatBytes(report.asar.packedBytes)}，解包 ${formatBytes(report.asar.totalBytes)} / ${report.asar.fileCount} 个文件`)
  for (const entry of report.asar.topLevel) {
    const share = ((entry.size / report.asar.totalBytes) * 100).toFixed(1)
    push(`  ${entry.name.padEnd(34)} ${formatBytes(entry.size).padStart(10)}  ${share.padStart(5)}%`)
  }
  push('  -- node_modules 前 10 个包 --')
  for (const entry of report.asar.packages.slice(0, 10)) push(`  ${entry.name.padEnd(34)} ${formatBytes(entry.size).padStart(10)}`)
  push('')
  push(`== 归属 ==  Electron 运行时 ${formatBytes(report.split.runtimeBytes)}（${report.split.runtimePercent.toFixed(1)}%），我们的代码与资源（app.asar）${formatBytes(report.split.appBytes)}（${(100 - report.split.runtimePercent).toFixed(1)}%）`)
  return lines.join('\n')
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  try {
    const report = collectSizeReport()
    if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2))
    else console.log(printReport(report))
  } catch (error) {
    console.error(`错误：${error.message}`)
    process.exitCode = 1
  }
}
