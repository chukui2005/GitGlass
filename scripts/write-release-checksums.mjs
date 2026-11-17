import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseDirectory = path.join(rootDirectory, 'release')
const { version: packageVersion } = JSON.parse(fs.readFileSync(path.join(rootDirectory, 'package.json'), 'utf8'))

export function writeReleaseChecksums(directory = releaseDirectory, version = packageVersion) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('发布版本号无效。')
  const expectedArtifacts = [`GitGlass-Setup-${version}-x64.exe`, `GitGlass-${version}-win-x64.zip`]
  const artifacts = expectedArtifacts.map((name) => ({ name, path: path.join(directory, name) }))
  const missing = artifacts.filter(({ path: artifactPath }) => !fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile())

  if (missing.length > 0) {
    const names = missing.map(({ name }) => name).join('、')
    throw new Error(`缺少预期 Windows 产物：${names}。请先执行 npm run pack:win，并确认 release/ 内同时存在 .exe 和 .zip。`)
  }

  const contents = artifacts.map(({ name, path: artifactPath }) => {
    const checksum = createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex')
    return `${checksum}  ${name}`
  }).join('\n') + '\n'

  fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), contents, 'utf8')
  return contents
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  try {
    writeReleaseChecksums()
    console.log('已生成 release/SHA256SUMS.txt。')
  } catch (error) {
    console.error(`错误：${error.message}`)
    process.exitCode = 1
  }
}
