const { EventEmitter } = require('node:events')
const semver = require('semver')

const HOURLY = 60 * 60 * 1000
const SHA512 = /^[A-Za-z0-9+/]{86}==$/

function releaseNotes(value) {
  if (typeof value === 'string') return value.slice(0, 32000)
  if (Array.isArray(value)) return value.map((entry) => `${entry.version || ''}\n${typeof entry.note === 'string' ? entry.note : ''}`).join('\n\n').slice(0, 32000)
  return ''
}

function validateUpdate(info, currentVersion) {
  if (!info || !semver.valid(info.version) || !semver.gt(info.version, currentVersion)) return false
  const nextPre = semver.prerelease(info.version)
  const currentPre = semver.prerelease(currentVersion)
  if (nextPre && (!currentPre || nextPre[0] !== 'beta')) return false
  const name = `GitGlass-Setup-${info.version}-x64.exe`
  if (!Array.isArray(info.files) || info.files.length !== 1) throw new Error('更新清单无效，请稍后重试。')
  const file = info.files.find((entry) => entry.url === name || entry.url === `https://github.com/chukui2005/GitGlass/releases/download/v${info.version}/${name}`)
  if (!file || !SHA512.test(file.sha512)) throw new Error('更新清单无效，请稍后重试。')
  return file
}

class UpdateService extends EventEmitter {
  constructor({ updater, store, version, supported, reason = '', gate, saveSession, clearSession, setTimer = setTimeout, clearTimer = clearTimeout }) {
    super()
    Object.assign(this, { updater, store, version, gate, saveSession, clearSession, setTimer, clearTimer })
    this.state = { supported, reason, currentVersion: version, channel: semver.prerelease(version) ? 'beta' : 'stable', automatic: store.value.automatic, phase: supported ? 'idle' : 'unsupported', latestVersion: null, notes: '', progress: null, error: '' }
    this.pending = null
    this.checking = null
    this.downloading = null
    this.timer = null
    this.disposed = false
    this.onProgress = (progress) => {
      if (this.state.phase === 'downloading') this.change({ progress: Math.max(0, Math.min(100, Number(progress.percent) || 0)) })
    }
    // Promise rejections are handled at the request boundary; consume the
    // library's EventEmitter error too so it cannot crash the main process.
    this.onError = () => {}
    if (updater) {
      updater.autoDownload = false
      updater.autoInstallOnAppQuit = false
      updater.allowPrerelease = this.state.channel === 'beta'
      updater.allowDowngrade = false
      updater.disableWebInstaller = true
      updater.on('download-progress', this.onProgress)
      updater.on('error', this.onError)
    }
  }

  getState() { return { ...this.state } }
  change(patch) { Object.assign(this.state, patch); this.emit('state', this.getState()) }

  async initialize() {
    if (!this.state.supported) return
    const cached = this.store.value.pending
    if (cached) {
      try {
        if (!validateUpdate(cached.updateInfo, this.version)) throw new Error('更新缓存已过期。')
        await this.updater.restore(cached)
        this.pending = cached
        this.change({ phase: 'ready', latestVersion: cached.updateInfo.version, notes: releaseNotes(cached.updateInfo.releaseNotes) })
      } catch {
        await this.updater.discard().catch(() => {})
        try { this.store.save({ pending: null }) }
        catch (error) { this.change({ error: updateError(error) }) }
      }
    }
    this.schedule(10_000)
  }

  schedule(delay = HOURLY) {
    if (this.timer) this.clearTimer(this.timer)
    this.timer = null
    if (this.disposed || !this.state.supported || !this.state.automatic) return
    this.timer = this.setTimer(() => {
      this.timer = null
      void this.check().finally(() => this.schedule())
    }, delay)
    this.timer?.unref?.()
  }

  setAutomatic(value) {
    if (typeof value !== 'boolean') throw new Error('更新设置无效。')
    if (this.state.phase === 'installing') return this.getState()
    this.store.save({ automatic: value })
    this.change({ automatic: value })
    // An in-flight download may finish and remain cached; never installs itself.
    this.schedule(value ? 1000 : HOURLY)
    return this.getState()
  }

  async check() {
    if (!this.state.supported || this.disposed || this.state.phase === 'installing') return this.getState()
    if (this.checking) return this.checking
    if (this.downloading) return this.downloading
    this.checking = this.performCheck()
    try { return await this.checking } finally { this.checking = null }
  }

  async performCheck() {
    this.change({ phase: this.pending ? 'ready' : 'checking', error: '' })
    try {
      const result = await this.updater.checkForUpdates()
      if (this.disposed) return this.getState()
      const info = result?.updateInfo
      if (!info || !validateUpdate(info, this.version)) {
        if (!this.pending) this.availableInfo = null
        this.change({ phase: this.pending ? 'ready' : 'current', ...(!this.pending ? { latestVersion: null, notes: '', progress: null } : {}) })
      } else if (!this.pending || semver.gt(info.version, this.pending.updateInfo.version)) {
        this.availableInfo = info
        this.change({ phase: this.pending ? 'ready' : 'available', latestVersion: this.pending?.updateInfo.version || info.version, notes: this.pending ? this.state.notes : releaseNotes(info.releaseNotes) })
        if (this.state.automatic && !this.pending) await this.download()
      }
    } catch (error) {
      this.change({ phase: this.pending ? 'ready' : 'error', error: updateError(error) })
    }
    return this.getState()
  }

