# 包体积与启动性能：基线、瘦身清单与复测方法

本文是 0.6.4-beta.1 的一次**测量记录**：先给出可复现的基线数字，再按「收益 / 风险」列出瘦身与提速清单，最后写清下次怎么复测。
所有数字都是本机实测（Windows 11 / Node 24.21 / electron 45.2.3 / electron-builder 26.0.12），不是估算；标注「估算」的条目会单独说明。

## 0. 一句话结论

- 安装包 **113.6 MB → 102.1 MB**（−12.1 MB，−10.1%），ZIP **151.2 MB → 135.4 MB**（−16.5 MB，−10.4%），解压后磁盘占用 **384.5 MB → 310.9 MB**（−73.6 MB，−19.1%）。全部来自三条零风险配置改动（见第 4 节）。
- 剩下的 **309.1 MB（99.4%）全是 Electron 运行时**，我们的代码与资源只有 **1.8 MB**。再往下压体积只能动 Electron 自己的 DLL 或换运行时，不是改配置能解决的。
- 启动（模拟安装版）到渲染层就绪 **724 ms**：Electron 自身引导 163 ms、更新服务 36 ms、建窗 108 ms、首屏 104 ms。唯一值得动的启动项是**更新服务那 36 ms 卡在建窗之前**。
- 清单里有 3 项**实测后建议不做**：`compression: maximum`（安装包 ±0）、拆渲染层（`react-dom` 占 bundle 72%）、删 Electron DLL（风险高）。理由都在第 6 节。

## 1. 怎么复测（下次优化前后都跑这两条）

```powershell
# 0) 先出产物（约 2–5 分钟）；release/ 被占用时会 EPERM，先关掉所有 GitGlass.exe
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm run dist:win

# 1) 体积：产物字节数、解压目录 top 15、app.asar 构成、locale、运行时/自有代码占比
npm run report:size            # 或 node scripts/report-size.mjs --json 存成文件做 diff

# 2) 启动：3 次取中位数（--installed 模拟安装版，会临时补 resources/gitglass-installed）
npm run report:startup
npm run report:startup -- --installed
```

- `report:size` 只读 `release/`，不构建不联网，秒级返回；`app.asar` 的目录树是手工解析 asar 头（pickle 格式），不依赖 `asar` 包。
- `report:startup` 每次都用临时 `--user-data-dir` 冷启动打包后的 `GitGlass.exe`，跑完杀掉整棵进程树；它靠 `electron/startup-probe.cjs`（`GITGLASS_STARTUP_PROBE` 未设置时是空函数）记录阶段时间戳与 `app.getAppMetrics()`。
- **对比纪律**：同一台机器、同一电源模式、连着跑；3 次运行之间 total 的波动可达 ±100 ms，**小于 150 ms 的差异不要当成结论**。要证明某次优化有效，改动前后各跑 3 次并比阶段中位数，而不是只比 total。

## 2. 体积基线

### 2.1 产物

| 指标 | 基线（0.6.4-beta.1 原配置） | 现在（本 PR 之后） | 变化 |
| --- | --- | --- | --- |
| 安装包 `GitGlass-Setup-*-x64.exe` | 119,134,357 B（113.6 MB） | 107,054,582 B（102.1 MB） | −12.1 MB（−10.1%） |
| 便携 ZIP `GitGlass-*-win-x64.zip` | 158,509,149 B（151.2 MB） | 142,003,757 B（135.4 MB） | −16.5 MB（−10.4%） |
| 解压目录 `release/win-unpacked/` | 384.5 MB / 74 个文件 | 310.9 MB / 21 个文件 | −73.6 MB（−19.1%） |
| `resources/app.asar` | 27.7 MB / 4962 个文件 | 1.8 MB / 286 个文件 | −25.9 MB（−93.5%） |
| `locales/` | 55 个语言包 / 48.8 MB | 2 个 / 1.1 MB | −47.7 MB |
| 安装后磁盘占用（≈ 解压目录 + 卸载器） | 约 395 MB | 约 320 MB | −75 MB 量级 |

> 重建同一份配置时，签名时间戳会让字节数抖动几百字节（例如安装包两次构建差 145 B），对比时按 MB 看。

### 2.2 收益归因（三次单独构建实测，不是估算）

