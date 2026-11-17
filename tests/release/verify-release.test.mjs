import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dump } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyRelease } from '../../scripts/verify-release.mjs'
import { writeReleaseChecksums } from '../../scripts/write-release-checksums.mjs'

const directories = []
const version = '1.2.3-beta.2'
const exe = `GitGlass-Setup-${version}-x64.exe`
const zip = `GitGlass-${version}-win-x64.zip`
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-release-'))
  directories.push(directory)
  const installer = Buffer.from('MZ test installer')
  fs.writeFileSync(path.join(directory, exe), installer)
  fs.writeFileSync(path.join(directory, zip), 'PK test archive')
  fs.writeFileSync(path.join(directory, `${exe}.blockmap`), 'test blockmap')
  const sha512 = createHash('sha512').update(installer).digest('base64')
  fs.writeFileSync(path.join(directory, 'latest.yml'), dump({ version, files: [{ url: exe, size: installer.length, sha512 }], path: exe, sha512 }))
  writeReleaseChecksums(directory, version)
  return directory
}
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }) })

describe('release integrity gate', () => {
  it('accepts a complete versioned release and matching tag', async () => {
    expect(await verifyRelease(fixture(), version, `v${version}`)).toHaveLength(5)
  })
  it('rejects a tag for a different version', async () => {
    await expect(verifyRelease(fixture(), version, 'v9.0.0')).rejects.toThrow('does not match')
  })
  it.each([exe, zip, `${exe}.blockmap`, 'latest.yml', 'SHA256SUMS.txt'])('rejects an empty %s', async (name) => {
    const directory = fixture()
    fs.writeFileSync(path.join(directory, name), '')
    await expect(verifyRelease(directory, version)).rejects.toThrow('Missing or empty')
  })
  it('rejects a corrupted download', async () => {
    const directory = fixture()
    fs.appendFileSync(path.join(directory, zip), 'corruption')
    await expect(verifyRelease(directory, version)).rejects.toThrow('SHA-256 mismatch')
  })
  it('rejects stale updater metadata even when the release checksums are correct', async () => {
    const directory = fixture()
    fs.appendFileSync(path.join(directory, exe), 'new installer')
    writeReleaseChecksums(directory, version)
    await expect(verifyRelease(directory, version)).rejects.toThrow('SHA-512 mismatch')
  })
  it('rejects updater metadata for another version', async () => {
    const directory = fixture()
    const file = path.join(directory, 'latest.yml')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(version, '0.0.1'))
    await expect(verifyRelease(directory, version)).rejects.toThrow('version does not match')
  })
})
