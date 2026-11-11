# GitGlass V0.2

GitGlass 是一款透明执行的桌面 Git 工作台：它直接调用用户本机的 `git`，并把计划、实际命令与 Git 状态变化放在同一个界面中。

## 运行

```powershell
npm install
npm run dev
```

选择本地 Git 仓库后，GitGlass 不会使用 Git 库模拟操作，也不会把等效命令伪装成真实执行记录。

## Command Ledger

底部的 Command Ledger 是 V0.2 的执行账本。

- 记录用户操作和后台读取：status、diff、branch、log、stage、commit 与分支操作。
- 每条实际执行记录包含 intent、source、argv、完整显示命令、工作目录、开始/结束时间、stdout、stderr、exit code 和成功状态。
- 支持按“全部 / 用户 / 后台”筛选，展开查看详情，并复制命令、stdout 或 stderr。
- 分支操作的计划命令不是执行记录；确认执行后，计划与实际 CommandRecord 通过相同的 `operationId` 关联。

## Branch Workspace

- 显示当前分支、本地分支、最近 30 条提交与简化提交图。
- 创建分支会先展示 `git switch -c <branch>` 计划；切换分支会先展示 `git switch <branch>` 计划。
- 两种操作都需要用户明确确认，且分支名由本机 Git 的 ref 规则验证。
- 工作区有改动时，分支创建和切换都会被阻断。GitGlass 不会自动 stash、丢弃改动或强制切换。
- V0.2 不包含远程分支、push、pull、merge 或 rebase。

## 安全与执行模型

渲染进程启用 context isolation 与 sandbox，只有 Electron 主进程能执行 Git。唯一的执行入口是 `GitCommandService`，使用：

```text
spawn('git', argv, { shell: false, windowsHide: true })
```

文件路径通过 Git 的 `--` 分隔；提交信息和分支名在构造 argv 前验证。原始错误输出不会被丢弃，会作为 Command Ledger 的一部分保留。

## 验证

```powershell
npm test
npm run build
```

测试同时包含 CommandRecord/解析单元测试与真实临时 Git 仓库集成测试。完整架构和验收证据见 [ARCHITECTURE.md](ARCHITECTURE.md) 与 [QA_REPORT.md](QA_REPORT.md)。
