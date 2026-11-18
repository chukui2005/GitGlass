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

## 0.6.4 / 0.6.5 路线（用户已确认，2026-11-18）

视觉基准正式定为 **dbx**（源码在本机 `D:\DBX\dbx`，UI 在 `apps/desktop/src`，token 在 `apps/desktop/src/styles/tokens.css`）。顺序：**先视觉，再工程**。

| 版本 | 范围 | 退出条件 |
| --- | --- | --- |
| **0.6.4-beta.1** ✅ | 视觉对齐 dbx：设计 token（中性灰 + 近黑主按钮 + 4/6/8px 圆角）、顶栏与按钮度量、侧栏与列表密度、分割条重做、账本与模态、空状态 | 三档宽度（1440/1280/1024）截图无溢出、字号层级与 dbx 一致、分割条 1px 视觉 + 宽命中区 |
| **0.6.4-beta.2** ✅ | 工程门槛：ESLint flat config、`tsc --checkJs --noEmit`（先覆盖 `electron/` 与 `src/` 里已有单测的纯逻辑模块）、vitest coverage 门槛 | `npm run lint` / `npm run typecheck` 进 CI 且为绿色，覆盖率门槛从 50% 起 |
| **0.6.5-beta.1** | 测试现代化 + 结构债：引入 `@testing-library/react`（**允许新增 devDependency**）替换约 39 例"读源码字符串"的 UI 断言；拆 `main.jsx`（history / safety / remote 三个领域 hook） | UI 测试改为真渲染，删掉一行文案不再误红；`main.jsx` 降到 1500 行以内 |
| 后续（未排期） | 包体积与性能（见下节） | 有测量基线，且安装包/内存有可量化下降 |

### 0.6.4-beta.1 交付记录（2026-11-18）

四个 PR 完成视觉对齐，全部经真实 Electron 探针截图逐张比对：

| PR | 内容 |
| --- | --- |
| #48 | `:root` 换成 dbx 中性 token（`#fff`/`#fafafa`/`#f5f5f5`/`#e5e5e5`/`#0a0a0a`/`#737373`/`#a1a1a1`）、主按钮近黑、顶栏 30px 度量、模态 10px + 轻阴影、危险操作降级为文字按钮、品牌蓝收口到链接/选中标记/diff 强调 |
| #47 | 密度：侧栏文件与分支行 26px、分组标题 12px/600 + 11px 计数、提交行 38px、Diff 行号槽 40/40/20 与单行文件头、账本 32px、空状态收紧 |
| #46 | 分割条重做：1px 发丝线 + 9px 命中区（只向内容侧扩）、hover 2px `--ring` / 拖拽 2px `--text`、pointer capture + 全屏 overlay + rAF、双击重置、键盘 ←/→/Home/End/Enter、宽度持久化、挂载即夹紧 + `ResizeObserver` |
| #50 | 通知条与最近仓库菜单的遗留硬编码灰全部 token 化（成功/失败用 `--green-soft`/`--red-soft` + ink 色，对比度 3.2:1 → 4.6:1），最近仓库路径 10px → 11px，`design-tokens` 的 no-10px 断言覆盖整份样式表 |

另外顺带修了 #49：普通计划（获取远程、切换分支）不再误显示「安全：创建救援分支」风险标签。

### 0.6.4-beta.2 交付记录（2026-11-18）

一个 PR 落地三道工程门槛。CI 的 `Quality (test and build)` 作业现在依次跑
`npm ci` → `npm test` → `npm run lint` → `npm run typecheck` → `npm run test:coverage` → `npm run build` → `dist:win` / `verify:release`。

