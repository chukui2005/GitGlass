import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { executionNotice, GENERIC_GIT_FAILURE, operationNotice } from '../src/user-notices.js'
import { canStartRepositoryContextOperation, resolveRepositoryRefresh } from '../src/repository-refresh.js'

const require = createRequire(import.meta.url)
const { GitCommandService } = require('../electron/git-command-service.cjs')
const { RepositoryService } = require('../electron/repository-service.cjs')
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const renderer = fs.readFileSync(path.join(root, 'src', 'main.jsx'), 'utf8')
const styles = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8')
const mainProcess = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')

describe('V0.5.4 用户提示与技术诊断边界', () => {
  it('真实 Git 失败时通知使用中文兜底，原始 stderr 仅保留在账本记录', async () => {
    const EventEmitter = require('node:events').EventEmitter
    const commands = new GitCommandService({ existsSync: () => true, spawnImpl: () => {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      queueMicrotask(() => { child.stderr.emit('data', Buffer.from('fatal: pathspec is broken')); child.emit('close', 128) })
      return child
    } })
    const execution = await commands.run({ argv: ['add', '--', 'broken.txt'], intent: 'Stage file', source: 'user', cwd: 'D:/repo' })
    expect(operationNotice('stage', { execution })).toEqual({ type: 'error', text: GENERIC_GIT_FAILURE })
    expect(commands.history()[0].stderr).toContain('fatal: pathspec is broken')
  })

  it('本地校验拒绝说明未执行 Git 命令，并保留拒绝原因', () => {
    const commands = new GitCommandService({ idFactory: () => 'id-1', now: () => '2026-11-13T00:00:00.000Z' })
    const record = commands.recordRejection({
      argv: ['add', '--', 'stale.txt'], intent: 'Stage selected files', source: 'user', cwd: 'D:/repo',
      stderr: '所选文件已不在未暂存区，请刷新后重试。', userMessage: '所选文件已不在未暂存区，请刷新后重试。',
    })
    expect(record).toMatchObject({ rejected: true, exitCode: null, displayCommand: '本地校验拒绝，未执行 Git 命令' })
    expect(operationNotice('stageSelected', { execution: record }).text).toBe('本地校验拒绝，未执行 Git 命令。所选文件已不在未暂存区，请刷新后重试。')
    expect(commands.history()[0].stderr).toContain('所选文件已不在未暂存区')
  })

  it('成功命令即使账本有 warning，通知仍准确表示成功', () => {
    const execution = { ok: true, stderr: 'warning: CRLF will be replaced', argv: ['git', 'add', '--', 'note.txt'] }
    expect(operationNotice('stageSelected', { execution })).toEqual({ type: 'success', text: '已暂存所选 1 个文件。' })
    expect(executionNotice('已获取远程更新。', execution)).toEqual({ type: 'success', text: '已获取远程更新。' })
  })

  it('无仓库与无远程返回可行动的中文状态，而不是执行记录的英文 stderr', async () => {
    const noRepoCommands = new GitCommandService({ existsSync: () => false })
    const noRepo = new RepositoryService(noRepoCommands, () => null)
    const state = await noRepo.state()
    expect(state.error).toBe('无法读取工作区状态。请确认仓库仍可访问后刷新。')
    expect(noRepoCommands.history()[0].stderr).toBe('No repository is open.')

    const noRemoteCommands = {
      async run(request) {
        const stdout = request.argv[0] === 'branch' ? 'main\n' : ''
        return { ...request, argv: ['git', ...request.argv], stdout, stderr: '', ok: true, exitCode: 0 }
      },
    }
    const repository = new RepositoryService(noRemoteCommands, () => 'D:/repo')
    const remote = await repository.remoteOverview()
    expect(remote.reason).toBe('此仓库尚未配置远程仓库。')
    expect(remote.suggestion).toContain('添加远程仓库')
  })

  it('状态读取失败会使旧工作区失效：首次启动静默，已有仓库或显式打开时提示中文原因', () => {
    const failed = { ok: false, path: 'D:/old-repo', error: '无法读取工作区状态。请确认仓库仍可访问后刷新。' }
    const initial = resolveRepositoryRefresh(null, failed)
    expect(initial).toMatchObject({ ok: false, clearRepository: true, notify: false, state: { branch: '', files: [] } })

    const existing = resolveRepositoryRefresh('D:/old-repo', failed)
    expect(existing).toMatchObject({ ok: false, clearRepository: true, notify: true, message: failed.error, state: { branch: '', files: [] } })

    const opened = resolveRepositoryRefresh(null, failed, { notifyOnFailure: true })
    expect(opened).toMatchObject({ ok: false, notify: true, message: failed.error })
  })

  it('loading 期间不会启动打开仓库或手动刷新，从而不改变仓库上下文', () => {
    expect(canStartRepositoryContextOperation(true)).toBe(false)
    expect(canStartRepositoryContextOperation(false)).toBe(true)
  })

  it('目录选择、空状态与加载中的危险操作都有可见中文反馈和禁用保护', () => {
    expect(mainProcess).toContain('此文件夹不是 Git 仓库。请选择包含 .git 目录的项目文件夹。')
    expect(renderer).toContain('工作区干净，没有待暂存的改动。')
    expect(renderer).toContain('没有已暂存的改动。')
    expect(renderer).toContain('disabled={loading}')
    expect(renderer).toContain('canStartRepositoryContextOperation(loading)')
    expect(renderer).toContain('onClick={refreshFromUser}')
    expect(styles).toContain('button:disabled{cursor:not-allowed;pointer-events:none}')
    expect(styles).toContain('.row-action:disabled{color:#b6c0ca;opacity:.55}')
  })
})
