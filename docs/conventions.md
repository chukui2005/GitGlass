# 仓库规范（GitGlass conventions）

本文件是**仓库内部**的工程规范，面向维护者。对外文档（README、发布说明等）仍用英文。
新增文件前先看这里：放错地方比多写一个文件更麻烦。

## 1. 根目录只放"必须被工具发现"的文件

根目录白名单（新增根目录文件需要在本文件里登记理由）：

| 路径 | 为什么必须在根目录 |
| --- | --- |
| `README.md` / `README.zh-CN.md` | GitHub 仓库首页，双语成对 |
| `CONTRIBUTING.md` | GitHub 会在新建 Issue/PR 时自动展示 |
| `LICENSE` | GitHub 许可证识别 |
| `CHANGELOG.md` | 发版脚本生成，**禁止手改**（要改措辞就改提交信息或发版前手改段落） |
| `package.json` / `package-lock.json` | npm 入口 |
| `.node-version` | CI 与本地统一 Node 版本 |
| `.gitignore` | — |
| `index.html` / `vite.config.mjs` | Vite 入口 |
| `eslint.config.mjs` | ESLint flat config；ESLint 只从当前工作目录向上找这个文件名，放别处 `eslint .` 就找不到规则 |
| `tsconfig.json` | `tsc --noEmit` 的入口。不用 `jsconfig.json`：`tsc` 默认只找 `tsconfig.json`，用 jsconfig 每次都得 `-p`，而且将来引入 `.ts` 时不用换文件名 |
| （无）版本号只写在 `package.json`，由 `npm run release` 维护 |

其他任何 `*.md` 一律进 `docs/`，不要再往根目录丢。

## 2. 目录职责

```
.github/workflows/   CI：ci.yml（PR 校验）、publish-release.yml（tag → Release）
build/               electron-builder 的 NSIS 资源（installer.nsh），名称由 electron-builder 约定，不要改
docs/                除根目录白名单外的全部文档
  architecture.md      架构与模块边界
  design.md            设计语言与交互规范
  ci-cd.md             GitHub 仓库管理员一次性配置
  releasing.md         发版流程（唯一权威）
  updates.md           应用内更新机制与验收
  conventions.md       本文件
  archive/             明确过时、但想留作历史记录的文档
  assets/readme/       仅放 README 引用的图片（有测试校验这个前缀）
electron/            主进程与 preload：一文件一职责，CommonJS（.cjs）
public/              打包进安装包的静态资源（图标、logo）
scripts/             构建/发布用脚本（.mjs），每个脚本都要有对应测试
src/                 渲染层（React），当前扁平结构；超过 ~15 个文件时再按 feature 拆分
tests/               见第 4 节
```

## 3. 文档规范

- **命名**：`docs/` 内用小写 kebab-case（`releasing.md`、`ci-cd.md`）。根目录白名单文件沿用 GitHub 约定的大写名。
- **语言**：根目录 README 必须中英成对、`<!-- section:xxx -->` 顺序一致（`tests/docs/readme-language-parity.test.cjs` 会校验）；`docs/` 面向外部读者用英文；`CONTRIBUTING.md` 与本文件面向维护者用中文。
- **单一事实来源**：发版流程只写在 `docs/releasing.md`，其他文档只能链接过去，不得复述步骤。
- **过时文档**：不要直接删掉仍在 README 里被引用的文档；先移入 `docs/archive/` 并同步改链接，确认无人引用后再删。
- **图片**：只允许 `docs/assets/readme/` 下的文件名出现在 README 的图片语法里，且文件必须已提交。
  `public/logo.svg` 与 `docs/assets/readme/logo.svg` 是同一份 SVG 的两个用途副本（应用 favicon / README 配图），改图标时两处一起改。

## 4. 测试规范

按"测试代价"分层，不按功能堆在一起：

```
tests/
  unit/        纯逻辑：不启动 Electron、不碰真实 git 仓库
  ui/          Electron 探针：渲染真实窗口后断言 DOM（必须轮询等待，禁止固定 sleep）
  integration/ 真实 git：在临时目录里执行 git 命令，带 .integration.test.cjs 后缀
  release/     打包/工作流/校验和/发版脚本的配置断言
  docs/        文档一致性（中英 README、文案）
  support/     上述测试共用的探针与 fixture（不是测试用例）
```

