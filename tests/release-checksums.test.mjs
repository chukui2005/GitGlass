import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { writeReleaseChecksums } from '../scripts/write-release-checksums.mjs'

const temporaryDirectories = []
// The writer defaults to the package version, which Release Please owns. Deriving the
// expected names from the same source keeps this test green in release pull requests.
const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { version: packageVersion } = JSON.parse(fs.readFileSync(path.join(rootDirectory, 'package.json'), 'utf8'))
const expectedFiles = [
  `GitGlass-Setup-${packageVersion}-x64.exe`,
  `GitGlass-${packageVersion}-win-x64.zip`,
]

function makeReleaseDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-release-checksum-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  while (temporaryDirectories.length > 0) fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true })
})

describe('Windows release checksum writer', () => {
  it('uses the requested next release version instead of a hard-coded beta filename', () => {
    const directory = makeReleaseDirectory()
    fs.writeFileSync(path.join(directory, 'GitGlass-Setup-1.2.0-x64.exe'), 'next installer')
    fs.writeFileSync(path.join(directory, 'GitGlass-1.2.0-win-x64.zip'), 'next zip')
    expect(writeReleaseChecksums(directory, '1.2.0')).toContain('GitGlass-Setup-1.2.0-x64.exe')
    expect(() => writeReleaseChecksums(directory, '../outside')).toThrow('发布版本号无效')
  })
  it('writes SHA-256 entries for exactly the expected installer and zip names', () => {
    const directory = makeReleaseDirectory()
    fs.writeFileSync(path.join(directory, expectedFiles[0]), 'installer')
    fs.writeFileSync(path.join(directory, expectedFiles[1]), 'portable archive')
    fs.writeFileSync(path.join(directory, 'unrelated.txt'), 'not included')

    const contents = writeReleaseChecksums(directory)
    const expected = expectedFiles.map((name) => {
      const hash = createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')
      return `${hash}  ${name}`
    }).join('\n') + '\n'

    expect(contents).toBe(expected)
    expect(fs.readFileSync(path.join(directory, 'SHA256SUMS.txt'), 'utf8')).toBe(expected)
  })

  it('fails with an actionable Chinese error before writing a partial checksum file', () => {
    const directory = makeReleaseDirectory()
    fs.writeFileSync(path.join(directory, expectedFiles[0]), 'installer')

    expect(() => writeReleaseChecksums(directory)).toThrow('缺少预期 Windows 产物')
    expect(fs.existsSync(path.join(directory, 'SHA256SUMS.txt'))).toBe(false)
  })
})
