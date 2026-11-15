import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeReleaseChecksums } from '../scripts/write-release-checksums.mjs'

const temporaryDirectories = []
const expectedFiles = [
  'GitGlass-Setup-0.5.6-beta.1-x64.exe',
  'GitGlass-0.5.6-beta.1-win-x64.zip',
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
