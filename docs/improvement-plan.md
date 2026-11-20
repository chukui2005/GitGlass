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

## 0.6.4 / 0.6.5 路线（用户已确认，2026-11-18；2026-11-19 调整口径）

视觉基准正式定为 **dbx**（源码在本机 `D:\DBX\dbx`，UI 在 `apps/desktop/src`，token 在 `apps/desktop/src/styles/tokens.css`）。顺序：**先视觉，再工程**。

> **版本口径调整（2026-11-19，用户指令）**：不再发 `0.6.4` 稳定版；`0.6.4-beta.1` / `0.6.4-beta.2` 保留在 Releases 里作为历史，后续所有 beta 都用 `0.6.5-beta.x`，**稳定版直接是 `0.6.5`**。

| 版本 | 范围 | 退出条件 |
| --- | --- | --- |
| **0.6.4-beta.1** ✅ | 视觉对齐 dbx：设计 token（中性灰 + 近黑主按钮 + 4/6/8px 圆角）、顶栏与按钮度量、侧栏与列表密度、分割条重做、账本与模态、空状态 | 三档宽度（1440/1280/1024）截图无溢出、字号层级与 dbx 一致、分割条 1px 视觉 + 宽命中区 |
| **0.6.4-beta.2** ✅ | 工程门槛：ESLint flat config、`tsc --checkJs --noEmit`、vitest coverage 门槛 | `npm run lint` / `npm run typecheck` 进 CI 且为绿色，覆盖率门槛从 50% 起 |
| **0.6.5-beta.1** ✅ | A 半（测试现代化）：引入 `@testing-library/react`，32 例"读源码字符串"的 UI 断言换成真渲染；视觉遗留 6 条；更新服务延后建窗；依赖归类 | UI 测试真渲染、6 条视觉问题清零、`window-created` −34~38 ms |
| **0.6.5-beta.2** ✅ | B 半（结构债）：`main.jsx` 3027 → **1441 行**，拆出 history / safety / remote / panel 四个 hook 与 `workbench-ui.jsx`；`main.jsx` 退出覆盖率排除 | `main.jsx` < 1500 行；覆盖率四项仍 ≥50%（实测 75.03/69.71/71.95/77.64）；lint 0 warning |
| **0.6.5-beta.3** | 运行时：`.git` watcher 降噪（大仓库事件合并）、命令账本渲染成本（先测量再决定是否虚拟化） | 大仓库里一次 fetch/commit 的通知数不随 ref 数增长；账本 300 条记录的渲染开销有改前/改后数字 |
| **0.6.5**（稳定版） | 上述全部 + 用户验收 | 装上后视觉与行为验收通过；Latest 从 `v0.6.3` 前进到 `v0.6.5` |
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

被 `test.coverage.exclude` 排除的文件（理由同步写进 `docs/conventions.md` 第 5 节）。0.6.5 拆完 `main.jsx` 后只剩两个：

| 文件 | 理由 |
| --- | --- |
| `electron/main.cjs` | 主进程入口，只在 `electron .` 拉起的子进程里执行，vitest 的进程内 v8 覆盖率看不到；实际覆盖由 `tests/ui/` 的真实启动探针负责 |
| `electron/preload.cjs` | 同上，`contextBridge` 暴露面只在子进程里求值 |

`src/main.jsx` 曾经也在名单里（2693 行的 UI 入口）；0.6.5 把它拆成 4 个 hook + `workbench-ui.jsx` 之后，真渲染用例已经覆盖到它，于是这条 exclude 被撤掉了。

**下一步（扩大范围）**：

1. **`tsc` 扩到 `main.jsx` / `workbench-ui.jsx`**：先补 `@types/react` / `@types/react-dom`（领域 hook 已在 `include` 里，见 `src/use-*.js`）；同时评估打开 `strictNullChecks`（`strict: false` 只是第一档）。
2. **提高覆盖率阈值**：0.6.5 之后四项实测 75.03 / 69.71 / 71.95 / 77.64，`workbench-ui.jsx`（40.24%）是主要短板——安全计划、恢复中心、命令面板这几个面板还没有真渲染用例。补完再往 70% 提。
3. **CI 去重**：`npm test` 与 `npm run test:coverage` 会跑两遍同一套用例（约 +2 分钟），等覆盖率稳定后可以只保留后者。

### 0.6.5-beta.1（A 半）交付记录（2026-11-19）

`tests/ui/` 里"读 `src/main.jsx` 源码字符串"的 UI 断言全部换成 `@testing-library/react`
真渲染；结构债（拆 `main.jsx`）是 B 半，仍在排队。