| 改动 | 安装包 | ZIP | 解压后 |
| --- | --- | --- | --- |
| 只保留 `zh-CN` + `en-US` 两个 locale | −8.1 MB | −11.1 MB | −47.7 MB |
| 再把 `@phosphor-icons` / `react` / `react-dom` / `scheduler` 排除出包 | −3.2 MB | −4.5 MB | −25.0 MB |
| 再排除所有 `*.map`（全部来自 `electron-updater` 的依赖链） | −0.1 MB | −0.2 MB | −0.9 MB |
| **合计** | **−12.1 MB** | **−16.5 MB** | **−73.6 MB** |

值得记住的比例：25 MB 的 `node_modules` 压进安装包只值 3.2 MB（React 的 `.js` / `.d.ts` 压缩率极高），而 47.7 MB 的 locale 值 8.1 MB。**「体积」和「压缩后体积」不是一回事**，这也是下面 `compression: maximum` 没效果的原因。

### 2.3 解压目录构成（现在，310.9 MB）

| 项 | 大小 | 占比 |
| --- | --- | --- |
| `GitGlass.exe`（Electron 主二进制） | 238.2 MB | 76.6% |
| `dxcompiler.dll` | 24.6 MB | 7.9% |
| `resources.pak` | 12.8 MB | 4.1% |
| `icudtl.dat` | 10.3 MB | 3.3% |
| `LICENSES.chromium.html` | 5.4 MB | 1.8% |
| `vk_swiftshader.dll` | 5.2 MB | 1.7% |
| `d3dcompiler_47.dll` | 4.5 MB | 1.5% |
| `ffmpeg.dll` | 3.0 MB | 1.0% |
| `resources/`（`app.asar` + `elevate.exe` + `app-update.yml`） | 1.9 MB | 0.6% |
| `locales/`（2 个） | 1.1 MB | 0.4% |
| `vulkan-1.dll` / `chrome_*_percent.pak` / `v8_context_snapshot.bin` / `electron_wer.dll` | 约 2.5 MB | 0.8% |

**归属**：Electron 运行时 **309.1 MB（99.4%）**，我们的代码与资源（`app.asar`）**1.8 MB（0.6%）**。
基线时这个比例是 356.8 MB（92.8%）对 27.7 MB（7.2%）。

### 2.4 `app.asar` 内部构成

| 目录/包 | 基线 | 现在 | 说明 |
| --- | --- | --- | --- |
| `node_modules/` | 25.9 MB（97.9%） | 1.1 MB（67.3%） | 见下表 |
| `dist/`（渲染层构建产物） | 422.5 KB | 422.5 KB | `index.js` 343.4 KB + `index.css` 50.7 KB + 图标 |
| `electron/`（主进程） | 91.1 KB | 92.8 KB | 13 个 `.cjs`（含启动探针） |
| `public/`（图标） | 37.0 KB | 37.0 KB | 与 `dist/` 里的同名图标重复，见清单第 7 项 |
| `LICENSE` / `package.json` | 11.6 KB | 11.6 KB | — |

`node_modules` 明细：

| 包 | 基线 | 现在 | 结论 |
| --- | --- | --- | --- |
| `@phosphor-icons/react` | 15.9 MB | — | Vite 已把用到的 20 个图标打进 `dist/`，整包是死重量 |
| `react-dom` | 7.7 MB | — | 同上（含 900 KB sourcemap） |
| `react` | 173.3 KB | — | 同上 |
| `scheduler` | 80.3 KB | — | `react-dom` 的传递依赖，同样已打进 bundle |
| `js-yaml` | 929.0 KB | 387.4 KB | `electron-updater` 读 `latest.yml` 的真实依赖，必须留 |
| `electron-updater` | 593.9 KB | 266.1 KB | 运行时必需 |
| `argparse` / `semver` / `builder-util-runtime` / `fs-extra` / `sax` / `lodash.isequal` / `graceful-fs` / `debug` | 约 800 KB | 约 470 KB | 都是 `electron-updater` 的传递依赖 |

**`build.files` 白名单本身是有效的**：基线包里也没有 `docs/`、`tests/`、`scripts/`、`src/`、`.github/`（实测 0 个条目），所以「收紧白名单」这一步原本就是达标的。
但基线里有 50 个 `*.map`（合计 1.0 MB）—— 全部来自 `electron-updater` 的依赖链（`js-yaml` 554 KB、`electron-updater` 336 KB、`builder-util-runtime` 110 KB、`lazy-val` 1 KB），与 `react` 无关，排除 React 并不能带走它们，所以单独加了 `!**/*.map`（第 4 节第 3 条）。

