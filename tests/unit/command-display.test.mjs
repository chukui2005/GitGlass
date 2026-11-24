import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { displayGitCommand } from '../../src/command-display.js'

const require = createRequire(import.meta.url)
const display = require('../../electron/command-display.mjs')
const service = require('../../electron/git-command-service.cjs')

// 预览（渲染层）与账本（主进程）必须用同一套参数格式化规则：
// 含空格或引号的参数加双引号，其余原样，`git` 本身固定在开头。
describe('命令行显示格式（预览与账本共用一份实现）', () => {
  it('only quotes the arguments that need it', () => {
    expect(displayGitCommand(['add', '--', 'src/main.jsx'])).toBe('git add -- src/main.jsx')
    expect(displayGitCommand(['add', '--', 'guide for project.md'])).toBe('git add -- "guide for project.md"')
    expect(displayGitCommand(['add', '--', '配置.md'])).toBe('git add -- 配置.md')
    expect(displayGitCommand(['add', '--', 'new  note.md'])).toBe('git add -- "new  note.md"')
    expect(displayGitCommand(['add', '--', "it's.md"])).toBe('git add -- "it\'s.md"')
    expect(displayGitCommand(['commit', '-m', 'fix: 引号 " 与空格'])).toBe('git commit -m "fix: 引号 \\" 与空格"')
  })

  it('tolerates an empty argv without inventing arguments', () => {
    expect(displayGitCommand([])).toBe('git')
    expect(displayGitCommand()).toBe('git')
  })

  it('is the same implementation for the ledger and the preview', () => {
    // 服务层从共享模块转出同一个函数对象；渲染层拿到同一份规则的打包结果，
    // 因此两边对同一组 argv 的输出必须逐字相同（下面逐例比对）。
    expect(service.displayGitCommand).toBe(display.displayGitCommand)
    const cases = [
      ['add', '--', 'src/main.jsx'],
      ['add', '--', 'guide for project.md'],
      ['commit', '-m', 'chore: 收尾'],
      ['restore', '--staged', '--', 'a/b c.md'],
    ]
    for (const argv of cases) {
      expect(displayGitCommand(argv), argv.join(' ')).toBe(display.displayGitCommand(argv))
      expect(displayGitCommand(argv), argv.join(' ')).toBe(service.displayGitCommand(argv))
    }
  })
})