| 项 | 之前 | 之后 |
| --- | --- | --- |
| `npm test` | 49 文件 / 305 用例 | **51 文件 / 320 用例** |
| "读源码"用例 | 4 文件 / 32 用例 | **0**（只剩 `tests/ui/style-contracts.test.cjs` 的 7 例读 `styles.css`——那是样式契约，不是组件源码） |
| `src/main.jsx` 覆盖率 | 被 `test.coverage.exclude` 排除，未测量 | **statements 51.53% / branches 55.76% / functions 47.96% / lines 55.55%** |

- 新增 devDependency：`@testing-library/react`、`@testing-library/dom`、`@testing-library/user-event`、`@testing-library/jest-dom`、`jsdom`（装在主仓库，worktree 共用同一个 `node_modules`）。
- 共用件都在 `tests/support/`：`gitglass-stub.mjs`（按 `electron/preload.cjs` 的形状复刻 `window.gitglass`）、`gitglass-fixtures.mjs`（仓库状态 / 提交 / 账本记录）、`render-app.mjs`（装假桥再挂 `<App />`）、`jsdom-setup.mjs`（jest-dom matcher + 每例 `cleanup` + `<dialog>` 最小 polyfill）。
- **没有全局切 jsdom**：只有文件头写了 `// @vitest-environment jsdom` 的用例进浏览器环境，8 个真实 Electron 探针仍在 node 环境运行——`electron-launch`、`ledger-rows`、`resizable-workspace-panels`、`recent-repositories-ui`、`update-ui`、`batch-stage-layout`、`history-row-layout`、`history-workspace-layout`。
- 产品代码只加了一行 export：`src/main.jsx` 的 `export function App()`（外加 import 时对 `#root` 的守卫，避免测试 import 时顺带挂载第二个实例）。
- 覆盖率 `exclude` 未动。实测把 `main.jsx` 放回 `include` 后四项是 **73.67 / 69.42 / 71.06 / 76.56**（仍过 50% 门槛），B 半拆完 hook 可以顺手撤掉这条 exclude、把阈值往 70% 提。

真渲染顺带暴露的三个既有缺口（本次不改产品代码，留给后续 PR）：

1. 已暂存区的 `<FileSection>` 没有接 `busy`，加载期间"取消暂存"按钮仍可点（未暂存区是禁用的）。
2. `historyNotice` 的三元链把 compare 分支排在 binary 之前，所以"结果中包含二进制文件…"这句只在非 compare 结果里出现。
3. jsdom 没有实现 `<dialog>.showModal()`，`jsdom-setup.mjs` 补了最小 polyfill；顶层图层与焦点陷阱仍由 `tests/ui/update-ui.test.cjs` 的真实探针守着。

**B 半（拆 `main.jsx`）的输入**：

- 先拆 history 领域（`historyMode` / `historySelected` / `historyDetail` / `historyResult` / `historyCompare` / `historyFile` / `historyDraft` / `historyApplied` 加 `selectHistoryCommit`、`readCompare`、`applyHistoryFilters`、`openFileHistory*`）：`tests/ui/history-review-ui.test.mjs` 的 14 例现成可以当安全网。
- 每搬一块就顺手删掉对应的"源码同步"断言：`resizable-workspace-panels`（17 条读 `main.jsx`）、`history-row-layout`（2 条）、`batch-stage-layout`（1 条取区块用）。

### 0.6.5-beta.1（B 半）交付记录（2026-11-19）

`main.jsx` 从"一个 3000 行的组件"拆成"App 外壳 + 4 个领域 hook + 1 个展示组件模块"。
行为、DOM 结构、类名、`aria-*`、中文文案一律不变——A 半建好的真渲染用例（现 333 例）全程当安全网，每抽一块都单独跑绿。

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `src/main.jsx` | **1441**（原 3027） | App 外壳与 JSX、刷新/账本管线、仓库打开与切换、通知横幅、全局快捷键、命令面板接线 |
| `src/use-history-review.js` | 422 | 历史模式、筛选草稿/已应用、查询序号、提交选择与详情缓存、双提交比较、文件历史、Esc 三段语义 |
| `src/use-safety-plans.js` | 260 | 撤销/删除分支/救援分支/切换分支的计划与恢复中心 |
| `src/use-remote-overview.js` | 118 | 远程 overview 与 fetch/push/pull 计划 |
| `src/use-panel-resize.js` | 148 | 面板宽度：持久化、夹紧、拖拽、键盘 |
| `src/workbench-ui.jsx` | 1277 | 26 个展示组件（diff 行、文件分区、批量工具栏、账本、计划/Inspector 面板、历史行与筛选、命令面板） |