## 3. 启动基线

测量口径：`release/win-unpacked/GitGlass.exe` 冷启动（每次新建 `--user-data-dir`），外部墙钟从 `spawn` 到渲染层就绪；阶段时间戳来自进程内探针，相对 `main.cjs` 开始执行。

| 阶段 | 基线（未安装：更新服务跳过） | 基线（模拟安装版） | 现在（未安装） | 现在（模拟安装版） |
| --- | --- | --- | --- | --- |
| 进程启动 → 渲染层就绪（中位数） | 828 ms | 830 ms | 747 ms | **724 ms** |
| 其中 Electron 自身引导（`main.cjs` 之前） | 200 ms | 200 ms | 174 ms | 163 ms |
| 其中更新服务 `updates.initialize()` | 2 ms | **48 ms** | 2 ms | **36 ms** |
| 其中建窗（`updates-ready` → `new BrowserWindow`） | 160 ms | 150 ms | 143 ms | 108 ms |
| 其中首屏（`window-created` → 渲染层就绪） | 111 ms | 100 ms | 127 ms | 104 ms |
| 3 次 total 的实际范围 | 775–981 | 773–840 | 726–842 | 704–772 |

内存（`app.getAppMetrics()` 的工作集，渲染层就绪时刻，模拟安装版）：

| 进程 | 基线 | 现在 |
| --- | --- | --- |
| Browser（主进程） | 142.3 MB（峰值 143.9 MB） | 130.9 MB（峰值 132.9 MB） |
| Tab（渲染进程） | 73.7 MB | 72.5 MB |
| GPU | 90.1 MB | 86.6 MB |
| Utility（网络、代理解析两个进程，取各自中位数） | 53.5 MB | 54.6 MB |

四个进程的工作集合计约 **400 MB**（含 Chromium 的共享页，任务管理器里的「内存」通常更低）。这就是「整体 500 MB」的来源：**不是我们的代码，是 Chromium 的多进程模型**。

三条读数说明：

1. **`ready-to-show` 不是稳定信号。** 基线构建里它和 `did-finish-load` 同时出现（都在 613 ms，相差 <1 ms）；改造后的构建里只观测到 `did-finish-load`。脚本因此两个标记都记，优先用 `ready-to-show`，缺失时退到 `did-finish-load`（两者同时出现时相差 <1 ms，可以互换比较）。
2. **total 的差值不要归因到单个改动。** 安装版口径两次测量区间不重叠（773–840 → 704–772），可以确认「改造后没有变慢、确实快了几十到一百毫秒」，合理归因是 `app.asar` 从 4962 个文件降到 286 个（少读目录项、少映射 26 MB），但没有单点证据，别写进验收标准。
3. **更新服务的 36–48 ms 是唯一稳定可复现的阻塞项**：未安装时 1–2 ms、安装版 35–48 ms，六次运行无重叠。它卡在 `new BrowserWindow` 之前，所以 100% 落在首屏之前。

## 4. 已落地（本 PR，零风险）

| 项 | 改动 | 实测收益 | 风险 |
| --- | --- | --- | --- |
| 只保留两个 Electron locale | `build.electronLanguages: ["zh-CN", "en-US"]` | 安装包 −8.1 MB、ZIP −11.1 MB、解压后 −47.7 MB | 无：界面只有中文，缺的语言包会回退到 `en-US`，不影响启动与渲染 |
| 渲染层依赖不重复进包 | `build.files` 增加 `!node_modules/{@phosphor-icons,react,react-dom,scheduler}/**` | 安装包 −3.2 MB、ZIP −4.5 MB、`app.asar` −25.0 MB | 低：这些包只被 `src/` 以 ESM 引入、由 Vite 打进 `dist/`；主进程与 preload 都不 `require` 它们（已核对，且改造后的包实测能正常渲染） |
| 排除调试用 sourcemap | `build.files` 增加 `!**/*.map` | 安装包 −0.1 MB、ZIP −0.2 MB、`app.asar` −0.9 MB | 无：`.map` 只在调试时用，运行期不读 |

