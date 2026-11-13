// User-facing Chinese labels. Git commands, paths and SHAs stay verbatim; these
// map the internal English intents to the wording shown in the ledger UI.
const intentText = {
  'Resolve repository root': '定位仓库根目录',
  'Read created commit hash': '读取新提交哈希',
  'Read current branch': '读取当前分支',
  'Read working tree status': '读取工作区状态',
  'Read file diff': '读取文件差异',
  'Read diff': '读取文件差异',
  'Stage file': '暂存文件',
  'Unstage file': '取消暂存文件',
  'Stage all changes': '暂存全部改动',
  'Stage selected files': '暂存所选文件',
  'Unstage all changes': '取消全部暂存',
  'Create commit': '创建提交',
  'Read local branches': '读取本地分支',
  'Read recent commits': '读取提交历史',
  'Verify history commit': '校验提交存在',
  'Verify tracked history file': '校验文件是否被跟踪',
  'Read commit detail and statistics': '读取提交详情',
  'Read commit changed files': '读取提交改动文件',
  'Read commit diff': '读取提交差异',
  'Compare commits': '比较两次提交',
  'Read file history': '读取文件历史',
  'Read historical file diff': '读取文件历史差异',
  'List remotes': '读取远程列表',
  'Read branch upstream': '读取分支上游',
  'Read remote URL': '读取远程地址',
  'Read ahead and behind counts': '读取领先与落后计数',
  'Fetch remote': 'Fetch 远程',
  'Push branch safely': '安全推送分支',
  'Pull with fast-forward only': '仅 fast-forward 拉取',
  'Validate branch name': '校验分支名',
  'Validate branch name for deletion': '校验待删除分支名',
  'Create and switch branch': '创建并切换分支',
  'Switch branch': '切换分支',
  'Check fast-forward safety': '检查 fast-forward 安全性',
  'Check tracked file for discard': '检查丢弃文件是否被跟踪',
  'Read discard diff summary': '读取丢弃差异摘要',
  'Discard unstaged file changes': '丢弃未暂存改动',
  'Check local branch exists': '检查本地分支是否存在',
  'Check branch merged into current HEAD': '检查分支是否已合并',
  'Delete merged local branch': '删除已合并分支',
  'Read recovery reflog': '读取恢复 reflog',
  'Validate rescue branch name': '校验救援分支名',
  'Verify rescue commit': '验证救援提交',
  'Check rescue branch does not exist': '检查救援分支是否已存在',
  'Create reflog rescue branch': '创建救援分支',
}

export function intentLabel(record) {
  const mapped = record?.intent ? intentText[record.intent] : ''
  return mapped || (record?.source === 'background' ? '系统读取' : '用户执行')
}

// 账本“命令结果”的展示层格式化。Git 的结构化格式（如 --pretty=format:%B%x1e%an%x1f%ae）
// 用 0x1e 记录分隔符和 0x1f 单元分隔符分隔字段，直接渲染会变成不可读的方框。
// 这里只在展示时转换；命令记录中的原始 stdout 仍原样保留，审计不受影响。
export function formatLedgerOutput(value) {
  if (typeof value !== 'string' || !value) return ''
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\u001e/g, '\n') // 记录分隔符 → 换行
    .replace(/\u0000/g, '\n') // -z 输出中的 NUL 分隔 → 换行
    .replace(/\u001f/g, ' · ') // 单元分隔符 → 可读分隔符
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001d\u007f]/g, '') // 其余控制字符
    .replace(/\ufffd/g, '') // 无效 UTF-8 解码出的替代方框
    .replace(/\n{3,}/g, '\n\n')
    // 只裁掉首尾空行；porcelain 状态码前导空格是有意义的数据，不能 trim 掉。
    .replace(/^\n+|\n+$/g, '')
}

export function recordTypeLabel(source) {
  return source === 'background' ? '系统读取' : '用户执行'
}

export function recordStatusLabel(record) {
  if (!record) return '尚无记录'
  if (record.ok === false) return '失败'
  return record.stderr ? '警告' : '成功'
}

export function glanceSummary(record) {
  return record ? `最近：${intentLabel(record)} · ${recordStatusLabel(record)}` : '尚无命令记录'
}

export function countBySource(records) {
  return {
    user: records.filter((record) => record.source === 'user').length,
    background: records.filter((record) => record.source === 'background').length,
  }
}

export function filterLedgerRecords(records, filter, focusedOperationId = null) {
  const byFilter = filter === 'all'
    ? records
    : records.filter((record) => record.source === filter)

  if (filter !== 'user' || !focusedOperationId) return byFilter

  const focused = byFilter.filter((record) => record.operationId === focusedOperationId)
  return focused.length ? focused : byFilter
}

export function groupBackgroundRecords(records) {
  const groups = []
  const byCycle = new Map()

  for (const record of records) {
    const cycleId = record.refreshCycleId
    if (!cycleId) {
      groups.push({ type: 'entry', record })
      continue
    }

    if (!byCycle.has(cycleId)) {
      const group = { type: 'refresh', id: cycleId, records: [] }
      byCycle.set(cycleId, group)
      groups.push(group)
    }
    byCycle.get(cycleId).records.push(record)
  }

  return groups
}