- **4 条 `exhaustive-deps` warning 全部消除，没有加一条 disable**：首屏 effect 改读"最新闭包"ref；通知计时器在 effect 内就地推 `operationBanner`；全局快捷键订阅改为每次渲染重建（处理器闭包住最新状态）；命令面板条目改由 `buildPaletteCommands()` 纯函数生成，去掉那个每帧都会重算的 `useMemo`。lint 现在是 **0 error / 0 warning**。
- **覆盖率 exclude 撤掉 `src/main.jsx`**：四项 75.03 / 69.71 / 71.95 / 77.64（门槛 50%），`main.jsx` 自身 64.72 / 65.36 / 55.17 / 68.68。`workbench-ui.jsx` 只有 40.24%，是下一步提阈值前要补的短板（安全计划、恢复中心、命令面板还没有真渲染用例）。
- **两个真渲染测试暴露的缺口已修，各带一条测试**：已暂存区 `<FileSection>` 接上 `busy`（加载中「取消暂存」也禁用）；`historyNotice` 把比较方向与二进制提示拆成彼此独立的判断（二进制比较结果不再吞掉提示）。
- **偏离原计划的两处，需要评审确认**：① 只抽 3 个 hook 无法把 `main.jsx` 压到 1500 行以内（三个 hook 只能带走约 400 行，剩下的是 JSX 与展示组件），所以额外拆了 `workbench-ui.jsx` 与 `use-panel-resize.js`；② `remotePlan` 的 prepare/confirm 放进 `use-remote-overview.js` 而不是 `use-safety-plans.js`，因为准备 fetch 需要 overview、计划面板也要显示上游与领先/落后，拆开会让两个 hook 互相依赖。
- 三个"读源码"的测试跟着代码走：`resizable-workspace-panels`（标记 → `workbench-ui.jsx`，拖拽/持久化 → `use-panel-resize.js`）、`history-row-layout`（提交行 → `workbench-ui.jsx`）、`copy-polish`（同时读两个渲染层文件，文案搬家不再误红）。

### 0.6.4-beta.1 遗留的视觉问题（✅ 6 条已在 0.6.5-beta.1 全部修完）

1. ✅ 成功/失败横幅：白底 + 左侧 2px 色条（`--green` / `--red`），正文用 ink 色。
2. ✅ 空状态右栏：改渲染引导块（标题 + 说明 + 「打开仓库」），不再显示整套禁用的提交表单。
3. ✅ Diff 文件头：三行压成一行面包屑，重命名显示 `旧 → 新`。
4. ✅ 禁用态：统一成一套公式（`--sunken` 底 + `--line` 边框 + `--faint` 文字 + `opacity:1`），低权重按钮保留 `opacity:.5` 兜底。
5. ✅ 最近仓库当前项：整行 `--hover` 底，hover 深到 `--active`。
6. ✅ `.app-notice-pin`：`--line` 描边 + `--text` 文字 + hover 浅底。

未做：Diff 文件头的 `+N −M` 统计——现有数据里没有（`presentDiff` 只有原始 patch，`selected` 只有 path/area/status），自己数 patch 行在截断/二进制时会失真，走 `git diff --numstat` 又会多一条系统读取记录，留待决策。

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
- **已落地（2026-11-19）**：更新服务延后到建窗之后——**窗口创建提前 34–38 ms，首帧持平**（那 40 ms 从建窗路径挪进了渲染层收尾阶段，一进一出抵消，见新文档 3.1）。真正的收益是窗口不再等待 `updater.restore()` 这类可能耗时数秒的更新逻辑；`update:*` 改为排队，初始化失败降级成「不可用」。
- **下一步（按收益排序，见新文档第 5 节）**：运行期依赖归类（`react` 等移到 `devDependencies`，需同步 lockfile）；账本虚拟列表与 watcher 降噪（内存，属 0.6.5 结构债）。
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

## 0.6.5 验收反馈（2026-11-19，用户提出；#19/#20/#21 已全部落地）

