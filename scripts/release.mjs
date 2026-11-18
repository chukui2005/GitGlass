#!/usr/bin/env node
/**
 * Manual release helper.
 *
 *   npm run release -- 0.6.2              # stable release: bump, changelog, commit, tag
 *   npm run release -- 0.6.2 --beta       # beta tag v0.6.2-beta.20261118.1
 *   npm run release -- 0.6.2 --dry-run    # print the plan, change nothing
 *
 * The version number is chosen by a human. This script only removes the
 * mechanical work: bump package.json/package-lock.json, write the CHANGELOG
 * section from the commits since the previous stable tag, commit, and tag.
 * Pushing the tag is what publishes the release (see docs/releasing.md).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import semver from 'semver'

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repositoryUrl = 'https://github.com/chukui2005/GitGlass'

const SECTION_BY_TYPE = [
  ['feat', 'Features'],
  ['fix', 'Bug Fixes'],
  ['perf', 'Performance'],
  ['refactor', 'Refactors'],
]
const HIDDEN_TYPES = new Set(['docs', 'test', 'tests', 'ci', 'build', 'chore', 'style', 'revert'])

export function parseConventionalSubject(subject) {
  const match = /^([a-zA-Z]+)(?:\([^)]*\))?(!)?:\s*(.+)$/.exec(subject.trim())
  if (!match) return null
  return { type: match[1].toLowerCase(), breaking: match[2] === '!', summary: match[3] }
}

export function renderChangelogSection(commits, { version, previousTag, date }) {
  const groups = new Map()
  const breaking = []
  for (const commit of commits) {
    const parsed = parseConventionalSubject(commit.subject)
    if (!parsed) continue
    const section = SECTION_BY_TYPE.find(([type]) => type === parsed.type)?.[1]
    if (parsed.breaking) breaking.push(commit.summary || parsed.summary)
    if (!section || HIDDEN_TYPES.has(parsed.type)) continue
    if (!groups.has(section)) groups.set(section, [])
    groups.get(section).push(commit)
  }
  const heading = `## [${version}](${repositoryUrl}/compare/${previousTag}...v${version}) (${date})`
  const blocks = [heading]
  for (const [, title] of SECTION_BY_TYPE) {
    const entries = groups.get(title)
    if (!entries?.length) continue
    blocks.push(`\n### ${title}\n\n${entries.map((commit) => commit.bullet).join('\n')}`)
  }
  if (breaking.length) {
    blocks.push(`\n### ⚠ BREAKING CHANGES\n\n${breaking.map((summary) => `* ${summary}`).join('\n')}`)
  }
  return blocks.join('\n')
}

/**
 * The previous release is the highest tag at or below the current version.
 * Prerelease tags count: a project that only shipped v0.6.1-beta.1 must not
 * generate a changelog from the very first commit.
 */
export function selectPreviousTag(existingTags, currentVersion) {
  return existingTags
    .filter((tag) => typeof tag === 'string' && /^v\d+\.\d+\.\d+/.test(tag) && semver.valid(tag.slice(1)))
    .map((tag) => ({ tag, version: tag.slice(1) }))
    .filter(({ version }) => semver.lte(version, currentVersion))
    .sort((left, right) => semver.compare(left.version, right.version))
    .at(-1)?.tag ?? null
}

export function nextBetaVersion(baseVersion, existingTags, date) {
  const prefix = `v${baseVersion}-beta.${date}.`
  const highest = existingTags
    .filter((tag) => tag.startsWith(prefix))
    .map((tag) => Number(tag.slice(prefix.length)))
    .filter((value) => Number.isInteger(value) && value > 0)
    .reduce((max, value) => Math.max(max, value), 0)
  return `${baseVersion}-beta.${date}.${highest + 1}`
}

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: rootDirectory, encoding: 'utf8', ...options }).trim()
}

function fail(message) {
  console.error(`错误：${message}`)
  process.exit(1)
}

function readJson(fileName) {
  // Tolerate a byte-order mark: some Windows editors add one and JSON.parse
  // rejects it, which would be a confusing failure during a release.
  const text = fs.readFileSync(path.join(rootDirectory, fileName), 'utf8').replace(/^\uFEFF/, '')
  return JSON.parse(text)
}

