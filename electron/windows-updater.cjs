const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const semver = require('semver')

function legacyReleaseVersion(error) {
  if (error?.code !== 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') return null
  // GitHubProvider includes the selected release URL in this specific error.
  // Only trust our fixed repository and only parse its version tag. This
  // fallback can establish "no newer version", never authorize installation.
  const match = String(error.message).match(/https:\/\/github\.com\/chukui2005\/GitGlass\/releases\/download\/([^/\s]+)\/(?:latest|beta)\.yml(?:[\s):]|$)/)
  if (!match) return null
  try { return semver.valid(decodeURIComponent(match[1])) } catch { return null }
}

async function sha512(file) {
  const hash = createHash('sha512')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('base64')
}

// electron-updater is pinned. Keep its protected cache / NSIS integration in
// this adapter, and exercise it against the real dependency in the smoke test.
// Downloads and Windows publisher verification remain owned by NsisUpdater.
function createWindowsUpdater({ NsisUpdater, app, executable = process.execPath, resourcesPath = process.resourcesPath }) {
  return new class extends NsisUpdater {
    async checkForUpdates() {
      try { return await super.checkForUpdates() }
      catch (error) {
        const version = legacyReleaseVersion(error)
        if (version && semver.lte(version, this.currentVersion.version)) {
          // Releases made before the updater existed have no manifest. An
          // equal/older release still proves that no upgrade is available.
          return { isUpdateAvailable: false, updateInfo: { version, files: [] } }
        }
        throw error
      }
    }

    async snapshot() {
      const helper = await this.getOrCreateDownloadHelper()
      if (!helper.file || !helper.fileInfo) throw new Error('更新缓存尚未就绪。')
      const info = helper.versionInfo
      const notes = typeof info.releaseNotes === 'string' ? info.releaseNotes.slice(0, 32000) : ''
      return { fileName: path.basename(helper.file), fileInfo: helper.fileInfo.info, updateInfo: { version: info.version, files: info.files, releaseNotes: notes } }
    }

    async restore(snapshot) {
      const helper = await this.getOrCreateDownloadHelper()
      const fileName = snapshot.fileName
      if (typeof fileName !== 'string' || fileName !== path.basename(fileName) || !/^GitGlass-Setup-[0-9A-Za-z.+-]+-x64\.exe$/.test(fileName)) {
        throw new Error('更新缓存文件名无效。')
      }
      const expected = snapshot.updateInfo?.files?.find((entry) => entry.url === snapshot.fileInfo?.url)
      if (fileName !== `GitGlass-Setup-${snapshot.updateInfo?.version}-x64.exe` || !expected || expected.sha512 !== snapshot.fileInfo.sha512) {
        throw new Error('更新缓存版本或校验信息不匹配。')
      }
      const file = path.join(helper.cacheDirForPendingUpdate, fileName)
      if (await sha512(file) !== snapshot.fileInfo.sha512) throw new Error('更新文件校验失败，请重新下载。')
      const signatureError = await this.verifySignature(file)
      if (signatureError) throw new Error('更新文件签名校验失败，请重新下载。')
      await helper.setDownloadedFile(file, null, snapshot.updateInfo, {
        url: new URL(`https://github.com/chukui2005/GitGlass/releases/download/v${snapshot.updateInfo.version}/${fileName}`),
        info: snapshot.fileInfo,
      }, fileName, false)
    }

    async installPreparedUpdate() {
      const helper = await this.getOrCreateDownloadHelper()
      if (!helper.file || !helper.downloadedFileInfo) throw new Error('更新缓存不可用，请重新下载。')
      const args = ['--updated', '/S', '--force-run', `/D=${path.dirname(executable)}`]
      // Await process creation before quitting. BaseUpdater.quitAndInstall()
      // schedules quit before an asynchronous spawn failure can be handled.
      const elevate = () => this.spawnLog(path.join(resourcesPath, 'elevate.exe'), [helper.file, ...args])
      if (helper.downloadedFileInfo.isAdminRightsRequired) await elevate()
      else {
        try { await this.spawnLog(helper.file, args) }
        catch (error) {
          if (error.code !== 'EACCES' && error.code !== 'UNKNOWN') throw error
          await elevate()
        }
      }
      app.quit()
    }

    async discard() {
      const helper = await this.getOrCreateDownloadHelper()
      await helper.clear()
    }
  }()
}

module.exports = { createWindowsUpdater, sha512, legacyReleaseVersion }
