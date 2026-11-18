# 改进路线（代码评审结论）

依据：`electron/`（1057 行）、`src/`（约 3300 行，其中 `main.jsx` 2693 行）、`tests/`（32 文件 / 168 用例）、发布链与 0.6.x 发版实践的一次完整通读。
排序原则：先修"会挂死/会难看"的，再修"天天用得到"的，最后修"效率"。

## P0 稳定性（会让应用卡死或数据难看）

> 状态：**四项已实现**（超时与禁用凭据提示、默认脱敏、输出上限、空仓库取消暂存），覆盖测试见 `tests/unit/git-command-service.test.cjs` 与 `tests/integration/empty-repository.integration.test.cjs`。

| # | 问题 | 位置 | 修法 |
| --- | --- | --- | --- |
| 1 | `git push/pull/fetch` **没有超时**，也没有禁用凭据交互提示，网络卡住会让进程永久挂起，并占住 `operationGate` | `electron/git-command-service.cjs:84` | `spawn` 增加 `timeout` 并在超时后 `kill`；`env` 注入 `GIT_TERMINAL_PROMPT=0`、`GIT_ASKPASS=`；记录里标记 `timedOut` 并给中文提示 | ✅
| 2 | 凭据脱敏只覆盖 `git remote get-url`，push/fetch 失败时的 stderr 可能带 `https://user:token@…` 进入账本与渲染层 | `repository-service.cjs:267`、`git-command-service.cjs:66-69` | 把脱敏做进 `GitCommandService.run()` 的默认路径（正则剥离 `://[^@/\s]+@`、`[?&](token|access_token|auth)=`） | ✅
| 3 | 账本最多 300 条，但每条保留完整 stdout/stderr；只有 3 处 diff 有 1 MiB 上限，`repo:ledger` 每次整体 IPC | `git-command-service.cjs:34,73-75`、`main.cjs:82` | 每条记录默认截到 64 KiB 并标 `outputTruncated`；`repo:ledger` 分页/按需取单条 | ✅
| 4 | 空仓库（无提交）里"取消暂存单个文件"必失败：`git restore --staged` 需要 HEAD | `repository-service.cjs:111`（实测 `fatal: could not resolve HEAD`） | 先探测 `git rev-parse --verify HEAD`，空仓库改用 `git reset -- <path>`；补一条 integration 测试 | ✅

## P1 日常可用性（决定能不能当主力）

| # | 问题 | 位置 | 修法 |
| --- | --- | --- | --- |
| 5 | **不记得最近打开的仓库**：`repoPath` 只来自 `GITGLASS_REPOSITORY` 环境变量或更新恢复，每次启动都要重新选 | `main.cjs:12,125-128` | `userData/recent-repos.json` 存最近 5 个，启动自动打开最后一个，顶栏提供切换 | ✅
| 6 | 多处异步操作缺 `try/finally`，异常后 `loading` 永久为 `true`（界面变灰、所有按钮禁用） | `src/main.jsx:1627,1658,1714,1788,1501` | 统一 `withLoading()` 包装；异常统一走 `setNotice` |
| 7 | `refreshAll` 生成了 `refresh-*` 序号却从不比较，只有历史查询序号生效；快速连点会出现旧响应覆盖新状态 | `src/main.jsx:1376,1391-1398` | 与 `historyQuerySequence` 同款：响应返回时比对序号，丢过期结果 | ✅（序号已比较；loading 兜底未做）
| 8 | 处于 merge / rebase / cherry-pick 中途的仓库没有识别，用户在应用里看到的"脏工作区"提示会误导 | 全局（`.git/MERGE_HEAD` 等均未读取） | `state()` 增加 `operation: 'merge' \| 'rebase' \| null`，UI 明确提示"请在终端完成或中止该操作" | ✅

## 0.6.3 交付（2026-11-18）