function writeJson(fileName, value) {
  fs.writeFileSync(path.join(rootDirectory, fileName), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function parseArguments(argv) {
  const flags = new Set(argv.filter((entry) => entry.startsWith('--')))
  const positional = argv.filter((entry) => !entry.startsWith('--'))
  if (positional.length !== 1) fail('用法：npm run release -- <版本号> [--beta] [--dry-run]')
  const base = positional[0].replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+$/.test(base)) fail(`版本号必须是 X.Y.Z 形式，收到：${base}`)
  return { base, beta: flags.has('--beta'), dryRun: flags.has('--dry-run') }
}

function collectCommits(previousTag) {
  const range = previousTag ? `${previousTag}..HEAD` : 'HEAD'
  const output = git(['log', '--no-merges', '--pretty=format:%H%x1f%h%x1f%s', range])
  if (!output) return []
  return output.split('\n').map((line) => {
    const [hash, shortHash, subject] = line.split('\x1f')
    const parsed = parseConventionalSubject(subject)
    return {
      hash,
      shortHash,
      subject,
      summary: parsed?.summary ?? subject,
      bullet: `* ${parsed?.summary ?? subject} ([${shortHash}](${repositoryUrl}/commit/${hash}))`,
    }
  })
}

function prependChangelog(section, fileName = 'CHANGELOG.md') {
  const filePath = path.join(rootDirectory, fileName)
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '# Changelog\n'
  const header = '# Changelog\n'
  const body = existing.startsWith(header) ? existing.slice(header.length).replace(/^\n+/, '') : existing
  fs.writeFileSync(filePath, `${header}\n${section}\n${body ? `\n${body}` : ''}`, 'utf8')
}

function main() {
  const { base, beta, dryRun } = parseArguments(process.argv.slice(2))
  const packageJson = readJson('package.json')
  const current = packageJson.version
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const existingTags = git(['tag', '--list', 'v*']).split('\n').filter(Boolean)
  const version = beta ? nextBetaVersion(base, existingTags, date) : base

  if (!semver.valid(version)) fail(`生成的版本号无效：${version}`)
  if (!semver.gt(version, current)) fail(`新版本 ${version} 必须高于当前 package.json 版本 ${current}`)
  if (git(['tag', '--list', `v${version}`])) fail(`tag v${version} 已存在`)

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch !== 'main') fail(`请在 main 分支上发版（当前是 ${branch}）；先合并 PR 并同步 main。`)
  const dirty = git(['status', '--porcelain'])
  if (dirty) fail(`工作区有未提交改动：\n${dirty}\n请先提交或还原后再发版。`)

  const previousTag = selectPreviousTag(existingTags, current)
  const commits = collectCommits(previousTag)
  const section = renderChangelogSection(commits, { version, previousTag: previousTag ?? 'HEAD', date: new Date().toISOString().slice(0, 10) })

  console.log(`当前版本：${current}`)
  console.log(`目标版本：${version}${beta ? '（Beta）' : ''}`)
  console.log(`上一稳定版：${previousTag ?? '无'}`)
  console.log(`自上一版本以来的提交：${commits.length} 条`)
  console.log(`\n${section}\n`)
  if (dryRun) {
    console.log('--dry-run：未写入任何文件。')
    return
  }

  packageJson.version = version
  writeJson('package.json', packageJson)
  const packageLock = readJson('package-lock.json')
  packageLock.version = version
  if (packageLock.packages?.['']) packageLock.packages[''].version = version
  writeJson('package-lock.json', packageLock)
  prependChangelog(section)

  git(['add', 'package.json', 'package-lock.json', 'CHANGELOG.md'])
  git(['commit', '-m', `chore(release): ${version}`])
  git(['tag', '-a', `v${version}`, '-m', `GitGlass v${version}`])

  console.log(`已提交并打 tag v${version}。`)
  console.log('下一步（推送后自动触发构建与发布）：')
  console.log('  git push origin main --follow-tags')
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) main()
