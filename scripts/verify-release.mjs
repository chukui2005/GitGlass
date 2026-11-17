import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { load } from 'js-yaml'
import semver from 'semver'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function digest(file, algorithm, encoding = 'hex') {
  const hash = createHash(algorithm)
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest(encoding)
}

export async function verifyRelease(directory, version, tag) {
  if (!semver.valid(version)) throw new Error('Invalid release version')
  if (tag && tag !== `v${version}`) throw new Error(`Tag ${tag} does not match package version v${version}`)
  const exe = `GitGlass-Setup-${version}-x64.exe`
  const zip = `GitGlass-${version}-win-x64.zip`
  const names = [exe, zip, `${exe}.blockmap`, 'latest.yml', 'SHA256SUMS.txt']
  for (const name of names) {
    const file = path.join(directory, name)
    if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size === 0) {
      throw new Error(`Missing or empty release artifact: ${name}`)
    }
  }

  const sums = fs.readFileSync(path.join(directory, 'SHA256SUMS.txt'), 'utf8').trim().split(/\r?\n/)
  for (const name of [exe, zip]) {
    const expected = `${await digest(path.join(directory, name), 'sha256')}  ${name}`
    if (!sums.includes(expected)) throw new Error(`SHA-256 mismatch: ${name}`)
  }
  if (sums.length !== 2) throw new Error('Unexpected SHA256SUMS.txt entries')

  const manifest = load(fs.readFileSync(path.join(directory, 'latest.yml'), 'utf8'))
  if (manifest?.version !== version) throw new Error('Update manifest version does not match package version')
  const entry = manifest.files?.find((file) => file.url === exe)
  const sha512 = await digest(path.join(directory, exe), 'sha512', 'base64')
  if (!entry || entry.sha512 !== sha512 || entry.size !== fs.statSync(path.join(directory, exe)).size) {
    throw new Error('Update manifest installer size or SHA-512 mismatch')
  }
  if (manifest.path !== exe || manifest.sha512 !== sha512) throw new Error('Update manifest legacy fields mismatch')
  return names
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  try {
    const names = await verifyRelease(path.join(root, 'release'), version, process.env.TAG_NAME)
    console.log(`Verified ${names.length} release assets for v${version}, including SHA-256 and updater SHA-512.`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
