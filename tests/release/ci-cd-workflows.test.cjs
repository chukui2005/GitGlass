const fs = require('node:fs')
const path = require('node:path')
const { load } = require('js-yaml')

const root = path.join(__dirname, '..', '..')
const read = (...segments) => fs.readFileSync(path.join(root, ...segments), 'utf8')
const exists = (...segments) => fs.existsSync(path.join(root, ...segments))

describe('GitHub CI/CD workflow configuration', () => {
  const ci = read('.github', 'workflows', 'ci.yml')
  const publish = read('.github', 'workflows', 'publish-release.yml')
  const packageJson = JSON.parse(read('package.json'))

  it('keeps actual package builds in read-only PR CI and gates publishing on them', () => {
    const checks = load(ci)
    const release = load(publish)
    expect(checks.permissions).toEqual({ contents: 'read' })
    expect(checks.jobs.quality.permissions).toBeUndefined()
    expect(checks.jobs.quality.steps.filter((step) => step.run).map((step) => step.run))
      .toEqual([
        'npm ci',
        'npm run lint',
        'npm run typecheck',
        'npm run test:coverage',
        'npm run build',
        'npm run dist:win',
        'npm run verify:release',
      ])
    expect(release.jobs['build-windows-release'].steps.find((step) => step.run === 'npm run verify:release').env)
      .toEqual({ TAG_NAME: '${{ github.ref_name }}' })
    expect(release.jobs['create-github-release'].needs).toBe('build-windows-release')
  })

  it('runs a stable, read-only quality check for main PRs and pushes', () => {
    expect(ci).toContain('name: GitGlass CI')
    expect(ci).toMatch(/pull_request:\s*\n\s*branches:\s*\n\s*- main/)
    expect(ci).toMatch(/push:\s*\n\s*branches:\s*\n\s*- main/)
    expect(ci).toContain('contents: read')
    expect(ci).not.toContain('contents: write')
    expect(ci).toContain('group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}')
    expect(ci).toContain('cancel-in-progress: true')
    expect(ci).toContain('name: Quality (test and build)')
    expect(ci).toContain('runs-on: windows-2022')
    expect(ci).toContain('node-version: 22.12.0')
    expect(ci).toContain('run: npm ci')
    expect(ci).toContain('run: npm run lint')
    expect(ci).toContain('run: npm run typecheck')
    // `test:coverage` runs the same suite as `npm test`; CI runs it once.
    expect(ci).toContain('run: npm run test:coverage')
    expect(ci).toContain('run: npm run build')
  })

  it('releases from a maintainer-chosen version and a pushed tag, without a release bot', () => {
    // A release is a deliberate local action: no bot opens release pull requests,
    // and no release token is required because the tag is pushed by a person.
    expect(exists('.github', 'workflows', 'release-please.yml')).toBe(false)
    expect(exists('release-please-config.json')).toBe(false)
    expect(exists('.release-please-manifest.json')).toBe(false)
    expect(exists('scripts', 'release.mjs')).toBe(true)
    expect(packageJson.scripts.release).toBe('node scripts/release.mjs')
    // The version has a single source of truth.
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  })

  it('publishes only version tags after verifying the exact Windows artifacts', () => {
    expect(publish).toContain("- 'v*'")
    expect(publish).toContain('runs-on: windows-2022')
    expect(publish).toContain('node-version: 22.12.0')
    expect(publish).toContain('run: npm ci')
    expect(publish).toContain('run: npm run dist:win')
    expect(publish).toContain('contents: read')
    expect(publish).toMatch(/create-github-release:[\s\S]*?permissions:\s*\n\s*contents: write/)
    expect(publish).toMatch(/build-windows-release:[\s\S]*?uses: actions\/upload-artifact@/)
    expect(publish).toMatch(/create-github-release:[\s\S]*?uses: actions\/download-artifact@/)
    expect(publish).toContain('run: npm run verify:release')
    expect(ci).toContain('run: npm run dist:win')
    expect(ci).toContain('run: npm run verify:release')
    expect(publish).toContain('release/GitGlass-Setup-*-x64.exe')
    expect(publish).toContain('release/GitGlass-*-win-x64.zip')
    expect(publish).toContain('release/SHA256SUMS.txt')
    expect(publish).toContain('release/GitGlass-Setup-*-x64.exe.blockmap')
    expect(publish).toContain('release/latest.yml')
    expect(publish).toContain("prerelease: ${{ contains(github.ref_name, '-') }}")
    expect(publish).toContain('draft: true')
    expect(publish).toContain('gh release edit "$TAG_NAME" --repo "$GITHUB_REPOSITORY" --draft=false')
    expect(publish).toContain('softprops/action-gh-release@')
    expect(publish).toContain('fail_on_unmatched_files: true')
  })

  it('documents the manual release steps and the required GitHub-side controls', () => {
    const contributing = read('CONTRIBUTING.md')
    const releasing = read('docs', 'releasing.md')
    const ciCd = read('docs', 'ci-cd.md')

    expect(contributing).toContain('Auto-merge')
    expect(contributing).toContain('不要手动修改版本号或 CHANGELOG')
    expect(contributing).toContain('npm run release')
    expect(releasing).toContain('npm run release')
    expect(releasing).toContain('--follow-tags')
    expect(releasing).toContain('Version policy')
    expect(releasing).not.toContain('RELEASE_PLEASE_TOKEN')
    expect(releasing).toContain('CSC_LINK')
    expect(ciCd).toContain('GitGlass CI / Quality (test and build)')
    expect(ciCd).toContain('at least **one approving review**')
    expect(ciCd).not.toContain('RELEASE_PLEASE_TOKEN')
  })
})
