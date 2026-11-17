const fs = require('node:fs')
const path = require('node:path')

// Only update preferences, verified package metadata and the update restart draft.
// No repository content or credentials are sent to the release provider.
class UpdateStore {
  constructor(file) {
    this.file = file
    this.value = { automatic: true, pending: null, resume: null }
    try {
      if (fs.statSync(file).size > 512 * 1024) return
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (typeof saved.automatic === 'boolean') this.value.automatic = saved.automatic
      if (saved.pending && typeof saved.pending === 'object') this.value.pending = saved.pending
      if (saved.resume && typeof saved.resume === 'object') this.value.resume = saved.resume
    } catch { /* A missing or damaged preferences file must not stop launch. */ }
  }

  save(patch) {
    const next = { ...this.value, ...patch }
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporary, this.file)
    this.value = next
  }
}

module.exports = { UpdateStore }
