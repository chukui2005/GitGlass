import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { flattenAsarEntries, formatBytes, measureDirectory, readAsarHeader, summarizeAsar } from '../../scripts/report-size.mjs'
import { median, readProbeMarks, summarizeRun } from '../../scripts/report-startup.mjs'

const require = createRequire(import.meta.url)
const { createStartupProbe } = require('../../electron/startup-probe.cjs')
const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDirectory, 'package.json'), 'utf8'))
const temporaryDirectories = []

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-size-report-'))
  temporaryDirectories.push(directory)
  return directory
}

// 按 asar 的 pickle 布局拼一个最小归档：8 字节 size 头 + header pickle。
function buildAsarBuffer(header) {
  const headerText = Buffer.from(JSON.stringify(header), 'utf8')
  const headerPickle = Buffer.alloc(8 + headerText.length)
  headerPickle.writeUInt32LE(4 + headerText.length, 0)
  headerPickle.writeUInt32LE(headerText.length, 4)
  headerText.copy(headerPickle, 8)
  const sizePickle = Buffer.alloc(8)
  sizePickle.writeUInt32LE(4, 0)
  sizePickle.writeUInt32LE(headerPickle.length, 4)
  return Buffer.concat([sizePickle, headerPickle])
}

afterEach(() => {
  while (temporaryDirectories.length > 0) fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true })
})

describe('size report', () => {
  it('formats bytes with one decimal and picks the largest unit that fits', () => {
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(119134357)).toBe('113.6 MB')
  })

  it('reads the file tree out of an asar header', () => {
    const header = {
      files: {
        'package.json': { size: 328 },
        electron: { files: { 'main.cjs': { size: 12722 }, 'startup-probe.cjs': { size: 700 } } },
      },
    }
    const archivePath = path.join(temporaryDirectory(), 'app.asar')
    fs.writeFileSync(archivePath, buildAsarBuffer(header))
    expect(readAsarHeader(archivePath)).toEqual(header)
    expect(flattenAsarEntries(readAsarHeader(archivePath))).toEqual([
      { path: 'package.json', size: 328, unpacked: false },
      { path: 'electron/main.cjs', size: 12722, unpacked: false },
      { path: 'electron/startup-probe.cjs', size: 700, unpacked: false },
    ])
  })

  it('aggregates the asar contents by top-level directory and by node_modules package', () => {
    const entries = [
      { path: 'node_modules/@phosphor-icons/react/dist/index.js', size: 15_900_000, unpacked: false },
      { path: 'node_modules/@phosphor-icons/react/dist/index.d.ts', size: 100_000, unpacked: false },
      { path: 'node_modules/react-dom/index.js', size: 7_700_000, unpacked: false },
      { path: 'node_modules/react-dom/index.js.map', size: 900_000, unpacked: false },
      { path: 'dist/assets/index.js', size: 343_000, unpacked: false },
      { path: 'electron/main.cjs', size: 12_722, unpacked: false },
    ]
    const summary = summarizeAsar(entries)
    expect(summary.topLevel.map((entry) => entry.name)).toEqual(['node_modules', 'dist', 'electron'])
    expect(summary.packages[0]).toEqual({ name: '@phosphor-icons/react', size: 16_000_000 })
    expect(summary.packages[1]).toEqual({ name: 'react-dom', size: 8_600_000 })
    expect(summary.sourceMapCount).toBe(1)
    expect(summary.sourceMapBytes).toBe(900_000)
    expect(summary.totalBytes).toBe(24_955_722)
  })

  it('measures a directory recursively, including nested totals', () => {
    const directory = temporaryDirectory()
    fs.mkdirSync(path.join(directory, 'locales'))
    fs.writeFileSync(path.join(directory, 'locales', 'zh-CN.pak'), Buffer.alloc(2048))
    fs.writeFileSync(path.join(directory, 'locales', 'en-US.pak'), Buffer.alloc(1024))
    fs.writeFileSync(path.join(directory, 'GitGlass.exe'), Buffer.alloc(512))
    const measured = measureDirectory(directory)
    expect(measured.total).toBe(3584)
    expect(measured.files).toBe(3)
    const locales = measured.children.find((child) => child.name === 'locales')
    expect(locales).toMatchObject({ size: 3072, files: 2, directory: true })
  })
})