v0.6.3 一次性清掉了 P1.5 自动刷新与 0.6.2 验收暴露的视觉/交互问题：

| 交付项 | 落地位置 | 说明 |
| --- | --- | --- |
| 通知横幅自动收起（#13） | `src/notice-lifecycle.js`、`src/main.jsx` | 成功/失败类 6 秒自动收起（悬停与聚焦暂停、可钉住、可手动 ×）；`state.operation` 状态横幅常驻且不可关闭 |
| 远程入口语义（#16） | `src/main.jsx`、`docs/design.md` | 顶栏「同步」改为「获取…」，计划面板首行写明「这一步不会执行任何命令」 |
| 最近仓库切换器（P1.7 / issue #18） | `electron/repository-opener.cjs`、`src/recent-repositories-menu.jsx` | 顶栏下拉列出最近 5 个仓库，当前项高亮、失效项灰显并可移除，支持键盘操作；`repo:open` / `repo:recent` / `repo:recent:forget` 三个 IPC |
| 自动刷新（P1.5） | `electron/repository-watcher.cjs`、`src/auto-refresh.js` | `.git` 关键路径 `fs.watch` + 800ms 去抖 → `repo:changed`；窗口聚焦也刷新；主进程 1.5s / 渲染层 1s 两层静默窗掐断自触发，HEAD/refs 事件可穿过渲染层静默窗 |
| 字号层级（#14） | `src/styles.css` `:root`、`src/main.jsx` 账本 | 三档 token（13/12/11px + 行高），正文逐块提到 12–13px，账本行改两行结构（意图+命令 / 结果·退出码·耗时·时间·来源）；`tests/unit/design-tokens.test.mjs` 与 `tests/ui/ledger-rows.test.cjs` 守住 token 与 DOM 结构 |
| 按钮三档（#15） | `src/styles.css` | 主按钮（实心，页面同一时刻最多 1 个）/ 次按钮（描边）/ 图标按钮（28×28，带 title + aria-label）+ 低权重工具条；统一 hover/active/disabled，禁用只降透明度不改布局；顶栏 1240px 以下折叠为图标 |

工程项（#9–#12）仍未开始，见文末 P2 工程质量。

## P1.5 自动刷新（0.6.3 已实现）

GitGlass 目前只有「启动 / 操作成功 / 手动 ⟳」三个刷新时机，**没有任何自动刷新**（无 `setInterval`、无 `fs.watch`、无 focus 监听）。在终端里执行 `git merge --abort`、`git commit` 之后，界面不会自己更新 —— 这是与 GitHub Desktop（文件监视 + 静默重读）最明显的体验差距。

推荐方案（按性价比）：

| 方案 | 效果 | 成本 |
| --- | --- | --- |
| A 窗口聚焦时刷新 | 终端改完切回窗口自动更新 | 极低：`window.focus` + 复用 `refreshAll` |
| B 监视 `.git` 关键文件（`HEAD`、`index`、`MERGE_HEAD`、`refs/**`、`logs/HEAD`） | 终端提交/切分支在 0.5–1 秒内反映到界面 | 中：主进程 `fs.watch` + 800ms 去抖 + 新增 `repo:changed` 推送；必须处理 `git status` 写 index 缓存导致的自触发（刷新进行中忽略 + 刷新后 1 秒静默窗） |
| C 定时轮询 | 兜底 | 建议默认关闭，仅作为设置项 |

`RefreshGroup` 已经把同一轮的多条读取折叠成一行，自动刷新写入账本的噪音可控。**0.6.2 时决定先走完验收；0.6.3 已按 A + B 落地**：

