const { EventEmitter } = require('node:events')
const { UpdateService, validateUpdate, updateError } = require('../electron/update-service.cjs')
const { OperationGate } = require('../electron/operation-gate.cjs')

const digest = Buffer.alloc(64, 1).toString('base64')
function info(version = '0.5.7-beta.1') {
  return { version, files: [{ url: `GitGlass-Setup-${version}-x64.exe`, sha512: digest }], releaseNotes: '修复问题并改进更新体验。' }
}
function snapshot(updateInfo = info()) {
  return { fileName: updateInfo.files[0].url, fileInfo: updateInfo.files[0], updateInfo }
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function setup(options = {}) {
  const updater = new EventEmitter()
  updater.checkForUpdates = vi.fn(async () => ({ updateInfo: info() }))
  updater.downloadUpdate = vi.fn(async () => { updater.emit('download-progress', { percent: 50 }); return ['/cache/update.exe'] })
  updater.snapshot = vi.fn(async () => snapshot())
  updater.restore = vi.fn(async () => {})
  updater.discard = vi.fn(async () => {})
  updater.installPreparedUpdate = vi.fn(async () => {})
  const store = { value: { automatic: true, pending: null }, save: vi.fn(function (patch) { Object.assign(this.value, patch) }) }
  const gate = new OperationGate()
  const saveSession = vi.fn()
  const clearSession = vi.fn()
  const timers = []
  const service = new UpdateService({ updater, store, version: '0.5.6-beta.1', supported: true, gate, saveSession, clearSession,
    setTimer: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer }, clearTimer: vi.fn(), ...options })
  return { service, updater, store, gate, saveSession, clearSession, timers }
}

