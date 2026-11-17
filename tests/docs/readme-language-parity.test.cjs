const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..', '..')
const englishPath = path.join(root, 'README.md')
const chinesePath = path.join(root, 'README.zh-CN.md')
const expectedSections = ['hero', 'why-gitglass', 'features', 'download', 'screenshots', 'development', 'security', 'license']

function sections(markdown) {
  return [...markdown.matchAll(/<!-- section:([a-z-]+) -->/g)].map((match) => match[1])
}

function imagePaths(markdown) {
  return [...markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1])
}

describe('Bilingual README parity', () => {
  const english = fs.readFileSync(englishPath, 'utf8')
  const chinese = fs.readFileSync(chinesePath, 'utf8')

  it('keeps both full-language homepages and reciprocal language links', () => {
    expect(fs.existsSync(englishPath)).toBe(true)
    expect(fs.existsSync(chinesePath)).toBe(true)
    expect(english).toContain('English | <a href="README.zh-CN.md">简体中文</a>')
    expect(chinese).toContain('<a href="README.md">English</a> | 简体中文')
    expect(english).toContain('<h1 align="center">GitGlass</h1>')
    expect(english).not.toMatch(/^# GitGlass V0\.5/m)
  })

  it('has the same stable section order in both languages', () => {
    expect(sections(english)).toEqual(expectedSections)
    expect(sections(chinese)).toEqual(expectedSections)
  })

  it('states the release location, Windows x64 scope, Git prerequisite, and unsigned-beta limitation', () => {
    for (const readme of [english, chinese]) {
      expect(readme).toContain('https://github.com/chukui2005/GitGlass/releases')
      expect(readme).toMatch(/Windows x64|Windows x64 Beta/)
      expect(readme).toContain('git --version')
      expect(readme).toMatch(/unsigned|未签名/)
      expect(readme).not.toMatch(/automatic updates are available|支持自动更新|dark mode is available|支持深色模式|hunk staging is available|支持 hunk 暂存/i)
    }
  })

  it('uses committed public README images only and never references output/', () => {
    for (const readme of [english, chinese]) {
      expect(readme).not.toContain('output/')
      for (const image of imagePaths(readme)) {
        expect(image).toMatch(/^docs\/assets\/readme\//)
        expect(fs.existsSync(path.join(root, image))).toBe(true)
      }
    }
  })

  it('keeps the Chinese feature headings in natural Chinese rather than copying English group headings', () => {
    for (const heading of ['Transparent execution', 'Everyday workspace', 'History and review', 'Safety and recovery']) expect(chinese).not.toContain(heading)
    expect(chinese).toContain('### 透明执行')
    expect(chinese).toContain('### 日常工作区')
    expect(chinese).toContain('### 历史与审阅')
    expect(chinese).toContain('### 安全与恢复')
  })
})