- A：`window.addEventListener('focus', …)` 触发一次静默刷新（不弹通知、不展开账本）。
- B：`RepositoryWatcher` 监视 `<gitDir>`、`refs`、`refs/heads`、`logs`，把事件归一成 `head` / `refs` / `index` 三类，800ms 去抖后推送 `repo:changed`。
- 自触发抑制：主进程在 6 个写仓库 channel 前后各开 1.5 秒静默窗；渲染层再叠加「刷新进行中丢弃 + 刷新结束后 1 秒静默窗」，但 `head` / `refs` 可穿过——只有 `git status` 会重写 `.git/index`，HEAD/refs 的写入一定来自外部。
- 实测外部 `git add` / `git commit` / `git checkout -b` 后界面在约 1.0–1.2 秒内更新（800ms 去抖 + 一次读取）。
## P1.7 issue #18：最近仓库与「已打开仓库」列表（2026-11-18）

来源：<https://github.com/chukui2005/GitGlass/issues/18>「希望应用重启后恢复关闭前打开的仓库，并且增加已打开仓库记录」（SIKKTIN，2026-11-16，仍 open）。

| issue 中的诉求 | 现状 |
| --- | --- |
| 重启后恢复关闭前打开的仓库 | **已实现并随 v0.6.2 发布**：`RecentRepositories` 记录最近 5 个仓库根，启动顺序为 `GITGLASS_REPOSITORY` → 更新重启草稿 → 最近列表中第一个仍存在的路径 |
| 增加「已打开仓库」记录 | **0.6.3 已实现**：顶栏「打开仓库」右侧新增下拉切换器（`src/recent-repositories-menu.jsx`），列出最近 5 个仓库，当前仓库标「当前」，失效路径灰显标注「路径不存在」并可一键移除 |

实现要点：

1. 主进程：`electron/repository-opener.cjs` 统一「解析目录 → `rev-parse --show-toplevel` → 设为当前仓库 → 记住根目录」；`repo:choose` 与 `repo:open` 共用，渲染层传入的字符串永远不当仓库根使用。`repo:recent` / `repo:recent:forget` 不占 operation gate（没打开仓库时也要能列），`describeRecent()` 每次现算 `exists`。
2. 渲染层：`chooseRepo` 与最近仓库切换共用 `applyOpenedRepository()`，切换仓库时的历史选择、批量勾选、`detailCache` 清理由一处完成。
3. 键盘与可访问性：触发器 `aria-haspopup/aria-expanded`，菜单 `role=menu`、`aria-current`，↑/↓/Home/End/Enter/Esc 与点击外部关闭，移除按钮带中文 `aria-label`。
4. 待办：发布 0.6.3 后回复 issue #18（说明自动恢复在 0.6.2、列表 UI 在 0.6.3），再决定是否关闭。
## P2 视觉与交互打磨（0.6.2 验收反馈，2026-11-17）

0.6.2 手动验收通过，但暴露出以下体验问题。**优先级高于 P2 的工程项**，因为直接影响第一印象。