| # | 问题 | 现状与证据 | 建议 |
| --- | --- | --- | --- |
| 19 | **每次启动窗口都太大，而且不记忆尺寸** | `electron/main.cjs:273` 硬编码 `width: 1500, height: 940`、`minWidth: 1024, minHeight: 680`；主进程里没有任何 `getBounds` / `setBounds`，`userData` 只有 `recent-repos.json` 与 `updates.json`。1366×768 的笔记本上 1500×940 直接超出工作区；用户手动拖小后，下次启动又回到 1500×940 | ① 持久化窗口尺寸与位置（`userData/window-state.json`，容错写法照 `RecentRepositories`：文件损坏/尺寸越界/显示器已断开时回退默认值）；② 默认尺寸改成按屏幕工作区取比例（例如宽 `min(1400, workArea.width × 0.8)`、高同理），并且不小于 `minWidth/minHeight`；③ 保存前剔除最大化/最小化状态，避免把 `-32000` 这类坐标写进文件；④ `x/y` 要校验是否仍落在某个显示器的 `workArea` 内，否则回到居中。**✅ 2026-11-20 已按 ①②③④ 落地**（随下一个版本发布，见下方交付记录） |
| 20 | **「工作区」中间栏默认是一列点不动的提交记录，与历史审查重复** | `src/main.jsx:1410`：没有选中文件时渲染 `<CommitGraph>`，它的行是 `<div class="graph-row">`——没有 `onClick`、没有 `tabIndex`、没有 hover 变化；而历史审查的提交行是 `.commit-select` 按钮。打开仓库后默认不选中文件，所以第一屏就是这块死区。工作区真正独有的能力在两侧：左侧文件列表与暂存、右侧提交表单与文件详情（历史审查完全没有暂存/提交能力） | **不建议直接合并两个模式**（历史审查没有 staging，工作区没有可交互的历史），先做三件小事：① 删掉工作区中间栏的 `CommitGraph`；② 打开/切换仓库后自动选中第一个改动文件，让中间栏直接显示 Diff；③ 空状态写清「从左侧选择文件查看改动；查看提交历史请切到历史审查」。如果做完仍觉得两套模式多余，再考虑「单窗口 + 左侧 Changes / History 两个标签页」（GitHub Desktop 的做法）——那是更大的重组，需要单独设计。**✅ 2026-11-20 已按 ①②③ 落地**（见下方交付记录；「Changes / History 标签页」重组仍未排期） |
| 21 | **「⟳ 刷新」与「获取…」的职责容易混，且 ⟳ 在自动刷新之后已接近冗余** | 三者做的是不同的事：⟳ = 重读本地状态（`git status`/分支/提交/账本，不联网）；「获取…」= 生成 fetch 计划、确认后 `git fetch`（**联网**，更新 `origin/*` 与 ahead/behind）；自动刷新 = `.git` 变化或窗口聚焦时静默重读本地状态。自动刷新实测 165–195 ms，正常路径上已经覆盖 ⟳。但 `startWatching()` 的返回值目前没人看：**`fs.watch` 在网络盘 / 受限文件系统上静默失败时，用户完全不知道自动刷新已经死了**，那时 ⟳ 是唯一出路 | 不删 ⟳，改为「降级 + 补可见性」：① ⟳ 从侧栏常驻按钮改为命令面板里的命令，且**只在 watcher 不可用时**才显示；② `startWatching()` 失败时在顶栏或账本里明确提示「自动刷新不可用，请手动刷新」；③ 两个入口的 `title` 写清区别——⟳「重新读取本地状态（不联网）」，「获取…」「联网拉取远程更新（先生成计划）」。**「获取…」不能删**：自动刷新永远不会替用户 fetch。**✅ 2026-11-20 已按 ①②③ 落地**（见下方交付记录） |

### 0.6.5 验收反馈 #19 交付记录（2026-11-20）

`electron/window-state.cjs` 一个模块落地 ①②③④（随下一个版本进入安装包）：

