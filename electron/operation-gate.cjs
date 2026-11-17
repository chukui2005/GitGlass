class OperationGate {
  constructor() { this.active = 0; this.locked = false }

  async run(operation) {
    if (this.locked) throw new Error('正在准备更新，请稍后重试。')
    this.active++
    try { return await operation() } finally { this.active-- }
  }

  acquire() {
    if (this.locked || this.active) throw new Error('Git 操作尚未完成，请完成后再次点击“重启并更新”。')
    this.locked = true
    return () => { this.locked = false }
  }
}

module.exports = { OperationGate }