| # | 问题 | 具体表现 | 建议 |
| --- | --- | --- | --- |
| 13 | **顶部通知横幅常驻，必须手动关闭** | 一次 fetch 失败后横幅一直占据标题栏下方一整行，还挤压工作区（即使已修好 grid 行，仍会持续占位） | ✅ 0.6.3：`src/notice-lifecycle.js` 把"计时"与"渲染"拆开——成功/失败类 6 秒自动收起（悬停/聚焦暂停、可钉住、可 ×），`state.operation` 状态横幅常驻且无可关闭入口；收起后 `has-banner` 自动撤销。**"更窄的状态条"未做**，仍是整行高度 |
| 14 | **小字层级混乱、密度过高** | 侧栏、账本里 10–12px 小字连排（`font-size:11px` 满天飞），次级信息与主信息对比不足 | ✅ 0.6.3：`:root` 建三档 token（`--font-body/secondary/aux` + 对应行高 + `--radius-sm/md`），正文逐块提到 12–13px，计数/时间保持 11px；账本展开态改两行结构（意图 + 等宽命令 / 结果 · 退出码 · 耗时 · 时间 · 来源），长命令单行省略 + `title`。**仍需注意**：`.recent-repositories-*` 里还有 10px 的路径与"路径不存在"标注，下一次动那块时统一到 11px |
| 15 | **工作区按钮视觉权重不分主次** | 顶部 8 个按钮同样大小同样颜色，主操作（打开仓库/同步）与次操作（恢复/历史）没有层次 | ✅ 0.6.3：三档按钮（`.primary-button` 实心 / `.secondary-button` 描边 / `.icon-button` 仅图标）+ 低权重工具条 `.toolbar-button`；统一 28/32px 与 hover/active/disabled 三态，禁用只降 `opacity`；顶栏不放实心主按钮，1240px 以下把文字折叠成图标 |
| 16 | **「同步」按钮语义误导** | 点「同步」只生成计划，要点「确认获取远程更新」才执行；用户以为已经执行 | ✅ 0.6.3：顶栏改为「获取…」（`title`/`aria-label` 说明"先查看计划，不会立即执行"），计划面板首行固定为「这一步不会执行任何命令。」，执行入口只剩面板里的确认按钮；`docs/design.md` 同步更新 |
| 17 | 参考基准 | 目前没有视觉基准，改动容易各修各的 | 仍未取得 dbx 截图；0.6.3 按 `docs/design.md` 里写下的 token（13/12/11 三档 + 三档按钮）实现，视觉基准留到拿到对照截图后再对齐 |

0.6.3 的执行顺序：#13（通知）→ #16（文案）→ #14/#15（token 与按钮，同一批改 `styles.css`）。
## P2 工程质量（决定改得动不动）

| # | 问题 | 现状 | 修法 |
| --- | --- | --- | --- |
| 9 | 没有 lint、没有类型检查、没有覆盖率门槛 | `package.json` 无 eslint/tsc、`vite.config.mjs` 仅 `globals/fileParallelism` | 加 ESLint + `tsc --checkJs --noEmit`（对 JSDoc 生效）；vitest coverage 门槛从 50% 起 |
| 10 | UI 测试 47 例中 39 例是"读源码字符串断言"（断言某段文本出现几次），删代码会红、逻辑失效不会红 | `tests/ui/*.test.cjs` | 用真渲染替代文本断言（复用现有 Electron 探针或引入 `@testing-library/react`），至少覆盖暂存/提交/筛选/更新四条主流程 |
| 11 | `main.jsx` 2693 行、42 个 `useState`、0 个 `useCallback` | `src/main.jsx` | 先抽三个领域 hook（history / safety / remote）与对应面板组件；再逐步引入 memo 化 |
| 12 | 没有"装包 → 启动 → 查更新 → 卸载"的冒烟测试 | CI 只做构建 + 哈希校验 | CI 或手动脚本对 `release/win-unpacked` 启动一次并比对 `app.getVersion()`；升级路径留在 VM 验收 |

## P3 发布与版本

1. 版本策略已改为手动：`npm run release -- <版本号>` 手写版本、写 CHANGELOG、打 tag，tag 触发构建；见 [releasing.md](releasing.md#version-policy)。
2. 清理孤儿 tag `v0.6.0-beta.1`（只有 tag、没有 Release 与产物）。
3. Release 正文统一模板：下载项、`SHA256SUMS.txt` 校验步骤、Windows x64 / 未签名 / 需自备 Git 三条说明（对齐成熟项目做法）。
4. 可选：增加 `sync-changelog` 类似流程，把 `CHANGELOG.md` 同步到 Release 正文，避免两套叙述。

## 不建议现在做的事

- 扩展 merge / rebase / 冲突解决界面：与当前"拒绝而非自动修复"的安全模型冲突，且维护成本远高于收益。
- 引入状态管理库替换 `useState`：先完成 hook 拆分再评估，否则只是把复杂度搬家。
- 跨平台发布：在 Windows 更新链路验收完成前，macOS/Linux 只会放大发布矩阵。
