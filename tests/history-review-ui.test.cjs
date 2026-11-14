const fs = require('node:fs')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.jsx'), 'utf8')
const ledger = fs.readFileSync(path.join(__dirname, '..', 'src', 'workbench-ledger.js'), 'utf8')
const service = fs.readFileSync(path.join(__dirname, '..', 'electron', 'repository-service.cjs'), 'utf8')
const styles = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')

describe('V0.5.2 history review polish UI structure', () => {
  it('keeps a local search input with match count, clear action, and Ctrl/Cmd+F hint', () => {
    expect(source).toContain('aria-label="搜索提交历史"')
    expect(source).toContain('historySearchShortcut')
    expect(source).toContain('匹配 ${matchCount} / ${total}')
    expect(source).toContain('清除搜索')
    expect(source).toContain('纯前端过滤')
  })
  it('binds Ctrl/Cmd+F to search focus and preserves Esc clear-or-exit', () => {
    expect(source).toContain('action === "focus-history-search"')
    expect(source).toContain('historySearchRef.current?.focus()')
    expect(source).toContain('event.key === "Escape"')
    expect(source).toContain('setHistorySearch("")')
  })
  it('renders two-line rows with relative time and a lightweight HEAD badge', () => {
    expect(source).toContain('isHeadCommit(commit)')
    expect(source).toContain('head-badge')
    expect(source).toContain('relativeTime(commit.authoredAt)')
    expect(source).toContain('fullLocalTime(commit.authoredAt)')
  })
  it('shows complete commit facts including clickable parents and statistics', () => {
    expect(source).toContain('完整 SHA')
    expect(source).toContain('查看父提交')
    expect(source).toContain('初始提交（没有父提交）')
    expect(source).toContain('<dt>邮箱</dt>')
    expect(source).toContain('完整提交说明')
    expect(source).toContain('变更文件 ')
    expect(source).toContain('新增 +')
    expect(source).toContain('删除 −')
  })
  it('labels change kinds with letters and Chinese text, never color alone', () => {
    expect(source).toContain('changeKindLetter[kind]')
    expect(source).toContain('titleFor[kind]')
    expect(source).toContain('file-kind-tag')
  })
  it('explains empty, failure, and binary states in Chinese', () => {
    expect(source).toContain('没有匹配的提交')
    expect(source).toContain('打开仓库后可查看提交历史。')
    expect(source).toContain('正在读取提交历史…')
    expect(source).toContain('二进制文件差异：Git 无法生成文本内容')
    expect(source).toContain('无法比较这两个提交')
  })
  it('keeps the compare flow explicit: base, target, direction, and swap', () => {
    expect(source).toContain('双提交比较')
    expect(source).toContain('交换基准提交与对比提交')
    expect(source).toContain('orderComparePair(value.base, commit)')
    expect(source).toContain('比较方向')
    expect(source).toContain('「基准 → 对比」')
  })
  it('keeps selection while switching files and diffs, and caches commit details', () => {
    expect(source).toContain('detailCache')
    expect(source).toContain('historySelected?.hash === commit.hash && historyDetail')
    expect(source).toContain('返回提交详情')
  })
  it('maps history intents to Chinese ledger labels and background reads', () => {
    expect(ledger).toContain("'Read commit detail and statistics': '读取提交详情'")
    expect(ledger).toContain("'Read commit diff': '读取提交差异'")
    expect(ledger).toContain("'Compare commits': '比较两次提交'")
    expect(ledger).toContain("'Verify history commit': '校验提交存在'")
    expect(ledger).toContain("'Verify tracked history file': '校验文件是否被跟踪'")
    expect(service).toContain("'Compare commits', 'background'")
    expect(service).toContain("'Read commit diff', 'background'")
    expect(service).toContain("'Read recent commits'")
  })
  it('explains an empty repository in Chinese from the service layer', () => {
    expect(service).toContain('此仓库还没有提交记录。')
    expect(service).toContain('仓库状态刷新后选中的提交可能已失效')
  })
  it('keeps the compare button inside the row instead of wrapping below it', () => {
    // P1 回归点：只有 grid-template-columns 而没有 display:grid 时，
    // “比较”按钮会掉到下一行左侧。
    for (const match of styles.matchAll(/\.history-row\{([^}]*)\}/g)) {
      expect(match[1]).toContain('display:grid')
      expect(match[1]).toContain('grid-template-columns:minmax(0,1fr) auto')
    }
    expect(styles).toContain('.compare-pin{align-self:center;justify-self:end;white-space:nowrap')
    // 选中态覆盖整条提交行，而不是只覆盖左侧按钮。
    expect(styles).toContain('.history-row.selected{background:var(--blue-soft);box-shadow:inset 3px 0 var(--blue)}')
  })
  it('formats ledger stdout through a single reusable helper before rendering', () => {
    // P1 回归点：结构化提交详情的 0x1e/0x1f 不能以方框出现在“命令结果”里。
    expect(source).toContain('const text = formatLedgerOutput(body)')
    expect(source).toContain('<pre>{text}</pre>')
    expect(source).not.toContain('<pre>{body}</pre>')
    expect(ledger).toContain('export function formatLedgerOutput(value)')
    expect(ledger).toContain('.replace(/\\u001e/g, \'\\n\')')
    expect(ledger).toContain('.replace(/\\u001f/g, \' · \')')
    // 原始 stdout 仍保留在技术详情说明中，审计能力不丢。
    expect(source).toContain('<span>原始输出</span>')
    expect(source).toContain('仍保留原始')
  })
})