| 口径 | 落地 |
| --- | --- |
| ① 持久化 | `userData/window-state.json`；`WindowStateStore` 沿用 `RecentRepositories` 的容错（>64KB / 损坏 / 非对象 → 静默回退默认值）与原子写（tmp + rename，0o600），内容只有 width/height/x/y 四个整数 |
| ② 默认尺寸 | 主屏工作区 0.8 比例、封顶 1400×940，且夹紧到 `[minWidth/minHeight, 工作区]`（1366×728 工作区 → 1093×680，不再像 1500×940 那样溢出屏幕） |
| ③ 剔除最大化/最小化 | `trackWindowBounds()` 只在非最大化 / 非最小化 / 非全屏时记录 `resize`/`move` 读数，`close` 时一次性原子写；`-32000` 与最大化尺寸永远进不了文件，写入失败不阻塞关窗 |
| ④ x/y 校验 | 保存位置必须与某台显示器 `workArea` 相交 ≥200×100 且 64px 标题条可见过半，否则**连同尺寸一起**回退默认值并居中；尺寸夹紧到目标显示器（副屏拔掉 → 自动回到主屏工作区） |
| 测试 | `tests/unit/window-state.test.cjs` 23 例（容错 + 默认/恢复/夹紧/居中矩阵 + 追踪器）；`tests/ui/window-state.test.cjs` 真启动 `electron/main.cjs` 两阶段探针：首启默认尺寸不超工作区 → setBounds → 关窗落盘 → 二次启动恢复同一 bounds。全库 54 文件 / 372 用例全绿，覆盖率 77.18 / 71.50 / 74.78 / 79.85，`window-state.cjs` 自身 100 / 90.38 / 100 / 100 |

未做（留给后续小 PR）：恢复「关闭时是最大化」的状态——按 ③ 的口径文件里只存常规 bounds；要支持需另存 `maximized` 标志并在启动后 `maximize()`。

### 0.6.5 验收反馈 #20 交付记录（2026-11-20）

证据修正：`applyState` 从首版起就有 `preference || next.files[0]` 的自动选中，打开/切换仓库的收尾（`applyOpenedRepository` → `refreshAll`）也走这条路——**"打开仓库后默认不选中"只发生在没有改动的仓库**（此时中栏渲染的就是那列点不动的提交图）。

| 口径 | 落地 |
| --- | --- |
| ① 删死图 | 工作区中间栏不再渲染 `CommitGraph`（组件与 `.commit-graph` / `.graph-row` / `.graph-empty` 样式一并删除；历史审查提交行仍在用的 `.graph-line` 保留）。中栏标题恒为「文件差异」，未选中时副标题「未选择文件」，不再出现「最近 N 个提交」的假入口 |
| ② 自动选中 | 行为本就存在，本 PR 补真渲染回归测试锚定：打开仓库 → 自动选中第一个改动文件并渲染差异（`tests/ui/workbench-structure.test.mjs`） |
| ③ 空状态 | 新 `WorkspaceEmptyState` 组件（`role="status"`）：干净仓库显示「工作区没有未提交的改动」，写明「从左侧文件列表选择文件查看差异；查看提交历史请切换到「历史审查」」；「有改动但无选中」是防御性分支（当前逻辑不可达），显示「未选择要查看的文件」 |
| 测试 | 新增 2 例（干净仓库空态 + 打开仓库自动选中）。全库 54 文件 / 375 用例全绿，覆盖率 77.29 / 71.62 / 74.74 / 79.94 |

「Changes / History 双标签页」重组（GitHub Desktop 式）按原计划保持独立设计，未排期。

### 0.6.5 验收反馈 #21 交付记录（2026-11-20）

| 口径 | 落地 |
| --- | --- |
| ① ⟳ 降级 | 侧栏「刷新状态」按钮删除；命令面板仅在 watcher 不可用时出现「重新读取本地状态（不联网）」条目（`buildPaletteCommands` 按 `watcherActive` 过滤，`commandAvailability` 的 busy/needsRepository 语义沿用） |
| ② 失败可见性 | `RepositoryWatcher` 三条失败路径全部可见：`watch()` 全部目录同步失败 → 返回值 `false`；部分目录失败 → 其余目录继续监视；句柄异步 `error` → 拆除死句柄，最后一个死亡时经 `onError` 上报。主进程 `startWatching()` 读返回值并维护 `watcherActive`，新增 `watcher:state` 查询 + `watcher:changed` 推送（preload 暴露 `getWatcherState` / `onWatcherChanged`）；渲染层在打开仓库且不可用时提示一次「自动刷新不可用（无法监视仓库变化），请从命令面板手动刷新。」，恢复后重新武装，同一段失败不重复打扰 |
| ③ title 区分 | 「获取…」title 改为「联网拉取远程更新（先生成计划，不会立即执行）」；手动刷新条目 label 即「重新读取本地状态（不联网）」 |
| 测试 | watcher 单测 +3（全失败 / 部分失败 / 异步全灭）；真渲染 +2（不可用 → 提示 + 面板出现手动刷新；可用 → 面板无手动刷新 + title 断言）。全库 54 文件 / 380 用例全绿，覆盖率 77.57 / 71.78 / 74.75 / 80.22 |