- **命名**：`<area>.<kind>.test.{cjs,mjs}`，`kind` 只在 `integration` 层出现（如 `remote-sync.integration.test.cjs`）。
- **路径约定**：子目录里的测试引用仓库根用 `path.join(__dirname, '..', '..')`，引用共用探针用 `path.join(__dirname, '..', 'support', ...)`，引用脚本用 `../../scripts/xxx.mjs`。
- **禁止固定延时**：UI 探针统一用轮询（参考 `tests/support/update-ui.cjs` 里的 `waitUntil`），超时信息里带最后观测值——CI 冷启动比本地慢，`pause(250)` 一定会翻车。
- **禁止版本硬编码**：测试不得写死当前版本号。需要版本时从 `package.json` 读（`tests/release/release-checksums.test.mjs` 是范例）——版本一改，硬编码的测试必红。
- **不访问外网**：需要网络的逻辑用本地 `http://127.0.0.1:<port>` 假服务或 mock。

## 5. 提交前必须通过 lint / typecheck / coverage

三道门禁都在 CI 的 `Quality (test and build)` 作业里跑（`.github/workflows/ci.yml`）。本地先跑一遍，比等 CI 红一次快得多：

```powershell
npm run lint            # ESLint flat config：必须 0 error
npm run typecheck       # tsc --noEmit：必须 0 error
npm run test:coverage   # vitest run --coverage：四个百分数都要过阈值
```

| 门禁 | 配置文件 | 当前门槛 |
| --- | --- | --- |
| `npm run lint`（`lint:fix` 自动修） | `eslint.config.mjs` | **0 error**；`react-hooks/exhaustive-deps` 设为 warn，允许存在 |
| `npm run typecheck` | `tsconfig.json` | **0 error**（`strict: false`，先挡住真实类型错误） |
| `npm run test:coverage` | `vite.config.mjs` 的 `test.coverage` | statements / branches / functions / lines **各 50%** |

约定：

- **不要用 `eslint-disable` 大面积压规则。** 确需 disable 时只覆盖最小范围，并在同一行写 `-- 理由`（例：`// eslint-disable-next-line no-control-regex -- 这里就是要匹配控制字符`）。
- **不要用 `// @ts-ignore`。** 只有第三方类型边界确实无法标注时才用，且同一行写理由；优先补 JSDoc `@param` / `@returns` / `@typedef`。
- `tsc` 的 `include` 只覆盖**主进程 + 已经有单测的纯逻辑模块**。`src/main.jsx` 暂不纳入：JSX 类型化要等 0.6.5 把 hook 拆出去之后再做（见 [improvement-plan.md](improvement-plan.md)）。
- 覆盖率 `include` 是 `src/**/*.{js,jsx}` + `electron/**/*.cjs`；`exclude` 只有 `src/main.jsx`、`electron/main.cjs`、`electron/preload.cjs` —— 这三个是只在 Electron 子进程里运行的入口，v8 的进程内覆盖率看不到它们，实际覆盖由 `tests/ui/` 的真实启动探针负责。**新增 exclude 必须在 [improvement-plan.md](improvement-plan.md) 里写明理由。**
- 普通 `npm test` / `npm run build` 不带覆盖率、不生成 `coverage/`；`coverage/` 已在 `.gitignore` 里。
- 门槛先定 50%（实测值见 [improvement-plan.md](improvement-plan.md) 的交付记录），`main.jsx` 拆完后往上提。

## 6. 源码规范（摘要）

- `electron/` 里每个模块只做一件事，通过 IPC 暴露给渲染层；preload 只暴露必要方法，不接受渲染层传入的可执行路径/URL/argv。
- 任何会改变仓库状态的 IPC 必须走"计划 → 执行"两步并写 Command Ledger。
- 新增运行时依赖要同时更新 `package.json`、`package-lock.json`，并确认 `build.files` 允许它被打包（`tests/release/packaging-config.test.cjs` 会校验）。

## 7. `.gitignore` 规范

必须忽略（生成物 / 本机状态，永远不提交）：

| 规则 | 说明 |
| --- | --- |
| `node_modules/`、`dist/`、`release/` | 依赖与构建产物 |
| `.tmp-*`、`*.log` | 本地调试日志（例：`npm test *> .tmp-test.log`） |
| `demo-repo/`、`output/` | 本机联调用的临时仓库与输出 |
| `.env`、`.env.*`（保留 `.env.example`） | 凭据 |
| `.vscode/`、`.idea/`、`Thumbs.db`、`Desktop.ini` | 编辑器与系统文件 |
| `.screenshots/`、`.trae-html-share-packages/` | 截图与 IDE 分享缓存 |
| `coverage/`、`.vitest/` | 测试覆盖率与缓存 |

必须提交（即使看起来像生成物）：`CHANGELOG.md`、`build/installer.nsh`、`docs/assets/readme/*`、`public/*`。

## 8. 分支、提交与 PR

