# GitGlass V0.4 发布验收报告

## V0.5 History & Review Lens

真实 Git 集成测试构造三次提交和一次重命名，验证提交详情、两提交 argv 顺序、`--follow` 文件历史、非法 SHA/路径阻断、1 MiB Diff 截断和所有 V0.5 记录均为 background。Electron 截图使用独立的 `D:\GitGlass-v05-sandbox`：其中含三次提交、`before.txt` 到长文件名的重命名、长主题和未暂存改动。

截图路径：`output/history-v05-1440.png`（提交 Diff）、`output/history-v05-1280.png`（两提交比较）、`output/history-v05-1024.png`（文件历史）和 `output/workspace-v05-1440.png`（V0.4 工作区入口）。

**结论：通过**
**验收范围：** Command Ledger、Branch Workspace 和 Remote Sync Workspace。

## 构建与测试输出

```text
npm test
Test Files  5 passed (5)
Tests       10 passed (10)

npm run build
vite v8.3.7 building client environment for production...
✓ built successfully
```

## Mock 单元测试

以下测试使用受控的进程替身，仅验证命令服务与解析逻辑的边界条件；它们不作为真实 Git 行为的证据。

| 测试文件 | 覆盖内容 | 结果 |
| --- | --- | --- |
| `tests/git-command-service.test.cjs` | CommandRecord 字段、`shell:false`、stdout/stderr、失败记录 | 通过 |
| `tests/git-parsers.test.cjs` | porcelain 状态、分支和提交输出解析 | 通过 |
| `tests/repository-service.test.cjs` | 脏工作区阻断、安全分支名、计划/执行 operationId 透传 | 通过 |

## 真实 Git 集成测试

`tests/real-git-workflow.integration.test.cjs` 不使用 mock。测试创建临时本地 Git 仓库，并以实际 `GitCommandService` 调用用户本机 `git`：

1. 写入并修改 `note.txt`，读取真实 `git diff`；
2. 使用 `git add -- note.txt` 暂存；
3. 使用 `git commit -m` 创建提交；
4. 计划并确认 `git switch -c feature/ledger`；
5. 计划并确认干净工作区的 `git switch main`；
6. 再次修改文件，并验证切换分支被阻断；
7. 验证创建/切换分支的计划和实际 CommandRecord 具有相同 `operationId`；
8. 验证 Ledger 包含 `diff` 与后台 `status` 记录。

测试结束后会递归删除临时仓库。

## 真实远程同步集成测试

`tests/remote-sync.integration.test.cjs` 不使用 mock。它创建一个临时 bare `origin` 和两个本地 clone，全部 Git 操作都通过真实 `GitCommandService` 调用本机 Git：

1. 读取 upstream、经脱敏的 remote URL 和 Ahead / Behind；
2. 计划、确认并记录 `git fetch origin`；
3. 创建本地领先提交，计划、确认并记录普通 `git push origin main:main`；
4. 由第二个 clone 产生远程提交，Fetch 后以 `git pull --ff-only origin main` 完成快进；
5. 在 Behind 状态写入未提交工作区改动，验证 Pull 被阻断且不自动 stash；
6. 生成本地/远程分叉，验证 Pull 在执行前因无法 fast-forward 被阻断，且 `merge-base` 的 exit code 保留；
7. 验证 Ledger 包含 remote、remote URL、Ahead / Behind、fetch、push 和 pull 的真实记录，并验证三种远程实际操作与其计划共享 `operationId`。

另有 URL 脱敏单元测试，确认凭据、query 参数和 fragment 不会进入 Command Ledger。

## 人工 UI 验收

已在 Electron 渲染器中检查以下场景：

- 文件选择按钮与暂存/取消暂存图标按钮相邻且独立；图标按钮具备可读 `aria-label`。
- 分支切换先显示“计划执行（尚未运行）”，确认后执行；脏工作区显示阻断原因且不提供 stash、force 或丢弃入口。
- Command Ledger 显示用户与后台记录，展开项包括 cwd、原始 argv、完整命令、stdout、stderr、退出代码和复制控件。
- 异步通知使用 `aria-live="polite"`；存在 h1、skip link、深色 `color-scheme`、输入项的 name/autocomplete 和键盘焦点态。
- 1024px 宽度下 stdout 与 stderr 均保留，以纵向方式显示。
- 远程同步位于右侧操作上下文：Push 使用青绿色、Behind/Pull 使用黄色，脏工作区或安全阻断使用红色；没有远程时显示可操作的空状态。

## 截图

本次无可交付的 V0.3 截图。当前自动化主机没有可用 display surface，Electron 的 `capturePage()` 返回 `Current display surface not available`；旧 V0.2 截图不作为本版 UI 证据。应在具备桌面显示表面的验收机上打开任意带 remote 的本地仓库，复核远程同步区的 Ahead / Behind、脱敏 URL、计划命令确认和 Command Ledger 展开详情。

## 安全审计

执行：

```powershell
rg -n "shell\s*:\s*true|\beval\s*\(|execSync|child_process|spawn\(" . -g '!node_modules' -g '!dist' -g '!output'
```

应用运行时代码中，唯一的 `child_process.spawn` 位于 `electron/git-command-service.cjs`，并固定采用 `spawn('git', argv, { shell: false, windowsHide: true })`。未发现 `shell:true`、`eval`、字符串命令执行、自动 stash、强制切换、force push、远程删除、自动 merge、rebase 或 reset。V0.3 仅以明确 argv 实现普通 push、fetch 与 `pull --ff-only`。

## V0.4 Safety & Recovery 验收

`tests/safety-recovery.integration.test.cjs` 使用真实临时 Git 仓库和本机 Git，不使用 mock：

1. 修改已跟踪文件，验证 prepare 不改文件；确认后通过 `git restore --worktree -- note.txt` 恢复 HEAD 内容，并验证计划/执行 operationId 相同。
2. 验证未跟踪文件及已暂存文件都不能进入丢弃流程。
3. 验证已合并分支只能用 `git branch -d feature/merged` 删除，且记录为 user source。
4. 验证未合并分支被阻断，并断言整段真实 Ledger 没有 `git branch -D`。
5. 读取真实 reflog，创建 `rescue/...` 分支，验证其 ref 精确指向所选完整 SHA，且计划/执行 operationId 相同。

人工 Electron 验收覆盖高风险丢弃确认页、未合并分支阻断页，以及创建救援分支后的 Command Ledger 详情。所有 V0.4 确认控件使用明确动词；风险提示使用红/橙/绿状态色，主交互保持 Workbench Light 的蓝色。
