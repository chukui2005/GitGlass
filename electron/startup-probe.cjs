// 启动探针：仅当环境变量 GITGLASS_STARTUP_PROBE 指向一个文件路径时生效，
// 把启动各阶段的时间戳与内存指标以 JSON Lines 追加写入该文件。
// 唯一消费者是 scripts/report-startup.mjs；变量未设置时返回空函数，
// 打包结果与正常运行路径完全不受影响。
const fs = require('node:fs')

function createStartupProbe(file = process.env.GITGLASS_STARTUP_PROBE, startedAt = Date.now()) {
  if (!file) return () => {}
  return (mark, extra = {}) => {
    try {
      fs.appendFileSync(file, `${JSON.stringify({ mark, ms: Date.now() - startedAt, ...extra })}\n`)
    } catch {
      // 探针写不进去也绝不能影响应用启动。
    }
  }
}

module.exports = { createStartupProbe }
