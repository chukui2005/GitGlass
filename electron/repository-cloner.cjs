const fs = require('node:fs')
const path = require('node:path')
const { NETWORK_TIMEOUT_MS, displayGitCommand } = require('./git-command-service.cjs')
const { MAX_REPOSITORY_PATH } = require('./repository-opener.cjs')

// Cloning takes an address from the renderer, so everything it needs (protocol,
// target folder, final directory) is validated here before a single Git argument
// exists. Git itself stays the authority for whether the clone can run; this module
// only decides which inputs may reach it, which transport may run, and how a failure
// is explained.
const MAX_CLONE_SOURCE = 2048
const MAX_REPOSITORY_NAME = 100
const CLONE_INTENT = 'Clone repository'
// Every address-bearing string (preview command, record stdout/stderr) is built
// through the placeholder, so a credential component can never reach the UI or the
// ledger even if validation were loosened by a later change.
const PLACEHOLDER = '<redacted>'

const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i
// `git@github.com:owner/repo.git` — one username, one host, then a path. No password
// field exists in this form, so it is a normal SSH address.
const SCP_LIKE = /^[A-Za-z0-9._~-]+@[A-Za-z0-9._-]+:(?!\/)/
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/
const POSIX_ABSOLUTE = /^\//
// eslint-disable-next-line no-control-regex -- 地址与文件夹名就是按控制字符判无效的
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/
// eslint-disable-next-line no-control-regex -- 同上：这些字符不能进入文件夹名
const INVALID_NAME_CHARACTER = /[<>:"/\\|?*\u0000-\u001f\u007f]/
// eslint-disable-next-line no-control-regex -- 与上一行同一字符集，带 g 供 replace 使用
const INVALID_NAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const SUPPORTED_SCHEMES = new Set(['https', 'http', 'ssh', 'git', 'file'])
// Git's own transport names. `kind: path` (a local folder) travels over `file`.
const PROTOCOL_FOR_SCHEME = { https: 'https', http: 'http', ssh: 'ssh', git: 'git', file: 'file', path: 'file' }
const SENSITIVE_QUERY_KEY = /^(?:access_token|auth|key|password|passwd|pwd|secret|token)$/i
const CLONE_REQUEST_KEYS = new Set(['source', 'parent', 'name'])
const OPERATION_ID = /^[A-Za-z0-9._:-]{1,128}$/
// Same shapes as git-command-service's credential filter, but the replacement here is
// a visible placeholder instead of a silent strip.
const USERINFO_IN_TEXT = /([a-z][a-z0-9+.-]*:\/\/)[^/\s@"']*@/gi
const SECRET_QUERY_IN_TEXT = /([?&](?:access_token|auth|key|password|passwd|pwd|secret|token)=)[^&\s"']+/gi

const REASON = {
  invalidSource: '请输入仓库地址：HTTPS 或 SSH 地址（例如 https://host/owner/repo.git），也可以使用本地仓库路径。',
  unsupportedScheme: '暂不支持这种协议的地址。请使用 HTTPS 或 SSH 地址。',
  embeddedCredential: '地址中包含内嵌的用户名或令牌，GitGlass 不会执行或记录这类地址。请移除后重试；认证请使用本机 Git 凭据。',
  sshPassword: 'SSH 地址里包含密码，GitGlass 不会执行或记录这类地址。请改用 SSH 密钥或本机凭据管理器。',
  secretQuery: '地址的查询参数里带有令牌类字段（含百分号编码写法），GitGlass 不会执行或记录这类地址。请移除后重试。',
  invalidParent: '请选择克隆的目标位置（一个本地文件夹）。',
  missingParent: '目标位置不存在或无法访问，请重新选择。',
  parentNotDirectory: '目标位置不是文件夹，请重新选择。',
  invalidName: '仓库文件夹名无效：不能包含 \\ / : * ? " < > |，不能是 . 或 ..，也不能以空格或句点结尾。',
  reservedName: '仓库文件夹名是 Windows 保留名称，请换一个名称。',
  targetIsFile: '目标位置已存在同名文件，请换一个名称或位置。',
  targetNotEmpty: '目标目录已有内容，请换一个空目录或新的名称。',
}

/** @param {string} value */
function decodeQueryComponent(value) {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '))
  } catch {
    return value
  }
}

/**
 * True when a query parameter name means "secret", including percent-encoded
 * spellings such as `access%5Ftoken` or `%74oken`.
 *
 * @param {string} key
 * @returns {boolean}
 */
function isSensitiveQueryKey(key) {
  const decoded = decodeQueryComponent(key)
  return SENSITIVE_QUERY_KEY.test(decoded) || SENSITIVE_QUERY_KEY.test(key)
}

/**
 * Redacts the credential-bearing parts of an address for display and for records.
 * HTTPS/HTTP user info is replaced as a whole (a username there is usually a token),
 * an SSH password is replaced while the SSH username is kept, and sensitive query
 * values become the placeholder. Fragments are dropped: they are never sent to Git.
 *
 * @param {string} value
 * @returns {string}
 */
function redactCloneSource(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return ''
  if (!SCHEME.test(text)) return text
  let url
  try {
    url = new URL(text)
  } catch {
    return text.replace(USERINFO_IN_TEXT, `$1${PLACEHOLDER}@`).replace(SECRET_QUERY_IN_TEXT, `$1${PLACEHOLDER}`)
  }
  const scheme = url.protocol.replace(/:$/, '').toLowerCase()
  const hasUserInfo = Boolean(url.username || url.password)
  let display = `${scheme}://`
  if (hasUserInfo) {
    if (scheme === 'ssh') display += url.password ? `${url.username}:${PLACEHOLDER}@` : `${url.username}@`
    else display += `${PLACEHOLDER}@`
  }
  display += url.host
  display += url.pathname
  const query = [...url.searchParams.entries()]
    .map(([key, entry]) => `${encodeURIComponent(key)}=${isSensitiveQueryKey(key) ? PLACEHOLDER : encodeURIComponent(entry)}`)
    .join('&')
  if (query) display += `?${query}`
  return display
}

/**
 * Replaces credentials in Git output with the same placeholder. This runs on top of
 * GitCommandService's own stripping so a URL a remote echoes back still reads as
 * `<redacted>` in the ledger instead of silently losing a component.
 *
 * @param {string} text
 * @returns {string}
 */
function redactCloneOutput(text) {
  return String(text ?? '').replace(USERINFO_IN_TEXT, `$1${PLACEHOLDER}@`).replace(SECRET_QUERY_IN_TEXT, `$1${PLACEHOLDER}`)
}

/**
 * Classifies a clone source structurally: `new URL` for anything with a scheme, the
 * scp-like form for `user@host:path`, and absolute local paths (which real-Git tests
 * and local mirrors need). The returned `value` is exactly what Git receives;
 * `display` is the placeholder-redacted form used by previews and records.
 *
 * @param {unknown} input
 * @returns {{ ok: boolean, kind?: 'url' | 'ssh' | 'path', scheme?: string, protocol?: string, value?: string, display?: string, reason?: string }}
 */
function classifyCloneSource(input) {
  if (typeof input !== 'string') return { ok: false, reason: REASON.invalidSource }
  const value = input.trim()
  if (!value || value.length > MAX_CLONE_SOURCE || CONTROL_CHARACTER.test(value)) return { ok: false, reason: REASON.invalidSource }
  const matched = SCHEME.exec(value)
  if (matched) {
    const scheme = matched[1].toLowerCase()
    if (!SUPPORTED_SCHEMES.has(scheme)) return { ok: false, reason: REASON.unsupportedScheme }
    let url
    try {
      url = new URL(value)
    } catch {
      return { ok: false, reason: REASON.invalidSource }
    }
    if (!url.hostname) return { ok: false, reason: REASON.invalidSource }
    if (scheme === 'ssh') {
      // A password in an SSH URL is credential material, not an address part.
      if (url.password) return { ok: false, reason: REASON.sshPassword }
    } else if (url.username || url.password) {
      return { ok: false, reason: REASON.embeddedCredential }
    }
    for (const [key] of url.searchParams) {
      if (isSensitiveQueryKey(key)) return { ok: false, reason: REASON.secretQuery }
    }
    const kind = scheme === 'ssh' ? 'ssh' : scheme === 'file' ? 'path' : 'url'
    return { ok: true, kind, scheme, protocol: PROTOCOL_FOR_SCHEME[scheme], value, display: redactCloneSource(value) }
  }
  if (SCP_LIKE.test(value)) return { ok: true, kind: 'ssh', scheme: 'ssh', protocol: 'ssh', value, display: value }
  if (WINDOWS_ABSOLUTE.test(value) || POSIX_ABSOLUTE.test(value)) {
    return { ok: true, kind: 'path', scheme: 'path', protocol: 'file', value, display: value }
  }
  return { ok: false, reason: REASON.invalidSource }
}

/**
 * Git config overrides that pin the clone child process to the transport the address
 * was classified as. `protocol.allow=never` turns "anything Git knows" into "only what
 * this address needs", which is what stops an `url.<base>.insteadOf` rewrite (or a
 * future `ext::` helper) from moving a validated HTTPS address onto the local file
 * transport — or anything else.
 *
 * @param {{ protocol?: string }} classified
 * @returns {string[]}
 */
function cloneProtocolArgs(classified) {
  const protocol = classified.protocol || 'file'
  return ['-c', 'protocol.allow=never', '-c', `protocol.${protocol}.allow=always`]
}

/**
 * The preview line: protocol overrides plus the placeholder-redacted address.
 *
 * @param {{ protocol?: string, display?: string }} classified
 * @param {string} name
 * @returns {string}
 */
function cloneDisplayCommand(classified, name) {
  return displayGitCommand([...cloneProtocolArgs(classified), 'clone', '--', classified.display || '', name])
}

/**
 * The folder name Git would use by default: the last segment of the address with a
 * trailing `.git` removed. An address without a usable segment falls back to
 * `repository` instead of failing.
 *
 * @param {{ kind: string, value: string }} source
 * @returns {string}
 */
function sourceRepositoryName(source) {
  let rest = source.value
  const scheme = SCHEME.exec(rest)
  if (scheme) {
    // `scheme://[user@]host[:port]/owner/repo` → `owner/repo`.
    rest = rest.slice(scheme[0].length)
    const slash = rest.indexOf('/')
    rest = slash === -1 ? '' : rest.slice(slash + 1)
  } else if (source.kind === 'ssh') {
    // scp-like `user@host:owner/repo` → `owner/repo`.
    rest = rest.slice(rest.indexOf(':') + 1)
  }
  const segments = rest.replace(/[\\/]+$/, '').split(/[\\/]/)
  const last = segments[segments.length - 1] || ''
  return last.replace(/\.git$/i, '') || 'repository'
}

/**
 * Turns any text into one portable folder name: Windows forbids `<>:"/\|?*` and a
 * trailing dot or space, and reserved names such as `CON` cannot be created at all.
 *
 * @param {unknown} input
 * @returns {string}
 */
function sanitizeRepositoryName(input) {
  let name = String(input ?? '').replace(INVALID_NAME_CHARACTERS, '-').trim()
  name = name.replace(/^[. ]+/, '').replace(/[. ]+$/, '')
  if (name.length > MAX_REPOSITORY_NAME) name = name.slice(0, MAX_REPOSITORY_NAME).replace(/[. ]+$/, '')
  if (!name) return 'repository'
  if (WINDOWS_RESERVED_NAME.test(name)) name = `${name}-repo`
  return name
}

/**
 * @param {unknown} input 用户填写的仓库文件夹名；留空表示按地址推导。
 * @param {{ kind: string, value: string }} source
 * @returns {{ ok: boolean, name?: string, derived?: boolean, reason?: string }}
 */
function resolveRepositoryName(input, source) {
  if (input === undefined || input === null || (typeof input === 'string' && input.trim() === '')) {
    return { ok: true, name: sanitizeRepositoryName(sourceRepositoryName(source)), derived: true }
  }
  if (typeof input !== 'string') return { ok: false, reason: REASON.invalidName }
  const raw = input.trim()
  if (!raw || raw.length > MAX_REPOSITORY_NAME || CONTROL_CHARACTER.test(raw)) return { ok: false, reason: REASON.invalidName }
  if (raw === '.' || raw === '..') return { ok: false, reason: REASON.invalidName }
  if (INVALID_NAME_CHARACTER.test(raw) || /[. ]$/.test(raw)) return { ok: false, reason: REASON.invalidName }
  if (WINDOWS_RESERVED_NAME.test(raw)) return { ok: false, reason: REASON.reservedName }
  return { ok: true, name: raw, derived: false }
}

/**
 * Validates the chosen parent folder plus folder name and returns the exact target
 * directory. A new folder and an existing empty folder are both allowed: Git itself
 * accepts either, and both leave the user's other files untouched on failure.
 *
 * @param {{ parent: unknown, name: unknown, source: { kind: string, value: string } }} options
 * @returns {{ ok: boolean, parent?: string, name?: string, target?: string, existingEmpty?: boolean, reason?: string }}
 */
function validateCloneTarget({ parent, name, source }) {
  if (typeof parent !== 'string' || !parent.trim() || parent.length > MAX_REPOSITORY_PATH || CONTROL_CHARACTER.test(parent)) {
    return { ok: false, reason: REASON.invalidParent }
  }
  const resolvedParent = path.resolve(parent.trim())
  let stats
  try {
    stats = fs.statSync(resolvedParent)
  } catch {
    return { ok: false, reason: REASON.missingParent }
  }
  if (!stats.isDirectory()) return { ok: false, reason: REASON.parentNotDirectory }
  const resolvedName = resolveRepositoryName(name, source)
  if (!resolvedName.ok) return resolvedName
  const target = path.join(resolvedParent, resolvedName.name)
  // Defense in depth: `resolveRepositoryName` already refuses separators, and this
  // check makes "the target is a child of the chosen folder" an invariant.
  if (path.dirname(target) !== resolvedParent) return { ok: false, reason: REASON.invalidName }
  if (target.length > MAX_REPOSITORY_PATH || !fs.existsSync(target)) {
    return { ok: true, parent: resolvedParent, name: resolvedName.name, target, existingEmpty: false }
  }
  let targetStats
  try {
    targetStats = fs.statSync(target)
  } catch {
    return { ok: false, reason: REASON.missingParent }
  }
  if (!targetStats.isDirectory()) return { ok: false, reason: REASON.targetIsFile }
  let entries
  try {
    entries = fs.readdirSync(target)
  } catch {
    return { ok: false, reason: REASON.targetIsFile }
  }
  if (entries.length) return { ok: false, reason: REASON.targetNotEmpty }
  return { ok: true, parent: resolvedParent, name: resolvedName.name, target, existingEmpty: true }
}

/**
 * Reads the renderer's clone request. Unknown keys are refused so the IPC surface
 * cannot grow arguments (for example argv or a working directory) by accident.
 *
 * @param {unknown} input
 * @param {{ allowOperationId?: boolean }} [options]
 * @returns {{ ok: boolean, source?: string, parent?: string, name?: string, operationId?: string | null, reason?: string }}
 */
function normalizeCloneRequest(input, { allowOperationId = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: REASON.invalidSource }
  /** @type {Record<string, any>} */
  const raw = input
  const keys = Object.keys(raw)
  const allowed = allowOperationId ? new Set([...CLONE_REQUEST_KEYS, 'operationId']) : CLONE_REQUEST_KEYS
  if (keys.some((key) => !allowed.has(key))) return { ok: false, reason: '克隆请求包含不支持的字段。' }
  /** @type {{ source: string, parent: string, name: string, operationId: string | null }} */
  const request = {
    source: typeof raw.source === 'string' ? raw.source : '',
    parent: typeof raw.parent === 'string' ? raw.parent : '',
    name: typeof raw.name === 'string' ? raw.name : '',
    operationId: null,
  }
  if (allowOperationId && raw.operationId !== undefined && raw.operationId !== null) {
    if (typeof raw.operationId !== 'string' || !OPERATION_ID.test(raw.operationId)) return { ok: false, reason: '克隆请求的操作标识无效。' }
    request.operationId = raw.operationId
  }
  return { ok: true, ...request }
}

/**
 * Builds the reviewed plan without running anything. `argv` is exactly what
 * `executeClone` will run — protocol pinned, address as one data argument after `--`,
 * folder name as the only other argument — while `displayCommand` is built from the
 * placeholder form so the preview can never show a credential.
 *
 * @param {{ source: unknown, parent: unknown, name?: unknown, commandService: any, operationId?: string | null }} options
 * @returns {{ ok: boolean, blocked?: boolean, reason?: string, source?: any, parent?: string, name?: string, target?: string | null, existingEmpty?: boolean, plan?: any }}
 */
function prepareClone({ source, parent, name, commandService, operationId = null }) {
  const classified = classifyCloneSource(source)
  if (!classified.ok) return { ok: false, blocked: true, reason: classified.reason, plan: null, target: null }
  /** @type {{ kind: string, scheme: string, protocol: string, value: string, display: string }} */
  const cloneSource = /** @type {any} */ (classified)
  const target = validateCloneTarget({ parent, name, source: cloneSource })
  if (!target.ok) return { ok: false, blocked: true, reason: target.reason, plan: null, target: null }
  const argv = [...cloneProtocolArgs(cloneSource), 'clone', '--', cloneSource.value, target.name]
  const planned = commandService.plan({ argv, intent: CLONE_INTENT, cwd: target.parent, operationId })
  return {
    ok: true,
    blocked: false,
    source: { kind: cloneSource.kind, scheme: cloneSource.scheme, protocol: cloneSource.protocol, display: cloneSource.display },
    parent: target.parent,
    name: target.name,
    target: target.target,
    existingEmpty: target.existingEmpty,
    plan: { ...planned, displayCommand: cloneDisplayCommand(cloneSource, target.name) },
  }
}

/**
 * Explains a real Git failure in Chinese. The CommandRecord keeps the raw stderr;
 * this only decides which sentence the dialog shows first.
 *
 * @param {any} record
 * @returns {string}
 */
function describeCloneFailure(record) {
  if (record?.timedOut) return '克隆超时：命令在限定时间内没有完成，已终止。请确认网络后重试。'
  const stderr = String(record?.stderr || '')
  if (/authentication failed|could not read Username|could not read Password|permission denied \(publickey\)|terminal prompts disabled|authentication required|access denied|invalid username or password/i.test(stderr)) {
    return '认证失败：请确认本机 Git 已配置可用的凭据（凭据管理器或 SSH 密钥）。GitGlass 不会代你输入密码。'
  }
  if (/already exists and is not an empty directory|destination path .* already exists/i.test(stderr)) {
    return '目标目录已存在且非空，请换一个名称或位置后重试。'
  }
  if (/transport '[a-z:]+' not allowed|protocol '[a-z:]+' is not allowed/i.test(stderr)) {
    return 'Git 拒绝了这次克隆使用的传输协议：地址被 Git 配置改写到了未允许的协议。请检查本机 Git 的 url.*.insteadOf 配置后重试。'
  }
  if (/repository .* not found|does not appear to be a git repository|could not read from remote repository|does not exist/i.test(stderr)) {
    return '远程仓库不存在或当前身份无权访问，请核对地址与权限。'
  }
  if (/unable to access|could not resolve host|failed to connect|connection (timed out|refused)|network is unreachable/i.test(stderr)) {
    return '无法连接远程仓库，请检查地址、网络与代理设置。'
  }
  return '克隆失败，请查看命令账本中的真实命令、退出码与错误输出。'
}

/**
 * Runs the reviewed clone plan as one user CommandRecord. Nothing is cleaned up
 * here: Git removes what it created itself, and an existing target folder is left
 * exactly as the user had it. Output redaction uses the placeholder, not a silent
 * strip, so an echoed URL reads as `<redacted>` in the ledger.
 *
 * @param {{ source: unknown, parent: unknown, name?: unknown, commandService: any, operationId?: string | null }} options
 * @returns {Promise<{ ok: boolean, target?: string | null, plan?: any, execution?: any, reason: string }>}
 */
async function executeClone({ source, parent, name, commandService, operationId = null }) {
  const prepared = prepareClone({ source, parent, name, commandService, operationId })
  if (!prepared.ok) return { ok: false, target: null, plan: null, execution: null, reason: prepared.reason }
  // Cloning talks to a remote: allow the same longer deadline as fetch/push/pull.
  const execution = await commandService.run({
    argv: prepared.plan.argv,
    intent: CLONE_INTENT,
    source: 'user',
    cwd: prepared.parent,
    operationId: prepared.plan.operationId,
    timeoutMs: NETWORK_TIMEOUT_MS,
    redactOutput: redactCloneOutput,
  })
  if (!execution.ok) {
    return { ok: false, target: prepared.target, plan: prepared.plan, execution, reason: describeCloneFailure(execution) }
  }
  return { ok: true, target: prepared.target, plan: prepared.plan, execution, reason: '' }
}

module.exports = {
  classifyCloneSource,
  redactCloneSource,
  redactCloneOutput,
  cloneProtocolArgs,
  cloneDisplayCommand,
  sourceRepositoryName,
  sanitizeRepositoryName,
  resolveRepositoryName,
  validateCloneTarget,
  normalizeCloneRequest,
  prepareClone,
  executeClone,
  describeCloneFailure,
  CLONE_INTENT,
  MAX_CLONE_SOURCE,
  MAX_REPOSITORY_NAME,
  PLACEHOLDER,
  REASON,
}
