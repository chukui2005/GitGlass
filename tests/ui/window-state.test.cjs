const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { runElectronProbe } = require(path.join(__dirname, '..', 'support', 'probe-runner.cjs'))

const MARKER = '[WINDOW-STATE] '
const TARGET = { x: 120, y: 80, width: 1100, height: 700 }

function markerPayload(output) {
  const line = output.split(/\r?\n/).find((entry) => entry.startsWith(MARKER))
  return JSON.parse(line.slice(MARKER.length))
}

// Windows 的 DIP 往返有 ±1px 取整抖动（如 150% 缩放下 setBounds(1100) 回读 1101），
// 真窗口的断言全部用容差；精确语义由 tests/unit/window-state.test.cjs 覆盖。
function expectNear(actual, expected, tolerance = 8, label = '') {
  const context = label ? `（${label}）` : `（actual=${actual}, expected=${expected}）`
  // actual 为 undefined / NaN 时 Math.abs 得 NaN，容差断言必然失败并带上 context。
  expect(Math.abs(actual - expected), context).toBeLessThanOrEqual(tolerance)
}

describe('window bounds persistence in the real Electron main process', () => {
  it('launches inside the work area, saves the resized bounds on close and restores them on the next launch', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-window-state-'))
    try {
      // 第一阶段：默认尺寸不得超出主屏工作区（#19 ②）；改成固定矩形后关窗必须落盘。
      // 目标矩形会被夹紧到工作区（1100×700 不小于 minWidth/minHeight），所以
      // saved.width / saved.height 一定等于 min(目标, 工作区)。
      const first = runElectronProbe('window-state-probe.cjs', {
        marker: MARKER,
        env: { GITGLASS_PROBE_USERDATA: directory, GITGLASS_PROBE_PHASE: 'save' },
      })
      const firstPayload = markerPayload(first)
      expect(firstPayload.initial.width).toBeLessThanOrEqual(firstPayload.workArea.width)
      expect(firstPayload.initial.height).toBeLessThanOrEqual(firstPayload.workArea.height)
      expect(firstPayload.target).toEqual(TARGET)
      // 关窗落盘的是真实 bounds（close 时的权威读取），与 setBounds 的目标一致，
      // ±4 容忍 DIP 取整。落盘不做工作区夹紧——夹紧发生在下一次启动的
      // resolveLaunchBounds（CI runner 的工作区只有 1024 宽，正好在第二阶段验证）。
      const savedLabel = `saved=${JSON.stringify(firstPayload.saved)}, workArea=${JSON.stringify(firstPayload.workArea)}`
      expectNear(firstPayload.saved.x, TARGET.x, 4, savedLabel)
      expectNear(firstPayload.saved.y, TARGET.y, 4, savedLabel)
      expectNear(firstPayload.saved.width, TARGET.width, 4, savedLabel)
      expectNear(firstPayload.saved.height, TARGET.height, 4, savedLabel)
      // 第二阶段：同一个 userData 再启动一次，窗口必须以保存的 bounds 出现
      //（±8px 容忍再一次 DIP 取整与系统微调）。
      const second = runElectronProbe('window-state-probe.cjs', {
        marker: MARKER,
        env: { GITGLASS_PROBE_USERDATA: directory, GITGLASS_PROBE_PHASE: 'restore' },
      })
      const secondPayload = markerPayload(second)
      // 恢复时 resolveLaunchBounds 把尺寸夹紧到目标显示器工作区（min(saved, workArea)），
      // 位置保持不动；±8 容忍再一次 DIP 取整与系统微调。
      const restoredLabel = `restored=${JSON.stringify(secondPayload.bounds)}, saved=${JSON.stringify(firstPayload.saved)}, workArea=${JSON.stringify(secondPayload.workArea)}`
      expectNear(secondPayload.bounds.x, firstPayload.saved.x, 8, restoredLabel)
      expectNear(secondPayload.bounds.y, firstPayload.saved.y, 8, restoredLabel)
      expectNear(secondPayload.bounds.width, Math.min(firstPayload.saved.width, secondPayload.workArea.width), 8, restoredLabel)
      expectNear(secondPayload.bounds.height, Math.min(firstPayload.saved.height, secondPayload.workArea.height), 8, restoredLabel)
    } finally {
      // The child has exited, so Chromium no longer holds the profile files open.
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }, 300_000)
})