describe('startup report', () => {
  it('takes the median of an even and an odd number of runs', () => {
    expect(median([900, 100, 500])).toBe(500)
    expect(median([900, 100, 500, 700])).toBe(600)
    expect(median([])).toBeNull()
  })

  it('ignores the half-written line a killed process leaves behind', () => {
    const probeFile = path.join(temporaryDirectory(), 'probe.jsonl')
    fs.writeFileSync(probeFile, [
      '{"mark":"whenReady","ms":309}',
      '{"mark":"ready-to-show","ms":1100,"memory":[{"type":"Tab","workingSetKb":81744}]}',
      '{"mark":"trunc',
      '',
    ].join('\n'))
    const marks = readProbeMarks(probeFile)
    expect(marks.map((mark) => mark.mark)).toEqual(['whenReady', 'ready-to-show'])
    expect(readProbeMarks(path.join(temporaryDirectory(), 'missing.jsonl'))).toEqual([])
  })

  it('splits a run into bootstrap, updater, window and paint phases', () => {
    const summary = summarizeRun({
      totalMs: 1500,
      peakMemoryKb: 200_000,
      marks: [
        { mark: 'whenReady', ms: 300 },
        { mark: 'updates-ready', ms: 620 },
        { mark: 'window-created', ms: 700 },
        { mark: 'ready-to-show', ms: 1100, memory: [{ type: 'Tab', workingSetKb: 81_744 }] },
      ],
    })
    expect(summary.bootstrapMs).toBe(400)
    expect(summary.updaterMs).toBe(320)
    expect(summary.windowMs).toBe(80)
    expect(summary.paintMs).toBe(400)
    expect(summary.phases['ready-to-show']).toBe(1100)
    expect(summary.memory).toEqual([{ type: 'Tab', workingSetKb: 81_744 }])
    expect(summary.peakMemoryKb).toBe(200_000)
  })

  it('keeps the probe inert unless GITGLASS_STARTUP_PROBE names a file', () => {
    const noop = createStartupProbe(null)
    expect(noop('whenReady')).toBeUndefined()

    const probeFile = path.join(temporaryDirectory(), 'probe.jsonl')
    const probe = createStartupProbe(probeFile, Date.now())
    probe('whenReady')
    probe('ready-to-show', { memory: [{ type: 'Browser', workingSetKb: 133_252 }] })
    const lines = fs.readFileSync(probeFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(lines.map((line) => line.mark)).toEqual(['whenReady', 'ready-to-show'])
    expect(lines[1].memory).toEqual([{ type: 'Browser', workingSetKb: 133_252 }])

    // 写不进去时也不能抛：探针永远不能影响应用启动。
    expect(() => createStartupProbe(path.join(probeFile, 'nested', 'never.jsonl'))('whenReady')).not.toThrow()
  })
})

describe('measurement entry points', () => {
  it('exposes one command per measurement and documents the baseline', () => {
    expect(packageJson.scripts['report:size']).toBe('node scripts/report-size.mjs')
    expect(packageJson.scripts['report:startup']).toBe('node scripts/report-startup.mjs')
    const document = fs.readFileSync(path.join(rootDirectory, 'docs', 'size-and-performance.md'), 'utf8')
    expect(document).toContain('npm run report:size')
    expect(document).toContain('npm run report:startup')
  })

  it('keeps the size-related build switches explicit', () => {
    // 两个 locale 之外的语言包没有任何界面使用（界面只有中文），留着纯属浪费 47 MB。
    expect(packageJson.build.electronLanguages).toEqual(['zh-CN', 'en-US'])
    // 渲染层的依赖由 Vite 打进 dist/，node_modules 里的副本是死重量。
    expect(packageJson.build.files).toEqual(expect.arrayContaining([
      '!node_modules/@phosphor-icons/**',
      '!node_modules/react/**',
      '!node_modules/react-dom/**',
      '!node_modules/scheduler/**',
      '!**/*.map',
    ]))
  })
})
