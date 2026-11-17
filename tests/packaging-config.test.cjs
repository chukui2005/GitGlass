const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const mainProcess = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')
const ignoreFile = fs.readFileSync(path.join(root, '.gitignore'), 'utf8')

describe('Windows beta packaging configuration', () => {
  it('uses a valid private prerelease version and Windows-only build entry points', () => {
    // Release Please owns the exact version. Keep this test compatible with the
    // version it writes into its generated release pull requests.
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/)
    expect(packageJson.private).toBe(true)
    expect(packageJson.devDependencies['electron-builder']).toBeTruthy()
    expect(packageJson.scripts['pack:win']).toContain('--win --x64 --publish never')
    expect(packageJson.scripts['checksum:win']).toBe('node scripts/write-release-checksums.mjs')
    expect(packageJson.scripts['dist:win']).toBe('npm run build && npm run pack:win && npm run checksum:win')
  })

  it('limits the packaged application to the declared application files and Windows x64 artifacts', () => {
    const build = packageJson.build
    expect(build).toMatchObject({ appId: 'io.github.chukui2005.gitglass', productName: 'GitGlass', asar: true })
    expect(build.electronDist).toBe('node_modules/electron/dist')
    expect(build.icon).toBe('public/icon.ico')
    expect(build.directories.output).toBe('release')
    expect(build.files).toEqual([
      'dist/**', 'electron/**', 'public/**', 'package.json', 'LICENSE',
      '!node_modules/**', '!tests/**', '!output/**', '!.env', '!.env.*',
      '!.screenshots/**', '!.trae-html-share-packages/**',
    ])
    expect(build.win.target).toEqual([
      { target: 'nsis', arch: ['x64'] },
      { target: 'zip', arch: ['x64'] },
    ])
    expect(build.artifactName).toBe('GitGlass-${version}-win-${arch}.${ext}')
    expect(build.nsis).toMatchObject({
      artifactName: 'GitGlass-Setup-${version}-${arch}.${ext}',
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      deleteAppDataOnUninstall: false,
    })
  })

  it('keeps the production icon inside the packaged public directory and ignores generated releases', () => {
    expect(mainProcess).toContain("path.join(__dirname, '..', 'public', iconFile)")
    expect(packageJson.build.files).toContain('public/**')
    expect(ignoreFile).toContain('release/')
  })

  it('does not put secret-shaped values or environment files into the packaging rules', () => {
    const configuration = JSON.stringify(packageJson.build)
    expect(configuration).not.toMatch(/gh[pous]_[A-Za-z0-9_]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|certificatePassword/i)
    expect(packageJson.build.files.filter((pattern) => pattern.includes('.env'))).toEqual(['!.env', '!.env.*'])
  })
})