三条都不改产品代码、不改依赖清单、不改版本号；`tests/release/packaging-config.test.cjs` 与 `tests/release/size-performance-report.test.mjs` 守住这几条配置，防止有人改回去。

## 5. 待决策清单（按「收益 / 风险」排序）

| # | 项 | 收益 | 风险 | 要改什么 |
| --- | --- | --- | --- | --- |
| 1 | **更新服务延后到窗口创建之后** | 首屏前省 **36–48 ms**（实测：安装版 36 ms，基线构建 48 ms；未安装时只要 1–2 ms） | 中：`update:state` 在渲染层首次查询时必须有答案；`update:resume` 在窗口加载前就要能读草稿（`updateStore` 可以先建、`electron-updater` 后加载） | 产品代码（`electron/main.cjs`）：把 `await updates.initialize()` 移到 `mainWindow.loadFile()` 之后（或 `did-finish-load` 后 `void updates.initialize()`），并把 `supported` 判断与 `UpdateService` 构造拆成「先给状态、后加载更新器」两步 |
| 2 | 删掉用不到的 Electron DLL（`dxcompiler.dll` 24.6 MB、`vk_swiftshader.dll` 5.2 MB、`vulkan-1.dll` 0.9 MB） | 解压后 **−30.7 MB**，安装包预计 −8~10 MB（估算：按 locale 的压缩比外推） | **高**：SwiftShader 是显卡驱动异常时的软件回退，DXC 被 ANGLE/WebGPU 用；删了在部分机器上会黑屏或无法渲染，需要大量真机验证 | `afterPack` 钩子删文件（它们不在 `app.asar` 里，`build.files` 管不到） |
| 3 | 运行期依赖归类 | 语义正确性（不是体积）：`react` / `react-dom` / `@phosphor-icons/react` 应移到 `devDependencies`，真正运行期依赖只剩 `electron-updater` + `semver` | 低-中：需要同步改 `package-lock.json`（本机不能跑 `npm install`），改错会让 CI 的 `npm ci` 直接失败 | `package.json` + `package-lock.json`，必须在能跑 `npm install` 的环境做 |
| 4 | `compression: maximum` | **实测 ≈ 0**：安装包 +455 B（噪声内），ZIP −393 KB（−0.25%），构建时间明显变长 | 低（只是慢） | 不建议落地，见第 6 节 |
| 5 | 渲染层按需加载（历史审阅面板拆包） | 上限很小：`main.jsx` 只占 bundle 源码的 13.2%，历史审阅相关组件约占其中 9.5%（≈4 KB min / ≈1.5 KB gzip） | 低-中：拆包会引入异步边界与首屏骨架，交互变复杂 | 不建议做，见第 6 节 |
| 6 | 用内联 SVG 替掉 `@phosphor-icons/react`（20 个图标） | 源码 49.5 KB（占 bundle 5.8%），min 后约 −15 KB / gzip ≈ −5 KB | 低：纯替换，但要逐个核对视觉 | `src/main.jsx`、`src/app-updates.jsx`、`src/recent-repositories-menu.jsx`；收益太小，优先级低于第 1 项 |
| 7 | `public/` 与 `dist/` 的图标重复 | 约 37 KB（忽略不计） | 低 | 不值得做 |
| 8 | 内存：命令账本虚拟列表、超大仓库 watcher 降噪 | 账本 300 条全量渲染 → 虚拟列表，可省渲染进程内存与滚动卡顿；watcher 已在 0.6.3 做过 800 ms 去抖，只剩 `objects/` 降噪 | 中（交互回归风险） | 产品代码；属于 0.6.5 的结构债，不在本次范围 |

**如果只做一件事**：第 1 项（更新服务延后），它同时改善首屏时间与「窗口先出来、更新在后面忙」的观感，且是唯一一个收益超过噪声的启动项。

## 6. 为什么不建议做（负结果，省得下次再试）

