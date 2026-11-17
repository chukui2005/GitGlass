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
| 5 | **不记得最近打开的仓库**：`repoPath` 只来自 `GITGLASS_REPOSITORY` 环境变量或更新恢复，每次启动都要重新选 | `main.cjs:12,125-128` | `userData/recent-repos.json` 存最近 5 个，启动自动打开最后一个，顶栏提供切换 |
| 6 | 多处异步操作缺 `try/finally`，异常后 `loading` 永久为 `true`（界面变灰、所有按钮禁用） | `src/main.jsx:1627,1658,1714,1788,1501` | 统一 `withLoading()` 包装；异常统一走 `setNotice` |
| 7 | `refreshAll` 生成了 `refresh-*` 序号却从不比较，只有历史查询序号生效；快速连点会出现旧响应覆盖新状态 | `src/main.jsx:1376,1391-1398` | 与 `historyQuerySequence` 同款：响应返回时比对序号，丢过期结果 |
| 8 | 处于 merge / rebase / cherry-pick 中途的仓库没有识别，用户在应用里看到的"脏工作区"提示会误导 | 全局（`.git/MERGE_HEAD` 等均未读取） | `state()` 增加 `operation: 'merge' \| 'rebase' \| null`，UI 明确提示"请在终端完成或中止该操作" |

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
