const fs = require('node:fs')
const path = require('node:path')

/**
 * Remembers the repositories a maintainer opened, so launching GitGlass opens
 * the last one instead of asking for a folder every time.
 *
 * The file only ever contains local paths: no repository content, no remotes
 * and no credentials. A damaged or missing file must never stop launch.
 */
class RecentRepositories {
  constructor(file, { limit = 5 } = {}) {
    this.file = file
    this.limit = Math.max(1, limit)
    this.value = this.load()
  }

  load() {
    try {
      if (fs.statSync(this.file).size > 64 * 1024) return []
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (!Array.isArray(saved?.paths)) return []
      return saved.paths
        .filter((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 4096 && !entry.includes('\0'))
        .slice(0, this.limit)
    } catch {
      // A missing or damaged list is not an error worth reporting to the user.
      return []
    }
  }

  list() { return [...this.value] }

  remember(repositoryPath) {
    if (typeof repositoryPath !== 'string' || !repositoryPath) return this.list()
    const normalized = path.resolve(repositoryPath)
    const next = [normalized, ...this.value.filter((entry) => entry !== normalized)].slice(0, this.limit)
    this.save(next)
    return this.list()
  }

  forget(repositoryPath) {
    const normalized = path.resolve(repositoryPath)
    const next = this.value.filter((entry) => entry !== normalized)
    if (next.length !== this.value.length) this.save(next)
    return this.list()
  }

  save(paths) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp`
    fs.writeFileSync(temporary, JSON.stringify({ paths }), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporary, this.file)
    this.value = [...paths]
  }
}

/**
 * IPC shape for the switcher: a path, the folder name shown as the title and
 * whether the folder still exists. Existence is recomputed on every call, so a
 * repository deleted outside GitGlass is reported instead of being opened.
 */
function describeRecent(paths, exists = fs.existsSync) {
  return (Array.isArray(paths) ? paths : []).map((entry) => {
    let present = false
    try {
      present = exists(entry)
    } catch {
      // A path we cannot stat is reported as missing rather than crashing the list.
    }
    return { path: entry, name: path.basename(entry) || entry, exists: present }
  })
}

module.exports = { RecentRepositories, describeRecent }
