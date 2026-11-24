# Changelog

## [0.6.8](https://github.com/chukui2005/GitGlass/compare/v0.6.7...v0.6.8) (2026-11-24)

### Features

* refine diff review, staging, commit controls, and the command ledger ([6f0b1c0](https://github.com/chukui2005/GitGlass/commit/6f0b1c0eb0f33dea4c710eacc2f7c0b707582fcf))

### Bug Fixes

* refresh the workspace after remote-tracking refs change ([cc996f3](https://github.com/chukui2005/GitGlass/commit/cc996f3c44e512901d00308c1a0fb22716579597))

## [0.6.7](https://github.com/chukui2005/GitGlass/compare/v0.6.6...v0.6.7) (2026-11-20)

> 0.6.6-beta 验收反馈的三条修复，随 `0.6.7-beta.1` 经过用户验收。下面按「用户能感知的变化」归并。

### 工作区

* **「创建提交」表单常驻右栏**：修复「找不到提交按钮」——右栏此前是三选一，而应用总是自动选中第一个改动文件，只要有改动，提交说明输入框和提交按钮就被「文件详情」整个替换掉。现在选中文件的详情与提交表单并存：看 Diff、写说明、提交在同一栏完成
* 所有用户操作（暂存 / 取消暂存 / 提交 / 计划确认）**不再自动弹出命令账本**：成功与否由通知横幅表达，收起态账本的「最近：xx」摘要仍在；失败诊断（打开 / 刷新失败）保留自动弹出一次
* 通知横幅收窄为约 22px 的细状态条，合并 / 变基进行中的常驻横幅不再挤压工作区（#13 遗留）

### Diff

* 元信息行（新增文件 / 权限变化 / 内容相似度 / 末尾换行提示）不再折行错位：空的行号与标记槽不再参与 grid 布局，中文标签与内容各占一列

### 工程质量（不改变产品行为）

* CI 新增打包产物外壳冒烟测试（#12 / #18）：每次构建后真启动 `release/win-unpacked/GitGlass.exe`，断言 exe 名、打包版本、无原生菜单、自绘标题栏与 Window Controls Overlay 可见
* README 的 logo 收敛为单一副本（`public/logo.svg`），删除全仓库零引用的 `logo-mono.svg`

### 已知问题（下一版修）

* Diff 文件头没有 `+N −M` 统计

## [0.6.7-beta.1](https://github.com/chukui2005/GitGlass/compare/v0.6.6...v0.6.7-beta.1) (2026-11-20)

### Bug Fixes

* slim the notice strip and repair diff metadata rows ([991cde0](https://github.com/chukui2005/GitGlass/commit/991cde01fe821a3d677985ae98faf0ef5f0f21b8))
* stop auto-opening the command ledger on operations ([b399eff](https://github.com/chukui2005/GitGlass/commit/b399efff3d1fbb20bb0e688b4fba9bf2b46c0d3b))
* keep the commit form visible while a file is selected ([fc53294](https://github.com/chukui2005/GitGlass/commit/fc5329474d3c1c19a45bd860bbe29c19f6d02986))

## [0.6.6](https://github.com/chukui2005/GitGlass/compare/v0.6.5...v0.6.6) (2026-11-20)

> 0.6.5 验收反馈的三项全部落地，随 `0.6.6-beta.1` 经过一轮用户验收。下面按「用户能感知的变化」归并。

### 窗口与工作区

* **窗口尺寸与位置记忆**：关窗时把窗口的常规尺寸与位置写进 `userData/window-state.json`，下次启动原样恢复；最大化 / 最小化（含 Windows 最小化的 `-32000` 坐标）不会落盘；显示器拔掉或分辨率变化导致位置失效时自动回退居中，尺寸夹紧到目标显示器的工作区
* 默认窗口尺寸不再硬编码 1500×940，改为按主屏工作区 80% 取比例（封顶 1400×940、不低于最小尺寸 1024×680）：**1366×768 的笔记本首屏不再溢出**
* 「工作区」中间栏不再渲染一列**不可点击**的提交记录：干净仓库显示指引空状态（从左侧选择文件查看差异；查看提交历史请切换到「历史审查」）；有改动时打开/切换仓库自动选中第一个改动文件，首屏直接是 Diff
* 中栏标题恒为「文件差异」，未选中文件时副标题为「未选择文件」，不再显示假的「最近 N 个提交」入口

### 刷新语义

* 侧栏常驻 ⟳ 按钮移入命令面板，且**只在自动刷新不可用时**出现，条目写明「重新读取本地状态（不联网）」
* `fs.watch` 在网络盘 / 受限文件系统上静默失败不再无感：打开仓库且监视失败时提示一次「自动刷新不可用（无法监视仓库变化），请从命令面板手动刷新。」，监视恢复后自动解除
* 「获取…」悬停提示写明联网：「联网拉取远程更新（先生成计划，不会立即执行）」；「获取…」本身保持不变——自动刷新永远不会替用户 fetch

### 已知问题（下一版修）

* Diff 文件头没有 `+N −M` 统计
* 合并/变基中的状态横幅仍是整行高度

## [0.6.6-beta.1](https://github.com/chukui2005/GitGlass/compare/v0.6.5...v0.6.6-beta.1) (2026-11-20)

### Features

* surface watcher failures and downgrade the refresh button (#21) ([db7aae0](https://github.com/chukui2005/GitGlass/commit/db7aae0978fab37fb3db4394d9a1da0d2e640467))
* drop the dead workspace commit graph and guide to files or history (#20) ([45b6abf](https://github.com/chukui2005/GitGlass/commit/45b6abf1a6fefe6c47b7ebcc59516e50f8b9dbda))
* remember window size and position across restarts (#19) ([f0a58ef](https://github.com/chukui2005/GitGlass/commit/f0a58ef3bb51c5b4d4e16be6a3528f3f53a5bfbe))

### Bug Fixes

* make the window state probe deterministic on small displays ([6946177](https://github.com/chukui2005/GitGlass/commit/6946177b2f9c006b00c442bf666224ce419a09dd))

## [0.6.5](https://github.com/chukui2005/GitGlass/compare/v0.6.3...v0.6.5) (2026-11-19)

> 这是自 v0.6.3 之后的第一个稳定版。中间经过 5 个 beta（`0.6.4-beta.1/2`、`0.6.5-beta.1/2/3`），下面按「用户能感知的变化」归并，不列 beta 编号。

### 视觉：整套换成 dbx 的设计语言

* 主按钮改为近黑实心（`#171717`），品牌蓝只保留给链接、选中标记、Diff 强调与复选框；全页同一时刻最多 1 个实心按钮
* 中性色板：画布 `#fff`、侧栏 `#fafafa`、hover `#f5f5f5`、边框 `#e5e5e5` 发丝线、文字 `#0a0a0a` / 次级 `#737373`
* 字号三档 token（正文 13 / 次级 12 / 辅助 11），侧栏文件行 32→**26px**、提交行 44→**38px**、账本单行 52→**32px**
* 命令账本展开态改为两行结构：意图 + 等宽命令 / 结果 · 退出码 · 耗时 · 时间 · 来源
* 面板分割条由 8px 灰条重做为 **1px 发丝线 + 9px 命中区**：hover 2px 灰、拖拽 2px 近黑、双击重置、←/→ 微调、宽度持久化
* 通知横幅去掉通栏染色，改为白底 + 左侧 2px 色条（文字对比度 3.2:1 → 4.6:1）
* 空状态右栏不再显示整套禁用的提交表单，改为引导块
* Diff 文件头由三行压成一行面包屑，重命名显示 `旧路径 → 新路径`
* 模态与输入控件：10px 圆角 + 轻阴影、30px 高、`#a1a1a1` 焦点环（去掉蓝色外发光）

### 性能

* **自动刷新修好了整类漏报**：`fs.watch` 在 `refs/heads` 上只报裸文件名，旧逻辑丢弃了所有分支与远端 ref 的变化（约 1200 个事件 → 0 次通知）。现在按目录分类，事件合并为首事件立即 + 800ms 尾随 + 2s 上限；外部 `git add` / `commit` / `checkout -b` 的界面更新从约 1.0–1.2s 降到 **165–195ms**
* 读命令只静默 `index` 事件，`head` / `refs` 保持即时上报；空闲时不再自触发刷新（4 秒内 0 次事件、账本 0 增长）
* 命令账本不再整列重渲染：记录对象身份复用 + 记忆化 + 稳定回调，一次无关 App 重渲染的字段读取从 **3600 次降到 0**
* 更新服务挪到窗口创建之后，窗口不再等待 `updater.restore()` 这类可能耗时数秒的逻辑
* **安装包 113.6 → 102.1 MB**、便携 ZIP 151.2 → 135.4 MB、解压后 384.5 → 310.9 MB：只保留 `zh-CN`/`en-US` 语言包、剔除 Vite 已打包的渲染层依赖、排除 sourcemap；`app.asar` 27.7 MB → 1.8 MB

### 工程质量（不改变产品行为）

* ESLint flat config（0 error / 0 warning）、`tsc --checkJs --noEmit`（0 error）、vitest 覆盖率门槛 50%，三项进入 CI；当前覆盖率 75.03 / 69.71 / 71.95 / 77.64
* 4 个测试文件里 32 例「读源码字符串」的 UI 断言改为 `@testing-library/react` 真渲染，纯 CSS 断言收进 `tests/ui/style-contracts.test.cjs`；8 个真实 Electron 探针保留；用例 274 → 339
* `src/main.jsx` 2932 → **1437 行**，拆出 `use-history-review` / `use-safety-plans` / `use-remote-overview` / `use-panel-resize` 四个 hook 与 `workbench-ui.jsx`（26 个展示组件）
* `dependencies` 只剩主进程真正 `require` 的 `electron-updater` 与 `semver`
* 新增 `npm run report:size` / `report:startup` 与 `docs/size-and-performance.md`，体积与启动可复测

### 修复

* 获取远程 / 切换分支的计划面板不再误显示「安全：创建救援分支」风险标签
* 已暂存区在加载中「取消暂存」不再可点
* `compare` 结果包含二进制文件时，「结果中包含二进制文件」提示不再丢失
* 发版脚本支持显式预发布版本号（`npm run release -- 0.6.5-beta.1`）
* 修掉 Windows 换行（CRLF）下 `CHANGELOG.md` 重复写入 `# Changelog` 标题的缺陷

### 已知问题（下一版修）

* 窗口每次启动都是 1500×940，且不记忆用户调整后的尺寸
* 「工作区」中间栏在未选中文件时显示一列**不可点击**的提交记录（历史交互请用「历史审查」）
* Diff 文件头没有 `+N −M` 统计
* 合并/变基中的状态横幅仍是整行高度

## [0.6.5-beta.3](https://github.com/chukui2005/GitGlass/compare/v0.6.5-beta.2...v0.6.5-beta.3) (2026-11-19)

### Performance

* stop re-rendering the whole command ledger ([f2ab5da](https://github.com/chukui2005/GitGlass/commit/f2ab5da2409c658a2550388d0a87817e14104e25))
* coalesce repository watcher events in large repositories ([4ea2d76](https://github.com/chukui2005/GitGlass/commit/4ea2d7621b0e8aa889df5799e0fa8fd28dcacd80))

### 运行时优化（行为不变）

* **`.git` watcher 修好了整类漏报**：`fs.watch` 在 `refs/heads` 上只报裸文件名，旧分类只认 `HEAD` / `index` / `packed-refs`，于是 200 个分支、`git fetch` 的远端 refs 全部被丢掉（改前测量：约 1200 个原始事件 → **0 次通知**）。现在按目录分类，`refs/` 下任何名字都算 `refs`。
* **事件合并**：首事件立即触发 + 尾随 800 ms + 硬上限 2 s，reason 按 `head > refs > index` 合并；原始事件数不再放大成通知数（1200 → 2）。外部 `git add` / `git commit` / `git checkout -b` 的界面更新从约 1.0–1.2 s 降到 **165–195 ms**。
* **读命令的 index-only 静默窗**：`repo:state` 的 `git status` 会写 `.git/index`，此前「首事件立即」会让它自己触发刷新；现在只静默 index，head/refs 仍即时上报。空闲 4 s 的事件数与账本增长均为 0。
* **命令账本不再整列重渲染**：记录对象身份复用（`reuseUnchangedRecords`）+ `CommandLedger`/`LedgerEntry`/`RefreshGroup`/`Output` 记忆化 + 稳定回调。一次与账本无关的 App 重渲染，120 条记录的字段读取从 **3600 次降到 0**。没有做虚拟列表——300 条两行结构的 DOM 不是瓶颈，窗口化会牺牲键盘可达性。

## [0.6.5-beta.2](https://github.com/chukui2005/GitGlass/compare/v0.6.5-beta.1...v0.6.5-beta.2) (2026-11-19)

### Refactors

* move the workbench components into workbench-ui ([e126f35](https://github.com/chukui2005/GitGlass/commit/e126f35fdd6f8fb3ecf447d73e870c78c9dea3a9))
* satisfy the hook dependency rules and fix two render gaps ([30e2145](https://github.com/chukui2005/GitGlass/commit/30e21455cad2c363f940a467f885b79f68a6ed53))
* move the remote overview into use-remote-overview ([5668d7c](https://github.com/chukui2005/GitGlass/commit/5668d7c1378e3ec64a3ccd3794d5b48d89746481))
* move the plan flows into use-safety-plans ([63c145e](https://github.com/chukui2005/GitGlass/commit/63c145e394095cea8c2408bb014faa02cc9c0c6f))
* move history review state into use-history-review ([1184871](https://github.com/chukui2005/GitGlass/commit/1184871370dae93c502f119d17ed3418271fffcb))

### 工程与质量（结构债，不改变产品行为）

* **`main.jsx` 拆分**：3027 → **1441 行**（−52%），领域状态抽成 `use-history-review` / `use-safety-plans` / `use-remote-overview` / `use-panel-resize` 四个 hook，26 个展示组件搬到 `workbench-ui.jsx`；DOM 结构、类名、`aria-*`、文案零改动
* **覆盖率不再排除 `main.jsx`**：四项 **75.03 / 69.71 / 71.95 / 77.64**（阈值仍 50%），exclude 只剩 `electron/main.cjs` 与 `electron/preload.cjs`
* **`exhaustive-deps` 清零**：4 条 warning 全部按规则修好（最新闭包 ref / effect 内就地派生 / 订阅每次渲染重建 / 纯函数替代 memo），lint 现在 **0 error / 0 warning**
* **顺带修掉两个真渲染测试暴露的缺口**：已暂存区在加载中「取消暂存」不再可点；`compare` 结果含二进制文件时「结果中包含二进制文件」提示不再丢失
* `tsconfig` 的 `include` 增加 `src/use-*.js`（四个 hook 都带 JSDoc 类型）

## [0.6.5-beta.1](https://github.com/chukui2005/GitGlass/compare/v0.6.4-beta.2...v0.6.5-beta.1) (2026-11-19)

### Features

* 最近仓库当前项补整行浅底 ([ddb4806](https://github.com/chukui2005/GitGlass/commit/ddb4806a52e079219e0c6af8aa0520502ad57e7d))
* 文件头三行压成一行面包屑 ([1ffa443](https://github.com/chukui2005/GitGlass/commit/1ffa443c6e5dfc461eff4df6f20382ffa3ee8dc7))
* 没有仓库时右栏改渲染引导块，不再显示整套禁用的提交表单 ([0dc8f62](https://github.com/chukui2005/GitGlass/commit/0dc8f62265240f154893f588745b88499d871bee))

### Bug Fixes

* 通知横幅改白底色条，并统一按钮禁用态 ([5a775f5](https://github.com/chukui2005/GitGlass/commit/5a775f53188007aa70ad882809301034a0d42f79))

### Performance

* start the update service after the window, not before it ([e0ad04a](https://github.com/chukui2005/GitGlass/commit/e0ad04a413db0217360975cf8b7994432070615d))

### 工程与质量（不改变产品行为）

* **UI 测试现代化**：引入 `@testing-library/react`，把 4 个测试文件里 32 例「读 `src/main.jsx` 源码字符串」的断言换成真渲染（假 `window.gitglass` 桥），用例 305 → 320；纯 CSS 断言单独收进 `tests/ui/style-contracts.test.cjs`；8 个真实 Electron 探针原样保留
* **依赖归类**：`dependencies` 只剩主进程真正 `require` 的 `electron-updater` 与 `semver`；`react` / `react-dom` / `@phosphor-icons/react` 移入 `devDependencies`（`scheduler` 作为传递依赖自动跟随），`app.asar` 内不再含这些包
* 启动探针与体积报告：`npm run report:startup -- --installed` / `npm run report:size` 可复测（见 `docs/size-and-performance.md`）

## [0.6.4-beta.2](https://github.com/chukui2005/GitGlass/compare/v0.6.4-beta.1...v0.6.4-beta.2) (2026-11-18)

### 工程与质量（不改产品行为）

* **ESLint flat config**：`electron/`（Node/CJS）、`scripts/` 与 `tests/`（Node/ESM）、`src/`（浏览器 ESM）三组环境；`npm run lint` 0 error，仅剩 4 条 `react-hooks/exhaustive-deps` warning（`main.jsx` 里依赖是刻意收窄的，留给 0.6.5 拆 hook 时一并处理）
* **类型检查**：`npm run typecheck`（`tsc --checkJs --noEmit`）覆盖 12 个主进程模块与 12 个有单测的渲染层纯逻辑模块，0 error；首轮 38 个报错全部真修，没有 `@ts-ignore`
* **覆盖率门槛**：`npm run test:coverage`（v8）四项阈值各 50%，当前 statement 79.94% / branch 70.61% / function 79.12% / line 83.27%
* **CI**：每个 PR 在原有 `test` + `build` 之外新增 `lint`、`typecheck`、`test:coverage` 三个步骤；`tests/release/ci-cd-workflows.test.cjs` 同步断言新步骤顺序
* 三个 Electron 入口（`src/main.jsx`、`electron/main.cjs`、`electron/preload.cjs`）排除在类型检查与覆盖率之外——它们只在渲染进程或 main 子进程里求值，由 `tests/ui/` 的真实启动探针覆盖，扩大范围的路径写在 `docs/improvement-plan.md`
* 新增 devDependencies：`eslint`、`@eslint/js`、`globals`、`eslint-plugin-react-hooks`、`typescript`、`@vitest/coverage-v8`、`@types/node`；`dependencies` 未变

## [0.6.4-beta.1](https://github.com/chukui2005/GitGlass/compare/v0.6.3...v0.6.4-beta.1) (2026-11-18)

### Features

* accept an explicit prerelease version ([8dcf16e](https://github.com/chukui2005/GitGlass/commit/8dcf16ef0ae1a63fdd0b1b11c5cde99168f11d17))

### Bug Fixes

* replace the legacy greys in the notice and recent-repository surfaces ([f753cb3](https://github.com/chukui2005/GitGlass/commit/f753cb3a51781e5c7e747c9938246247f0499c1b))
* stop labelling ordinary plans as rescue operations ([57b5c88](https://github.com/chukui2005/GitGlass/commit/57b5c882116efee0a123017aad94073f8fd17bf6))

### Refactors

* rebuild the panel splitters as thin draggable lines ([11cf204](https://github.com/chukui2005/GitGlass/commit/11cf2045c891699a5ab9c3755d94de56b835473e))
* rebuild the visual system on dbx neutral tokens ([3e5bd49](https://github.com/chukui2005/GitGlass/commit/3e5bd49cce4979c1c5d5da37db861d85dda060a6))
* tighten the sidebar, list and ledger density to match dbx ([72e4e60](https://github.com/chukui2005/GitGlass/commit/72e4e60009f45938f49f4c128b76f2c99fdbac51))

## [0.6.3](https://github.com/chukui2005/GitGlass/compare/v0.6.2...v0.6.3) (2026-11-18)

### Features

* refresh automatically when the repository or the window changes ([e590b5b](https://github.com/chukui2005/GitGlass/commit/e590b5b8d9596c5f6b4eb4b1f7311838e1142cf5))
* auto-dismiss transient notices after six seconds ([836df74](https://github.com/chukui2005/GitGlass/commit/836df7468ea4856c622bbef9d35340000f940ca9))
* add a recent repositories switcher ([78eaabb](https://github.com/chukui2005/GitGlass/commit/78eaabbe106a78483c1f287fe8a70a120a3c0f72))

### Bug Fixes

* keep a single changelog title on Windows ([96097e9](https://github.com/chukui2005/GitGlass/commit/96097e943125600fda733d3c0076d9f5bf4d48cc))
* keep the title bar on one line when window controls take space ([3903b8d](https://github.com/chukui2005/GitGlass/commit/3903b8dd6d3379a4795c2192885bfdc91d2ee419))
* let head and refs changes through the renderer quiet window ([19fb0c0](https://github.com/chukui2005/GitGlass/commit/19fb0c0246ff690d92b957daa4d4aa07d79fb1ff))
* make the remote entry point say it only opens a plan ([b8db667](https://github.com/chukui2005/GitGlass/commit/b8db667df5206d6a7c4e0f0f7253db58cfd02485))

### Refactors

* give small text and toolbar buttons a clear hierarchy ([e847e4a](https://github.com/chukui2005/GitGlass/commit/e847e4a6bee6cc30f085cfdd21a907e345655743))

## [0.6.2](https://github.com/chukui2005/GitGlass/compare/v0.6.1-beta.1...v0.6.2) (2026-11-18)

### Features

* remember recent repositories and explain in-progress git operations ([5919340](https://github.com/chukui2005/GitGlass/commit/5919340c44ee6d4c414b1da3bc259805b1021d91))

### Bug Fixes

* support releasing through a pull request on a protected main ([9c2d09b](https://github.com/chukui2005/GitGlass/commit/9c2d09bb082d2d40654f9d8a445fe4fdc04402dd))
* anchor the changelog to the previous tag even when it is a prerelease ([94808f0](https://github.com/chukui2005/GitGlass/commit/94808f05a3b8a408456ef12cf773f9b90797a901))
* give the workspace notice its own grid row ([e165d98](https://github.com/chukui2005/GitGlass/commit/e165d98632354d192679aecc98c818469ae5b415))
* show workspace notices under the title bar instead of inside the ledger ([b9e3995](https://github.com/chukui2005/GitGlass/commit/b9e3995d50048536341297a7c59ebb05320b41c1))
* tell the user when a working-tree diff was truncated ([b852aec](https://github.com/chukui2005/GitGlass/commit/b852aecdc42efd7d83741608075f3a805026a2c7))
* bound command runtime and keep credentials out of the ledger ([8d7f20e](https://github.com/chukui2005/GitGlass/commit/8d7f20e7a6aae6a4814e0045197cb35c1d803a6d))

### Performance

* stop the redaction patterns from backtracking on long output ([3e9123f](https://github.com/chukui2005/GitGlass/commit/3e9123f6859e4b3491ac5fbae445a5d9eb4e6105))

## [0.6.1-beta.1](https://github.com/chukui2005/GitGlass/compare/v0.6.0-beta.1...v0.6.1-beta.1) (2026-11-17)


### Bug Fixes

* restore release please tag creation ([03036c2](https://github.com/chukui2005/GitGlass/commit/03036c2a77c2ee37f51402d630b3cac8c1618eaa))
* restore Release Please tag creation ([e9d71af](https://github.com/chukui2005/GitGlass/commit/e9d71afbf922022f28c64c34129a1219f722c91d))
* verify Windows packaging before release ([1aa496a](https://github.com/chukui2005/GitGlass/commit/1aa496a84c2b1af9489f6ca7ef8a752a4c073b19))
* verify Windows packaging before release ([ef365b8](https://github.com/chukui2005/GitGlass/commit/ef365b85a4ec3205e0617fa0b90b5548260dd591))

## [0.6.0-beta.1](https://github.com/chukui2005/GitGlass/compare/v0.5.6-beta.1...v0.6.0-beta.1) (2026-11-17)


### Features

* add in-app updates for Windows NSIS installs ([1405c38](https://github.com/chukui2005/GitGlass/commit/1405c385ccf8daee53aa1afd67749f3a9fc08a55))
* add in-app updates for Windows NSIS installs ([5758907](https://github.com/chukui2005/GitGlass/commit/575890778741863c5da50e021605835117f1f06b))
* improve Chinese diff review with line coordinates ([9459e1d](https://github.com/chukui2005/GitGlass/commit/9459e1dca22d224fc016fd625062c981f4538cc4))


### Bug Fixes

* derive release artifact names from the package version ([2f63c9a](https://github.com/chukui2005/GitGlass/commit/2f63c9a8314e512baffb3e4841dfd22720a9a0f9))
* make workspace panels resizable ([a169741](https://github.com/chukui2005/GitGlass/commit/a169741ad75a98bb7370f5637e1fa35daaa2c26c))
