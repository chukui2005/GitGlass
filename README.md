# GitGlass V0.4

GitGlass 是一款透明执行的桌面 Git 工作台：它直接调用用户本机的 `git`，并把计划、实际命令与 Git 状态变化放在同一个界面中。

## 运行

```powershell
npm install
npm run dev
```

选择本地 Git 仓库后，GitGlass 不会使用 Git 库模拟操作，也不会把等效命令伪装成真实执行记录。

## Command Ledger

底部的 Command Ledger 是 V0.2 的执行账本。

- 记录用户操作和后台读取：status、diff、branch、log、stage、commit、分支操作与全部远程读取/同步操作。
- 每条实际执行记录包含 intent、source、argv、完整显示命令、工作目录、开始/结束时间、stdout、stderr、exit code 和成功状态。
- 支持按“全部 / 用户 / 后台”筛选，展开查看详情，并复制命令、stdout 或 stderr。
- 分支操作的计划命令不是执行记录；确认执行后，计划与实际 CommandRecord 通过相同的 `operationId` 关联。

## Remote Sync Workspace

右侧“远程同步”会显示当前分支的 upstream（例如 `origin/main`）、远程名称、经脱敏的 URL，以及 Ahead / Behind 提交数。未配置 remote 或 upstream 时会显示原因和下一步建议。

- Fetch 先预览 `git fetch <remote>`，确认后执行。
- Push 仅在 Ahead 大于 0 时可用，执行固定为 `git push <remote> <localBranch>:<remoteBranch>`；预览会说明不会使用 `--force`。
- Pull 仅在 Behind 大于 0、工作区干净且本地历史可 fast-forward 时可用，执行固定为 `git pull --ff-only <remote> <branch>`。
- 远程操作重新校验安全条件后才会执行；计划与实际 CommandRecord 使用同一个 `operationId`。Fetch、upstream、remote URL、Ahead / Behind 与 fast-forward 检查都进入 Command Ledger。
- GitGlass 不提供 force push、删除远程分支、自动 merge、rebase、stash、reset 或丢弃文件。

## Branch Workspace

- 显示当前分支、本地分支、最近 30 条提交与简化提交图。
- 创建分支会先展示 `git switch -c <branch>` 计划；切换分支会先展示 `git switch <branch>` 计划。
- 两种操作都需要用户明确确认，且分支名由本机 Git 的 ref 规则验证。
- 工作区有改动时，分支创建和切换都会被阻断。GitGlass 不会自动 stash、丢弃改动或强制切换。
- V0.3 仍不包含远程分支管理、merge 或 rebase；远程同步范围仅限普通 Push、Fetch 与 `pull --ff-only`。

## Safety & Recovery Center

GitGlass V0.4 为三个常见恢复场景提供“计划 → 风险确认 → 执行 → 账本”的窄操作范围：

- 仅可丢弃单个、已跟踪、未暂存文件的改动：`git restore --worktree -- <path>`。必须查看 Diff 并输入文件名确认；未跟踪文件、已暂存文件、批量丢弃、`git clean`、`reset --hard` 与 `checkout .` 都不提供。
- 仅可删除已合并且非当前的本地分支。GitGlass 先执行 `git merge-base --is-ancestor <branch> HEAD`，只在成功后计划 `git branch -d <branch>`；永不使用 `git branch -D`。
- 恢复中心读取最近 20 条 reflog，并只允许创建 `rescue/<timestamp>-<shortSha>` 救援分支：`git branch rescue/<timestamp>-<shortSha> <fullSha>`。它不会 reset、切换或重写 HEAD，也不会覆盖现有分支。

所有 V0.4 计划与最终执行共享同一个 `operationId`。计划只是预览，不会进入 Command Ledger；真实执行仍保存完整 argv、cwd、stdout、stderr 与 exit code。

## 安全与执行模型

渲染进程启用 context isolation 与 sandbox，只有 Electron 主进程能执行 Git。唯一的执行入口是 `GitCommandService`，使用：

```text
spawn('git', argv, { shell: false, windowsHide: true })
```

文件路径通过 Git 的 `--` 分隔；提交信息和分支名在构造 argv 前验证。原始错误输出不会被丢弃，会作为 Command Ledger 的一部分保留。远程 URL 的用户名、密码、query 参数和 fragment 会在写入 Ledger 前脱敏。

## 验证

```powershell
npm test
npm run build
```

测试同时包含 CommandRecord/解析单元测试、真实工作流测试、远程同步集成测试，以及真实临时仓库的安全与恢复集成测试。完整架构和验收证据见 [ARCHITECTURE.md](ARCHITECTURE.md) 与 [QA_REPORT.md](QA_REPORT.md)。