| 门槛 | 落地 | 结果 |
| --- | --- | --- |
| ESLint flat config | `eslint.config.mjs`：`@eslint/js` recommended + `no-unused-vars`（允许 `_` 前缀）/ `eqeqeq: smart`（保留 `== null` 写法）/ `no-var` / `prefer-const` / `react-hooks/rules-of-hooks`(error) / `exhaustive-deps`(warn)；按 Node（`electron/`、`scripts/`、`tests/`、根 `*.mjs`）与浏览器 ESM（`src/`）分两组，忽略 `dist/`、`release/`、`coverage/`、`node_modules/`、`.tmp-*` | **0 error / 4 warning**。warn 全部是 `main.jsx` 的 `exhaustive-deps`，那几处依赖是刻意放宽的，留给 0.6.5 拆 hook 时一并处理 |
| 类型检查 | `tsconfig.json`（`allowJs` + `checkJs` + `noEmit`，`strict: false`，`moduleResolution: bundler`）；`include` 只有 `electron/**/*.cjs` 与 12 个已有单测的 `src/` 纯逻辑模块 | **0 error**。首轮 38 个报错全部真修：`UpdateService` 用显式属性赋值替代 `Object.assign(this, …)`（行为等价，只为了让属性对 `checkJs` 可见）、`titleBarOptions` 补 `BrowserWindowConstructorOptions` 注解、`notice-lifecycle` / `shortcut-policy` / `diff-presentation` 补 `@typedef` 与 `@returns` |
| 覆盖率门槛 | `vite.config.mjs` 的 `test.coverage`：`provider: v8`、`reporter: ['text', 'json-summary']`、阈值四项各 50% | 实测 **statements 79.94% / branches 70.61% / functions 79.12% / lines 83.27%**（1541 语句 / 1426 分支 / 297 函数 / 1190 行） |

被 `test.coverage.exclude` 排除的三个文件（理由同步写进 `docs/conventions.md` 第 5 节）：

| 文件 | 理由 |
| --- | --- |
| `src/main.jsx` | 2693 行的 UI 入口，只在渲染进程里跑；类型化与覆盖率都要等 0.6.5 拆成 history / safety / remote 三个 hook 之后 |
| `electron/main.cjs` | 主进程入口，只在 `electron .` 拉起的子进程里执行，vitest 的进程内 v8 覆盖率看不到；实际覆盖由 `tests/ui/` 的真实启动探针负责 |
| `electron/preload.cjs` | 同上，`contextBridge` 暴露面只在子进程里求值 |

**下一步（扩大范围）**：

1. **`tsc` 扩到 `main.jsx`**：先补 `@types/react` / `@types/react-dom`，随 0.6.5 的 hook 拆分逐个文件加进 `include`；同时评估打开 `strictNullChecks`（`strict: false` 只是第一档）。
2. **提高覆盖率阈值**：当前四项实测都在 70% 以上，但 `app-updates.jsx`(0%)、`brand-mark.jsx`(0%)、`recent-repositories-menu.jsx`(18.81%) 还在拖后腿，等 0.6.5 换成 `@testing-library/react` 真渲染后再把门槛提到 70%。
3. **CI 去重**：`npm test` 与 `npm run test:coverage` 会跑两遍同一套用例（约 +2 分钟），等覆盖率稳定后可以只保留后者。

### 0.6.4-beta.1 遗留的视觉问题（下一轮，不阻塞本次 beta）

1. 成功/失败横幅仍是**通栏浅色 tint**，dbx 没有这种整行染色；建议改白底 + 左侧 2px 色条。
2. 空状态下右侧 Inspector 仍渲染完整的「创建提交」表单（全部禁用），没有仓库时没有意义，应换成引导块。
3. Diff 文件头仍是三行（文件 / 原文件 / 新文件），比 dbx 的一行面包屑松。
4. 禁用按钮两套写法：全局 `opacity:.5` 与 `.remote-actions button:disabled` 的 `--sunken` + `--faint`，视觉深浅不一致。
5. 最近仓库当前项只有左条 + 徽标，没有整行浅底（与侧栏选中行不完全一致，菜单场景可接受）。
6. `.app-notice-pin` 用 `currentColor` 描边，若要对齐 dbx 的 ghost 观感应改 `--line` 描边 + `--text` 文字。

### 视觉对齐的取值来源（dbx `tokens.css` 浅色主题）

| 类别 | dbx 取值 | GitGlass 落点 |
| --- | --- | --- |
| 主按钮 | `#171717` 底 / `#fafafa` 字（不是品牌蓝） | `.primary-button` 改近黑；品牌蓝只留给链接、焦点环、选中标记 |
| 中性面 | `--background #fff`、`--sidebar #fafafa`、`--chrome #f5f5f5`、`--gutter #f3f3f3` | `--app` / `--sidebar` / `--surface` / `--code` |
| 边框 | `#e5e5e5` 1px | `--line` 由 `#e2e6ea` 改 `#e5e5e5` |
| 文本 | `#0a0a0a` / 次级 `#737373` | `--text` / `--muted`（对比度仍 ≥ 4.5:1） |
| 状态色 | success `#16a34a`、warning `#d97706`、destructive `#e7000b`、info `#2563eb` | 状态与 diff 用色对齐，diff 底色保持浅色 tint |
| 圆角 | 4 / 4 / 6（sm/md/lg），外观设置可放大 | `--radius-sm 4` / `--radius 6` / `--radius-lg 8`（模态 10） |
| 控件高度 | 工具条按钮约 30px，图标按钮 30×30 | 顶栏、筛选、面板操作统一 30px（主按钮 32px） |

