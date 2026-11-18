const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..', '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const mainProcess = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')
const ignoreFile = fs.readFileSync(path.join(root, '.gitignore'), 'utf8')

describe('Windows beta packaging configuration', () => {
  it('uses a valid private version and Windows-only build entry points', () => {
    // The version is chosen by a maintainer through scripts/release.mjs, so this
    // test accepts any valid stable or prerelease semver version.
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
    expect(packageJson.private).toBe(true)
    expect(packageJson.devDependencies['electron-builder']).toBeTruthy()
    expect(packageJson.scripts['prepare:electron']).toBe('install-electron')
    expect(packageJson.scripts['prepack:win']).toBe('npm run prepare:electron')
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
      '!tests/**', '!output/**', '!.env', '!.env.*',
      '!.screenshots/**', '!.trae-html-share-packages/**',
      // 渲染层的依赖由 Vite 打进 dist/，node_modules 里的副本只占体积不参与运行。
      '!node_modules/@phosphor-icons/**', '!node_modules/react/**', '!node_modules/react-dom/**', '!node_modules/scheduler/**',
      // sourcemap 只在调试时用，运行期不读（包里的 1 MB .map 全来自 electron-updater 的依赖）。
      '!**/*.map',
    ])
    // 界面只有中文，Electron 自带 55 个语言包（48.8 MB）纯属浪费。
    expect(build.electronLanguages).toEqual(['zh-CN', 'en-US'])
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

  it('packages runtime updater dependencies and uses a fixed public release feed', () => {
    expect(packageJson.dependencies['electron-updater']).toBeTruthy()
    expect(packageJson.dependencies.semver).toBeTruthy()
    expect(packageJson.build.files).not.toContain('!node_modules/**')
    expect(packageJson.build.publish).toEqual({ provider: 'github', owner: 'chukui2005', repo: 'GitGlass' })
    expect(packageJson.build.nsis.include).toBe('build/installer.nsh')
  })
})