- **`compression: maximum`**：实测安装包 119,134,357 → 119,134,812 B（**+455 B**），ZIP 158,509,149 → 158,106,478 B（**−393 KB，−0.25%**），而 NSIS 构建时间明显变长。NSIS 目标本来就是 LZMA solid 压缩，`compression` 主要影响 zip/7z 目标。electron-builder 自己的文档也写着「maximum 不会带来明显体积差异，但会增加构建时间」——这次用数字确认了。
- **拆渲染层**：实测 bundle 源码构成是 `react-dom` 72.4%、`src/main.jsx` 13.2%、`@phosphor-icons/react` 5.8%、`react` 2.2%、`src/` 其他模块 5.2%。343 KB 的 JS 里四分之三是 React 本身，按功能拆包拆不出体积，只能拆出复杂度。
- **删 `LICENSES.chromium.html`（5.4 MB）**：Chromium 的许可证文件，属于分发合规要求，不建议动。
- **继续挤 `electron-updater` 的 1.1 MB**：`js-yaml`（387 KB）是读 `latest.yml` 的真实依赖，`electron-updater`（266 KB）里是多平台 provider，删哪个都可能让某条更新路径静默失效，收益 1 MB 量级，不值得。

## 7. 测量方法与已知坑

### 7.1 两层计时

| 层 | 怎么做 | 得到什么 |
| --- | --- | --- |
| 外部墙钟 | `spawn` 打包后的 `GitGlass.exe`，轮询探针文件，直到出现就绪标记 | total（含 Electron 自身引导，这是用户真正感受到的时间） |
| 进程内探针 | `electron/startup-probe.cjs` 写 JSON Lines：`whenReady` / `updates-ready` / `window-created` / `did-finish-load` / `ready-to-show`，并附 `app.getAppMetrics()` | 阶段拆分与内存；探针在 `GITGLASS_STARTUP_PROBE` 未设置时是空函数 |

探针是**唯一**进入产品代码的改动（`electron/main.cjs` 里 2 处调用 + 1 个条件分支），全部由环境变量开关控制，未设置时不写文件、不注册监听、不改启动顺序。

### 7.2 踩过的坑（下次别重复）

1. **`ready-to-show` 是 `BrowserWindow` 的事件，不是 `webContents` 的。** 挂在 `webContents` 上时偶尔能触发、偶尔不能，看起来像「有时 1100 ms、有时根本不来」。现在挂在 `mainWindow` 上，并额外记 `did-finish-load` 兜底。
2. **`win-unpacked` 不是安装版。** 主进程用 `resources/gitglass-installed` 判断「是否安装版」，没有这个标记时更新服务直接按「不支持」跳过（`updates.initialize()` 只要 1–2 ms），会把启动测快。`--installed` 会临时补上这个标记，跑完删除。
3. **`release/` 被占用时构建会 `EPERM`。** 之前的测量进程没杀干净，`electron-builder` 删不掉 `GitGlass.exe`。跑 `dist:win` 前先确认 `Get-Process GitGlass` 为空；`report:startup` 自己会杀干净（`taskkill /T /F`）。
4. **本机 `node_modules` 是 junction，`electron-builder` 会挂。** 从 worktree 里跑 `npm list`（electron-builder 靠它收集生产依赖）时，npm 把 `builder-util-runtime` 的 `debug` / `sax` 报成 `missing`，构建直接以 `dependency path is undefined` 失败。绕法是让 `npm list` 用主仓库的真实路径：本机临时加了个 `npm.cmd` 垫片，只在 `list` 子命令后追加 `--prefix <主仓库>`。**CI（全新 `npm ci`，无 junction）不需要这个垫片**，所以没有提交。
5. **不要用 PowerShell 的 `Set-Content -Encoding utf8` 改 `package.json`**：会写 BOM，`app-builder.exe` 读不了，报 `readObjectStart: expect { or n, but found ...`。要用无 BOM 的 UTF-8 写。

## 8. 下次优化的对照表

| 想验证的事 | 看哪个数 | 当前基线 |
| --- | --- | --- |
| 安装包是否变小 | `report:size` 第一张表的 `.exe` 字节数 | 107,054,582 B |
| 便携版是否变小 | 同上 `.zip` | 142,003,757 B |
| 用户安装后占多少磁盘 | `win-unpacked` 总计 | 310.9 MB |
| 我们自己写了多少东西 | `app.asar` 解包字节数 | 1.7 MB |
| 首屏是否变快 | `report:startup --installed` 的 total 中位数 | 724 ms |
| 更新服务是否还在阻塞首屏 | 同表的「更新服务」列 | 36 ms（改造前 48 ms） |
| 内存是否变差 | 同表的内存段 + 峰值工作集 | Browser 130.9 MB / 峰值 132.9 MB |