分割条参考 dbx `apps/desktop/src/composables/usePanelResize.ts`：`setPointerCapture` + 拖拽期间铺一层全屏 overlay（避免 hover 抖动）+ `requestAnimationFrame` 节流 + 最小宽度 240 + 宽度持久化 + `blur` 兜底收尾。视觉上 dbx 是**一条 1px 分隔线**，命中区藏在两侧留白里；GitGlass 现在是 8px 宽的灰条 + 蓝色发光，需要重做。

### 包体积与性能（已测量，清单见 [size-and-performance.md](size-and-performance.md)）

2026-11-18 完成了一次完整测量：**基线 → 现状** 为安装包 113.6 MB → **102.1 MB**、ZIP 151.2 MB → **135.4 MB**、解压后 384.5 MB → **310.9 MB**（−73.6 MB）。其中 309.1 MB（99.4%）是 Electron 运行时，我们的代码与资源只有 1.8 MB。启动（模拟安装版）到渲染层就绪 **724 ms**：Electron 自身引导 163 ms、更新服务 36 ms、建窗 108 ms、首屏 104 ms。

- **已落地（零风险）**：`electronLanguages` 只留 `zh-CN` + `en-US`（安装包 −8.1 MB）；`build.files` 排除 `@phosphor-icons` / `react` / `react-dom` / `scheduler`（安装包 −3.2 MB，`app.asar` 27.7 MB → 1.8 MB）；排除 `*.map`（−0.1 MB）。
- **下一步（按收益排序，见新文档第 5 节）**：更新服务延后到窗口创建之后（首屏前省 36–48 ms）；运行期依赖归类（`react` 等移到 `devDependencies`，需同步 lockfile）；账本虚拟列表与 watcher 降噪（内存，属 0.6.5 结构债）。
- **实测后不建议做**：`compression: maximum`（安装包 +455 B）、拆渲染层（`react-dom` 占 bundle 72.4%）、删 Electron 的 `dxcompiler`/`vk_swiftshader`（风险高）。
- **复测**：`npm run report:size`、`npm run report:startup -- --installed`，对照数字写在新文档第 8 节。

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

### 0.6.3 发现但**没修**的小问题（下次单独开 PR）

| 问题 | 现状 | 建议 |
| --- | --- | --- |
| Diff 的文件/元信息行会折行 | `.diff-line.file` / `.metadata` 的 DOM 有 5 个子元素，CSS 只有 `112px max-content` 两列 | 改成 5 列 grid 或给多余子元素 `display:none`，改动只在 `styles.css` |
| 最近仓库菜单仍用 10px | `.recent-repositories-path`、`.recent-repositories-missing` 是 `font-size:10px` | 统一到 `--font-aux`（11px），顺手把这几个类也纳入 `tests/unit/design-tokens.test.mjs` 的 no-10px 断言 |
| 合并/变基状态横幅仍是整行高度 | 计划 #13 里的"更窄的状态条"没做 | 单独调 `.app-notice` 的 padding 与行高，避免和 #14/#15 抢同一个 PR |
| 顶栏在 1280–1440 区间靠折叠断点兜底 | 1240px 以下文字折叠为图标 | 若以后增加顶栏按钮，先跑一次 1280 + 154px overlay 的宽度探针（`1150~1250` 是最紧的区间） |
## P2 工程质量（决定改得动不动）

| # | 问题 | 现状 | 修法 |
| --- | --- | --- | --- |
| 9 | 没有 lint、没有类型检查、没有覆盖率门槛 | `package.json` 无 eslint/tsc、`vite.config.mjs` 仅 `globals/fileParallelism` | ✅ 0.6.4-beta.2：ESLint flat config（0 error）+ `tsc --checkJs --noEmit`（0 error）+ vitest coverage 门槛 50%，三项都进 CI；详见「0.6.4-beta.2 交付记录」 |
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
