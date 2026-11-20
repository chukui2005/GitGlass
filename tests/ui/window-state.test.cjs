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
function expectNear(actual, expected, tolerance = 8) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance)
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
      expectNear(firstPayload.saved.x, TARGET.x, 2)
      expectNear(firstPayload.saved.y, TARGET.y, 2)
      expectNear(firstPayload.saved.width, Math.min(TARGET.width, firstPayload.workArea.width), 2)
      expectNear(firstPayload.saved.height, Math.min(TARGET.height, firstPayload.workArea.height), 2)
      // 第二阶段：同一个 userData 再启动一次，窗口必须以保存的 bounds 出现
      //（±8px 容忍再一次 DIP 取整与系统微调）。
      const second = runElectronProbe('window-state-probe.cjs', {
        marker: MARKER,
        env: { GITGLASS_PROBE_USERDATA: directory, GITGLASS_PROBE_PHASE: 'restore' },
      })
      const secondPayload = markerPayload(second)
      expectNear(secondPayload.bounds.x, firstPayload.saved.x)
      expectNear(secondPayload.bounds.y, firstPayload.saved.y)
      expectNear(secondPayload.bounds.width, firstPayload.saved.width)
      expectNear(secondPayload.bounds.height, firstPayload.saved.height)
    } finally {
      // The child has exited, so Chromium no longer holds the profile files open.
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }, 300_000)
})