两个读源码的旧断言随行为同步：copy-polish 的 `onClick={refreshFromUser}` → `run: actions.refreshFromUser`；design-tokens 的 icon-button 计数下限 3 → 2。

## P2 工程质量（决定改得动不动）

| # | 问题 | 现状 | 修法 |
| --- | --- | --- | --- |
| 9 | 没有 lint、没有类型检查、没有覆盖率门槛 | `package.json` 无 eslint/tsc、`vite.config.mjs` 仅 `globals/fileParallelism` | ✅ 0.6.4-beta.2：ESLint flat config（0 error）+ `tsc --checkJs --noEmit`（0 error）+ vitest coverage 门槛 50%，三项都进 CI；详见「0.6.4-beta.2 交付记录」 |
| 10 | UI 测试 47 例中 39 例是"读源码字符串断言"（断言某段文本出现几次），删代码会红、逻辑失效不会红 | `tests/ui/*.test.cjs` | ✅ **0.6.5-beta.1（A 半）**：4 个文件 32 例改成 `@testing-library/react` 真渲染，覆盖暂存/提交/筛选/更新四条主流程；纯 CSS 规则挪到 `tests/ui/style-contracts.test.cjs`；8 个真实 Electron 探针全部保留。详见「0.6.5-beta.1（A 半）交付记录」 |
| 11 | `main.jsx` ≈2 990 行、42 个 `useState`、0 个 `useCallback` | `src/main.jsx` | ✅ **0.6.5-beta.1（B 半）**：`main.jsx` 3027 → **1441 行**；4 个领域 hook（history / safety / remote / panel）+ `workbench-ui.jsx`（26 个展示组件）；4 条 `exhaustive-deps` warning 全部消除，覆盖率 exclude 里撤掉 `main.jsx`。详见「0.6.5-beta.1（B 半）交付记录」 |
| 12 | 没有"装包 → 启动 → 查更新 → 卸载"的冒烟测试 | CI 只做构建 + 哈希校验 | CI 或手动脚本对 `release/win-unpacked` 启动一次并比对 `app.getVersion()`；升级路径留在 VM 验收。**部分缓解**：体积审计时已手动对打包产物做过一次启动冒烟（探针记录到 `whenReady → window-created → did-finish-load → ready-to-show`），但仍未进 CI |
| 18 | **窗口外壳没有自动化覆盖，且"测试时看到的外观"不等于产品外观** | `tests/ui/electron-launch.test.cjs` 只读 `main.cjs` 的源码字符串（断言写了 `titleBarOverlay`、传了 `icon`），没有真的启动一次外壳；`tests/support/*.cjs` 自建 `BrowserWindow` 时**不复制** `titleBarStyle` / `titleBarOverlay` / `icon`，也不调用 `Menu.setApplicationMenu(null)`，所以探针窗口是**原生 Windows 标题栏 + `electron.exe` 的 Electron 原子图标 + 原生菜单**，而真实应用是自绘 48px 标题栏 + GitGlass 图标、无原生菜单。维护者（2026-11-19）因此误以为图标/标题栏没生效 | 用 `npm run dist:win` 的产物跑一条冒烟测试：启动 `release/win-unpacked/GitGlass.exe`，断言窗口带自绘标题栏（`titleBarOverlay` 生效）、进程 exe 的图标不是 Electron 默认图标、win32 上没有原生应用菜单；前置条件复用 CI `Quality` job 里已经跑的 `dist:win`。**不要**给探针加"模拟外壳"开关——那会让探针既不像测试也不像产品 |

## P3 发布与版本

1. 版本策略已改为手动：`npm run release -- <版本号>` 手写版本、写 CHANGELOG、打 tag，tag 触发构建；见 [releasing.md](releasing.md#version-policy)。
2. 清理孤儿 tag `v0.6.0-beta.1`（只有 tag、没有 Release 与产物）。
3. Release 正文统一模板：下载项、`SHA256SUMS.txt` 校验步骤、Windows x64 / 未签名 / 需自备 Git 三条说明（对齐成熟项目做法）。
4. 可选：增加 `sync-changelog` 类似流程，把 `CHANGELOG.md` 同步到 Release 正文，避免两套叙述。

## 不建议现在做的事

- 扩展 merge / rebase / 冲突解决界面：与当前"拒绝而非自动修复"的安全模型冲突，且维护成本远高于收益。
- 引入状态管理库替换 `useState`：先完成 hook 拆分再评估，否则只是把复杂度搬家。
- 跨平台发布：在 Windows 更新链路验收完成前，macOS/Linux 只会放大发布矩阵。