  async download() {
    if (!this.state.supported || this.disposed || this.pending || !this.availableInfo || this.state.phase === 'installing') return this.getState()
    if (this.downloading) return this.downloading
    this.downloading = this.performDownload()
    try { return await this.downloading } finally { this.downloading = null }
  }

  async performDownload() {
    this.change({ phase: 'downloading', progress: 0, error: '' })
    try {
      await this.updater.downloadUpdate()
      const snapshot = await this.updater.snapshot()
      if (!validateUpdate(snapshot.updateInfo, this.version) || snapshot.updateInfo.version !== this.availableInfo.version) throw new Error('更新版本已变化，请重新检查更新。')
      // Re-hash immediately before offering installation, including cache hits.
      try { await this.updater.restore(snapshot) }
      catch (error) { await this.updater.discard().catch(() => {}); throw error }
      this.store.save({ pending: snapshot })
      this.pending = snapshot
      this.change({ phase: 'ready', progress: 100, latestVersion: snapshot.updateInfo.version, notes: releaseNotes(snapshot.updateInfo.releaseNotes) })
    } catch (error) {
      this.change({ phase: 'error', progress: null, error: updateError(error) })
    }
    return this.getState()
  }

  async install(session) {
    if (!this.pending || this.state.phase === 'installing') return { ok: false, message: '请先完成更新下载。' }
    if (this.checking || this.downloading) {
      const message = '正在检查更新，请稍后再次点击“重启并更新”。'
      this.change({ error: message })
      return { ok: false, message }
    }
    let release
    let verified = false
    try {
      release = this.gate.acquire()
      this.change({ phase: 'installing', error: '' })
      // Validate again after the user has left the package on disk for a while.
      await this.updater.restore(this.pending)
      verified = true
      this.saveSession(session)
      await this.updater.installPreparedUpdate()
      return { ok: true }
    } catch (error) {
      if (release) {
        try { this.clearSession() } catch { /* Preserve the original error. */ }
        if (!verified) {
          this.pending = null
          this.availableInfo = null
          await this.updater.discard().catch(() => {})
          try { this.store.save({ pending: null }) } catch { /* The next launch also revalidates the cache. */ }
        }
        release()
      }
      const message = updateError(error)
      this.change({ phase: this.pending ? 'ready' : 'error', error: message, ...(!this.pending ? { latestVersion: null, notes: '' } : {}) })
      return { ok: false, message }
    }
  }

  dispose() {
    this.disposed = true
    if (this.timer) this.clearTimer(this.timer)
    this.updater?.removeListener('download-progress', this.onProgress)
    this.updater?.removeListener('error', this.onError)
  }
}

function updateError(error) {
  const message = String(error?.message || '')
  const code = String(error?.code || '')
  if (/^[\u4e00-\u9fff]/.test(message)) return message.slice(0, 200)
  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') return '发布的版本缺少更新清单，请等待发布者补齐更新文件后重试。'
  if (code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' || code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND') return '更新服务尚未提供可用版本，请稍后再检查。'
  if (code === 'ERR_UPDATER_INVALID_RELEASE_FEED' || code === 'ERR_UPDATER_INVALID_UPDATE_INFO') return '更新服务返回的数据格式异常，请稍后重试。'
  if (/sha512|checksum|signature|digest/i.test(message)) return '更新文件校验失败，请重新下载。'
  if (/ENOSPC/.test(message)) return '磁盘空间不足，请清理后重试。'
  if (/EACCES|EPERM/.test(message)) return '无法访问更新文件，请检查目录权限后重试。'
  if (error?.statusCode === 429 || error?.statusCode === 403) return '更新服务暂时拒绝请求，请稍后再试。'
  if (/ERR_CERT_|CERT_HAS_EXPIRED|TLS_HANDSHAKE/i.test(code + message)) return '更新服务的安全连接验证失败，请检查系统时间或代理证书。'
  if (/ETIMEDOUT|ERR_TIMED_OUT|timeout/i.test(code + message)) return '连接更新服务超时，请检查代理或稍后重试。'
  if (/ENOTFOUND|ECONNRESET|ECONNREFUSED|ERR_(?:INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|CONNECTION_|PROXY_|TUNNEL_)/i.test(code + message)) return '无法连接更新服务，请检查网络或代理设置。'
  return '更新未完成，请稍后重试。'
}

module.exports = { UpdateService, validateUpdate, releaseNotes, updateError }
