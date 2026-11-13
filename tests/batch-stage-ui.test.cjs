const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.jsx'), 'utf8')
const ledger = fs.readFileSync(path.join(__dirname, '..', 'src', 'workbench-ledger.js'), 'utf8')
const service = fs.readFileSync(path.join(__dirname, '..', 'electron', 'repository-service.cjs'), 'utf8')
const commandService = fs.readFileSync(path.join(__dirname, '..', 'electron', 'git-command-service.cjs'), 'utf8')
const mainProcess = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
const styles = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')

// 从 main.jsx 中提取每个 FileSection 区块的源码片段，用于按区块断言。
// split 会消耗 <FileSection 标记：parts[1] 是未暂存区，parts[2] 从已暂存区开始。
function fileSectionBlocks() {
  const parts = source.split('<FileSection')
  expect(parts.length).toBe(3)
  const stagedEnd = parts[2].indexOf('/>')
  return [parts[1], parts[2].slice(0, stagedEnd + 2)]
}

// 提取 FileRow 组件源码：加载期间单文件操作必须禁用。
function fileRowBlock() {
  return source.split('function FileRow')[1].split('function FileSection')[0]
}

describe('V0.5.3 batch stage UI structure', () => {
  it('renders checkboxes only in the unstaged section with per-path aria-labels', () => {
    const [unstagedBlock, stagedBlock] = fileSectionBlocks()
    expect(unstagedBlock).toContain('title="未暂存改动"')
    expect(unstagedBlock).toContain('checkable')
    expect(unstagedBlock).toContain('BatchStageToolbar')
    expect(stagedBlock).toContain('title="已暂存改动"')
    // 已暂存区不渲染复选框：没有 checkable 与勾选相关属性。
    expect(stagedBlock).not.toContain('checkable')
    expect(stagedBlock).not.toContain('isChecked')
    expect(stagedBlock).not.toContain('onToggleCheck')
    // 复选框 aria-label 必须包含文件路径。
    expect(source).toContain('aria-label={`选择暂存 ${file.path}`}')
  })

  it('disables every control that mutates the staging area while loading (P2)', () => {
    const row = fileRowBlock()
    // 复选框与单文件“暂存/取消暂存”按钮在加载期间都必须禁用。
    expect(row).toContain('disabled={busy}')
    expect((row.match(/disabled=\{busy\}/g) || []).length).toBe(2)
    // 单文件操作按钮保留 aria-label 与 title。
    expect(row).toContain('aria-label={stageLabel}')
    expect(row).toContain('title={stageLabel}')
    // 工具栏三个按钮也都在加载期间禁用。
    expect(source).toContain('disabled={!total || loading}')
    expect(source).toContain('disabled={!count || loading}')
  })

  it('explains the disabled primary action with visible text, not only the unhoverable title (P2)', () => {
    expect(source).toContain('先在上方勾选要暂存的文件。')
    expect(source).toContain('batch-hint')
    // 可见提示与按钮 title 并存，但提示不依赖 disabled 按钮的 title。
    expect(source).toContain('{!count && !loading && (')
    expect(styles).toContain('.batch-hint{margin:0;color:var(--muted);font-size:10px;line-height:1.4}')
  })

  it('provides a compact toolbar: select all, clear, live count, and a disabled-with-reason primary action', () => {
    expect(source).toContain('全选未暂存')
    expect(source).toContain('清除选择')
    expect(source).toContain('已选择 {count} 个')
    expect(source).toContain('暂存所选 {count} 个')
    expect(source).toContain('aria-live="polite"')
    expect(source).toContain('disabled={!count || loading}')
    expect(source).toContain('title={stageTitle}')
    // “暂存所选”通过真实 argv 操作执行，绝不使用 git add . 或 git add -A 实现批量暂存。
    expect(source).toContain('operate("stageSelected", {')
    expect(source).toContain('paths: checkedForStaging.map((file) => file.path)')
    // 原有“暂存全部”能力保留（右侧提交面板 secondary 按钮 + 预览）。
    expect(source).toContain('暂存全部')
  })

  it('keeps batch selection decoupled from the diff selection and keyed by area + path', () => {
    // 稳定键：area + path，而不是数组下标。
    expect(source).toContain('const stageSelectionKey = (path) => `unstaged:${path}`')
    // 勾选与右侧 Diff 选中是两个独立状态：loadDiff 不触碰 stageSelection。
    expect(source).not.toContain('setStageSelection(undefined')
    // 不可变更新：一律创建新的 Set，不直接修改原 Set。
    expect(source).toContain('const next = new Set(previous)')
    // 全选 / 清除 / 暂存所选都是真实的 button，不是可点击的 div。
    for (const label of ['全选未暂存', '清除选择']) {
      const buttonMatch = source.match(new RegExp(`<button[^>]*>\\s*${label}\\s*<\\/button>`))
      expect(buttonMatch, label).toBeTruthy()
      expect(buttonMatch[0]).toContain('type="button"')
    }
  })

  it('realigns the selection with the current unstaged list and clears it when switching repositories', () => {
    // 刷新 / 暂存成功后：选择集合只保留仍存在于未暂存区的项目（不留幽灵选择）。
    expect(source).toContain('移除已不存在于未暂存区的幽灵选择')
    expect(source).toContain('if (valid.has(key)) next.add(key)')
    expect(source).toContain('return changed ? next : previous')
    // 切换仓库后清空选择集合。
    expect(source).toContain('切换仓库后清空批量暂存选择')
    expect(source).toContain('setStageSelection(new Set())')
  })

  it('shows honest Chinese feedback for failures without pretending atomic completion', () => {
    expect(source).toContain('暂存未全部完成，请查看命令账本与当前文件状态。')
    // 本地校验被拒（记录带 rejected 标记）时直接展示中文原因。
    expect(source).toContain('execution?.rejected')
    expect(source).toContain('所选文件无效，本次未执行 Git 命令；请刷新后重试。')
    // 成功提示按实际 argv 数量计数。
    expect(source).toContain('已暂存所选')
  })

  it('enforces the server-side unstaged whitelist before running git add (P1)', () => {
    // 执行前先读一次工作区状态，只接受精确匹配 area === unstaged 的路径。
    expect(service).toContain('const state = await this.state()')
    expect(service).toContain("state.files.filter((file) => file.area === 'unstaged')")
    expect(service).toContain('所选文件已不在未暂存区，请刷新后重试。')
    // 校验拒绝进入账本：明确标注“本地校验拒绝，未执行 Git 命令”，带 rejected 标记与空退出码。
    expect(service).toContain('this.rejectedStage(')
    expect(commandService).toContain("recordRejection({ argv = [], intent, source, cwd, stderr = '' })")
    expect(commandService).toContain("'本地校验拒绝，未执行 Git 命令'")
    expect(commandService).toContain('exitCode: null, ok: false, outputTruncated: false, rejected: true')
    // 白名单依赖每个未暂存条目都是精确文件路径：未跟踪文件不折叠成目录。
    expect(service).toContain("'--untracked-files=all'")
    // 成功路径仍是一条真实命令。
    expect(service).toContain("this.run(['add', '--', ...normalized.paths], 'Stage selected files', 'user')")
  })

  it('labels a locally rejected record as 已拒绝 instead of a failed command', () => {
    expect(ledger).toContain('if (record.rejected) return \'已拒绝\'')
  })

  it('maps the new intent to a Chinese ledger label and routes it through git:operate', () => {
    expect(ledger).toContain("'Stage selected files': '暂存所选文件'")
    expect(mainProcess).toContain("repository.stageSelected(payload.paths)")
    // 成功与失败都返回刷新后的 state：main.cjs 的返回结构对所有操作一致。
    expect(mainProcess).toContain('return { execution, state: await repository.state(), commit }')
  })

  it('styles the toolbar and checkboxes with the restrained GitGlass visual language', () => {
    // 紧凑工具栏：单行按钮不换行，主按钮蓝色、禁用态灰色。
    expect(styles).toContain('.batch-toolbar{display:grid;gap:4px')
    expect(styles).toContain('.batch-tools-row{display:flex;gap:4px}')
    expect(styles).toContain('.batch-tool{flex:1;min-width:0;overflow:hidden')
    expect(styles).toContain('.batch-stage{flex:none;display:inline-flex;align-items:center;justify-content:center;min-height:24px')
    expect(styles).toContain('.batch-stage:not(:disabled):hover{background:#2659BE}')
    expect(styles).toContain('.batch-stage:disabled{background:#f3f5f7;color:#98a2b3}')
    // 复选框可见焦点与蓝色 accent。
    expect(styles).toContain('.stage-check{flex:none;margin:0 0 0 7px;width:13px;height:13px;accent-color:var(--blue)')
    expect(styles).toContain('.stage-check:focus-visible{outline:2px solid var(--blue);outline-offset:1px}')
    // 不引入深色终端风或渐变。
    expect(styles).not.toContain('linear-gradient')
  })
})
