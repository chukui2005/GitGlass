# GitGlass V0.2 发布验收报告

**结论：通过**
**验收范围：** Command Ledger、Branch Workspace 及 V0.2 发布阻断项。

## 构建与测试输出

```text
npm test
Test Files  4 passed (4)
Tests       8 passed (8)

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

## 人工 UI 验收

已在 Electron 渲染器中检查以下场景：

- 文件选择按钮与暂存/取消暂存图标按钮相邻且独立；图标按钮具备可读 `aria-label`。
- 分支切换先显示“计划执行（尚未运行）”，确认后执行；脏工作区显示阻断原因且不提供 stash、force 或丢弃入口。
- Command Ledger 显示用户与后台记录，展开项包括 cwd、原始 argv、完整命令、stdout、stderr、退出代码和复制控件。
- 异步通知使用 `aria-live="polite"`；存在 h1、skip link、深色 `color-scheme`、输入项的 name/autocomplete 和键盘焦点态。
- 1024px 宽度下 stdout 与 stderr 均保留，以纵向方式显示。

截图：

- `output/design/gitglass-1440.png`
- `output/design/gitglass-1280.png`
- `output/design/gitglass-1024.png`
- `output/qa/live-ledger-argv.png`

## 安全审计

执行：

```powershell
rg -n "shell\s*:\s*true|\beval\s*\(|execSync|child_process|spawn\(" . -g '!node_modules' -g '!dist' -g '!output'
```

应用运行时代码中，唯一的 `child_process.spawn` 位于 `electron/git-command-service.cjs`，并固定采用 `spawn('git', argv, { shell: false, windowsHide: true })`。未发现 `shell:true`、`eval`、字符串命令执行、自动 stash、强制切换、push、pull、merge 或 rebase。