- 分支：`feat/…`、`fix/…`、`chore/…`、`docs/…`、`ci/…`；合并后立即删除。
- 提交/PR 标题必须符合 Conventional Commits：`CHANGELOG.md` 按它分组，`feat!:` / `BREAKING CHANGE` 才会被标成破坏性变更。
- 一个 PR 只做一件事；文档改动与行为改动分开提交。
- 合并方式：`Rebase and merge`（保留逐条提交）或 `Squash and merge`（一个 PR 一条，标题必须是 conventional）。避免普通 merge commit：历史变非线性，且 CHANGELOG 容易重复。

## 9. 发版

权威流程见 [releasing.md](releasing.md)。踩过的坑已经写进那边，四条必须记住：

1. **版本号只能有一处来源**：`package.json`。任何脚本/测试写死版本号都是定时炸弹。
2. **CI 上的 Electron 二进制**：`npm ci` 后必须 `npm run prepare:electron`（`pretest`/`prepack:win` 已挂好钩子），否则 `dist:win` 在 runner 上直接失败。
3. **tag 与 Release 必须一一对应**：`npm run release` 打 tag、`push --follow-tags` 触发 `publish-release.yml` 建 Release；推完后先确认 tag 出现、再确认 Release 出现。曾出现过"只有 tag 没有 Release"的孤儿版本。
4. **发布前本地跑一次** `npm run dist:win`；`verify-release` 会校验 tag/版本/5 个产物/latest.yml 的 sha512。
5. **版本号只在 `0.x` 里慢慢走**：手写 `0.6.9 → 0.6.10`，`0.7.0` 留给破坏性变更，`1.0.0` 必须手动决定。详见 [releasing.md](releasing.md#version-policy)。
6. **正式版不要标 prerelease**：GitHub 的 **Latest** 徽标与仓库侧栏 Releases 卡片只认"最新的非 prerelease release"。Beta 用带 `-` 的 tag 单独发，两种写法：路线图点名的 `v0.6.4-beta.1`，或 `--beta` 自动生成的 `-beta.<日期>.<序号>`。

## 10. 清理规范（容易忘）

| 对象 | 何时清 |
| --- | --- |
| 已合并分支（本地 + 远端） | PR 合并后立刻 |
| `git worktree` 临时目录 | 对应分支合并后 `git worktree remove` |
| 备份分支 `backup/*` | 确认对应改动已进 main 后 |
| 孤儿 tag（无 Release） | 确认无产物后 `git push origin --delete <tag>` |
| 本地 `release/`、`dist/` | 可随时删，已被忽略 |

## 11. 结构整理记录

- 文档收敛：`ARCHITECTURE.md`→`docs/architecture.md`、`DESIGN_V2.md`→`docs/design.md`、`CI_CD.md`→`docs/ci-cd.md`、`RELEASING.md`→`docs/releasing.md`、`UPDATES.md`→`docs/updates.md`；过时的 `DESIGN.md`、`QA_REPORT.md` 移入 `docs/archive/`。
- 删除死资源：`docs/assets/readme/history-review.png`（README 已不再引用）。
- 测试分层：32 个测试从平铺改为 `tests/{unit,ui,integration,release,docs}`，共用探针仍留在 `tests/support/`，路径已按第 4 节规则改写。
- 链接同步：README、README.zh-CN、CONTRIBUTING、`docs/releasing.md`、`tests/release/ci-cd-workflows.test.cjs`。
- `.gitignore` 增补 `*.log`、`.tmp-*`、`Thumbs.db`、`Desktop.ini`、`.idea/`、`*.iml`、`coverage/`、`.vitest/`。
- 工程门槛（0.6.4-beta.2）：根目录新增 `eslint.config.mjs`、`tsconfig.json`（均已登记进第 1 节白名单），`vite.config.mjs` 增加 `test.coverage`；CI 在 `npm test` 之后增加 `lint` / `typecheck` / `test:coverage` 三步，`tests/release/ci-cd-workflows.test.cjs` 同步断言。第 5 节记录了命令与阈值。
- 为过 lint 做的等价改动：`UpdateService` 的 `Object.assign(this, …)` 改为逐条属性赋值；`src/{app-updates,recent-repositories-menu,main}.jsx` 删掉 React 19 新 JSX 转换下已无用的 `import React` 与两个未使用的图标导入；`main.jsx` 命令行提示里的 U+3000 改成显式 `{"\u3000"}`。

### 待办（需要单独 PR）

- `src/` 目前 12 个文件仍是扁平结构；到 ~15 个文件时按 `src/features/<area>/` 拆分。
- `docs/assets/readme/logo.svg` 与 `public/logo.svg` 内容相同：若想彻底去重，把 README 图片改指向 `public/logo.svg`，并放宽 `tests/docs/readme-language-parity.test.cjs` 的图片前缀断言。
