const fs = require('node:fs')
const path = require('node:path')

// Matches the per-entry limit RecentRepositories accepts from disk.
const MAX_REPOSITORY_PATH = 4096
const INVALID_PATH = '仓库路径无效。请选择一个本地文件夹。'
const MISSING_PATH = '路径不存在，无法打开该仓库。'
const NOT_A_REPOSITORY = '此文件夹不是 Git 仓库。请选择包含 .git 目录的项目文件夹。'
const UNREADABLE_REPOSITORY = '无法读取仓库根目录。请确认文件夹可访问，并选择包含 .git 目录的项目文件夹。'

function isCandidate(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_REPOSITORY_PATH && !value.includes('\0')
}

/**
 * Resolves a candidate folder to its Git worktree root and makes it current.
 *
 * The renderer can pass any local path, so the folder is still validated with
 * `git rev-parse --show-toplevel`; the string from the renderer is never trusted
 * as a repository root. Failures come back as data with a Chinese explanation
 * instead of throwing, because every caller has to show them in the UI.
 */
async function openRepositoryPath({ candidate, commandService, repository, remember, setRepositoryPath }) {
  if (!isCandidate(candidate)) return { ok: false, message: INVALID_PATH }
  const resolved = path.resolve(candidate)
  if (!fs.existsSync(resolved)) return { ok: false, missing: true, message: MISSING_PATH }
  const execution = await commandService.run({ argv: ['rev-parse', '--show-toplevel'], intent: 'Resolve repository root', source: 'background', cwd: resolved })
  if (!execution.ok) {
    const notRepository = /not a git repository|not a git repo/i.test(execution.stderr || '')
    return {
      ok: false,
      message: notRepository ? NOT_A_REPOSITORY : UNREADABLE_REPOSITORY,
      execution,
    }
  }
  const reportedRoot = execution.stdout.trim()
  if (!reportedRoot) return { ok: false, message: UNREADABLE_REPOSITORY, execution }
  const root = path.resolve(reportedRoot)
  setRepositoryPath(root)
  // Remember the resolved root, not the folder the user picked.
  remember(root)
  return { ok: true, path: root, state: await repository.state(), execution }
}

module.exports = { openRepositoryPath, MAX_REPOSITORY_PATH }