describe('application updates', () => {
  it('downloads in the background and only offers a verified, persisted package', async () => {
    const { service, updater, store, saveSession } = setup()
    const phases = []
    service.on('state', (state) => phases.push(state.phase))
    await service.check()
    expect(phases).toEqual(['checking', 'available', 'downloading', 'downloading', 'ready'])
    expect(service.getState()).toMatchObject({ phase: 'ready', progress: 100, latestVersion: '0.5.7-beta.1' })
    expect(updater.restore).toHaveBeenCalledWith(snapshot())
    expect(store.value.pending).toEqual(snapshot())
    expect(saveSession).not.toHaveBeenCalled()
    expect(updater.installPreparedUpdate).not.toHaveBeenCalled()
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(updater.allowDowngrade).toBe(false)
  })

  it('does not request updates for ZIP, development or unsupported platforms', async () => {
    const { service, updater, timers } = setup({ supported: false, reason: '请使用安装版。' })
    await service.initialize(); await service.check(); await service.download()
    expect(service.getState().phase).toBe('unsupported')
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    expect(timers).toHaveLength(0)
  })

  it('persists the automatic preference and still allows manual checking and downloading', async () => {
    const { service, updater, store, timers } = setup()
    service.setAutomatic(false)
    await service.initialize(); await service.check()
    expect(store.value.automatic).toBe(false)
    expect(timers).toHaveLength(0)
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect(service.getState().phase).toBe('available')
    await service.download()
    expect(service.getState().phase).toBe('ready')
  })

  it('coalesces checks and downloads even when the user clicks repeatedly', async () => {
    const { service, updater } = setup()
    const check = deferred(), download = deferred()
    updater.checkForUpdates.mockReturnValue(check.promise)
    updater.downloadUpdate.mockReturnValue(download.promise)
    const first = service.check(), second = service.check()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    check.resolve({ updateInfo: info() })
    await new Promise((resolve) => setImmediate(resolve))
    const third = service.download()
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1)
    download.resolve([])
    await Promise.all([first, second, third])
    expect(service.getState().phase).toBe('ready')
  })

  it('restores a downloaded update without a network request', async () => {
    const { service, store, updater, timers } = setup()
    store.value.pending = snapshot()
    await service.initialize()
    expect(service.getState().phase).toBe('ready')
    expect(updater.restore).toHaveBeenCalledWith(snapshot())
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    expect(timers[0].delay).toBe(10_000)
    await service.install({ commitMessage: '草稿', historyMode: true })
    expect(updater.installPreparedUpdate).toHaveBeenCalledOnce()
  })

  it('drops corrupted and already-installed cached updates', async () => {
    const { service, store, updater } = setup()
    store.value.pending = snapshot()
    updater.restore.mockRejectedValue(new Error('checksum'))
    await service.initialize()
    expect(store.value.pending).toBeNull()
    expect(service.getState().phase).toBe('idle')
    const stale = setup()
    stale.store.value.pending = snapshot(info('0.5.5'))
    await stale.service.initialize()
    expect(stale.updater.restore).not.toHaveBeenCalled()
    expect(stale.store.value.pending).toBeNull()
  })

  it('keeps a prepared update installable when a later network check fails', async () => {
    const { service, updater } = setup()
    await service.check()
    updater.checkForUpdates.mockRejectedValue(new Error('https://example.invalid?token=secret'))
    await service.check()
    expect(service.getState()).toMatchObject({ phase: 'ready', latestVersion: '0.5.7-beta.1', error: '更新未完成，请稍后重试。' })
    expect(JSON.stringify(service.getState())).not.toContain('secret')
  })

  it('clears a previously advertised version when it is no longer available', async () => {
    const { service, updater } = setup()
    service.setAutomatic(false)
    await service.check()
    updater.checkForUpdates.mockResolvedValue({ updateInfo: info('0.5.6-beta.1') })
    await service.check()
    expect(service.getState()).toMatchObject({ phase: 'current', latestVersion: null, notes: '' })
    await service.download()
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('does not mark a failed checksum or disk write as ready', async () => {
    const { service, updater, store } = setup()
    updater.restore.mockRejectedValue(new Error('sha512 mismatch'))
    await service.check()
    expect(service.getState()).toMatchObject({ phase: 'error', error: '更新文件校验失败，请重新下载。' })
    expect(store.value.pending).toBeNull()
    updater.restore.mockResolvedValue()
    store.save.mockImplementation(() => { throw new Error('ENOSPC') })
    await service.download()
    expect(service.getState()).toMatchObject({ phase: 'error', error: '磁盘空间不足，请清理后重试。' })
  })

  it('blocks restart for the entire Git operation, then requires a fresh install click', async () => {
    const { service, updater, gate, saveSession } = setup()
    await service.check()
    const work = deferred()
    const running = gate.run(() => work.promise)
    expect((await service.install({})).ok).toBe(false)
    expect(saveSession).not.toHaveBeenCalled()
    work.resolve(); await running
    expect(updater.installPreparedUpdate).not.toHaveBeenCalled()
    expect((await service.install({ commitMessage: '草稿', historyMode: false })).ok).toBe(true)
    expect(saveSession).toHaveBeenCalledWith({ commitMessage: '草稿', historyMode: false })
    await expect(gate.run(() => {})).rejects.toThrow('正在准备更新')
  })

  it('locks new operations during revalidation and retains the package if installation fails', async () => {
    const { service, updater, gate, clearSession } = setup()
    await service.check()
    const restore = deferred()
    updater.restore.mockReturnValue(restore.promise)
    const installing = service.install({ commitMessage: '草稿', historyMode: false })
    await expect(gate.run(() => {})).rejects.toThrow('正在准备更新')
    updater.installPreparedUpdate.mockRejectedValue(new Error('EACCES'))
    restore.resolve()
    expect((await installing).ok).toBe(false)
    expect(service.getState().phase).toBe('ready')
    expect(clearSession).toHaveBeenCalledOnce()
    await expect(gate.run(async () => 'allowed')).resolves.toBe('allowed')
  })

  it('does not start the installer if saving the restart draft fails', async () => {
    const { service, updater, gate, saveSession } = setup()
    await service.check()
    saveSession.mockImplementation(() => { throw new Error('ENOSPC') })
    expect((await service.install({})).ok).toBe(false)
    expect(updater.installPreparedUpdate).not.toHaveBeenCalled()
    expect(gate.locked).toBe(false)
  })

  it('removes a package corrupted after download and permits a fresh download', async () => {
    const { service, updater, store } = setup()
    await service.check()
    updater.restore.mockRejectedValueOnce(new Error('sha512 mismatch'))
    expect((await service.install({})).ok).toBe(false)
    expect(service.getState()).toMatchObject({ phase: 'error', latestVersion: null })
    expect(store.value.pending).toBeNull()
    expect(updater.discard).toHaveBeenCalledOnce()
    await service.check()
    expect(service.getState().phase).toBe('ready')
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(2)
  })

  it('never exposes the package path or raw updater object to the renderer', async () => {
    const { service } = setup()
    await service.check()
    expect(JSON.stringify(service.getState())).not.toMatch(/fileName|sha512|\/cache|fileInfo/)
    service.dispose()
  })
})

describe('release channel policy', () => {
  it('uses semantic versions, accepts Beta promotion and rejects downgrades or other prereleases', () => {
    expect(validateUpdate(info('0.5.10'), '0.5.9')).toBeTruthy()
    expect(validateUpdate(info('0.5.6'), '0.5.6-beta.1')).toBeTruthy()
    expect(validateUpdate(info('0.5.7-beta.1'), '0.5.6')).toBe(false)
    expect(validateUpdate(info('0.5.7-alpha.1'), '0.5.6-beta.1')).toBe(false)
    expect(validateUpdate(info('0.5.5'), '0.5.6')).toBe(false)
  })

  it('rejects incomplete, untrusted or wrong-architecture installer metadata', () => {
    const invalid = info('0.5.7')
    invalid.files[0].url = 'https://untrusted.invalid/setup.exe'
    expect(() => validateUpdate(invalid, '0.5.6')).toThrow('更新清单无效')
    invalid.files[0].url = 'GitGlass-Setup-0.5.7-arm64.exe'
    expect(() => validateUpdate(invalid, '0.5.6')).toThrow('更新清单无效')
    invalid.files[0].url = 'GitGlass-Setup-0.5.7-x64.exe'; invalid.files[0].sha512 = ''
    expect(() => validateUpdate(invalid, '0.5.6')).toThrow('更新清单无效')
  })
})

describe('update diagnostics', () => {
  it('distinguishes missing release assets from connectivity failures', () => {
    expect(updateError({ code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' })).toContain('缺少更新清单')
    expect(updateError({ code: 'ERR_UPDATER_INVALID_RELEASE_FEED' })).toContain('数据格式异常')
    expect(updateError({ code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' })).toContain('尚未提供可用版本')
    expect(updateError({ code: 'ECONNREFUSED' })).toContain('网络或代理')
    expect(updateError({ message: 'net::ERR_PROXY_CONNECTION_FAILED' })).toContain('网络或代理')
    expect(updateError({ code: 'ETIMEDOUT' })).toContain('超时')
    expect(updateError({ code: 'ERR_CERT_AUTHORITY_INVALID' })).toContain('安全连接验证失败')
    expect(updateError({ statusCode: 429 })).toContain('拒绝请求')
    expect(updateError(new Error('unknown error https://example.invalid/?token=secret'))).toBe('更新未完成，请稍后重试。')
  })

  it('does not offer an installer when a newer release is missing its update manifest', async () => {
    const { service, updater } = setup()
    updater.checkForUpdates.mockRejectedValue(Object.assign(new Error('Cannot find latest.yml'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' }))
    await service.check()
    expect(service.getState()).toMatchObject({ phase: 'error', latestVersion: null, error: '发布的版本缺少更新清单，请等待发布者补齐更新文件后重试。' })
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect(updater.installPreparedUpdate).not.toHaveBeenCalled()
  })
})
