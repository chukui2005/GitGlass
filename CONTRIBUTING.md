# GitGlass Git 上传规范

本规范适用于所有参与 GitGlass 的人和 AI 代理。目标很简单：**每一笔上传都可审查、可回退、可复现，绝不把无关文件或未验收功能带进远程仓库。**

## 分支规则

- `main` 是稳定分支；只允许通过已验收的提交进入。
- 不直接在 `main` 开发，也不直接推送到 `main`。**所有普通改动必须通过 Pull Request（PR）进入 `main`**。一个需求或修复使用一个分支，例如：

  ```text
  feat/command-ledger-filter
  fix/branch-operation-id
  docs/upload-rules
  test/real-repository-flow
  ```

- 开始前同步远程：

  ```powershell
  git switch main
  git pull --ff-only origin main
  git switch -c feat/<short-description>
  ```

- 未经项目负责人确认，禁止重写 `main` 历史：

  ```text
  禁止 git push --force origin main
  禁止 git reset --hard main
  禁止 git commit --amend 已推送到 main 的提交
  ```

## PR、审批与自动合并

- 合并 PR 前必须同时满足 GitHub CI 的 `GitGlass CI / Quality (test and build)` 检查通过，以及至少一位维护者人工审批。
- 同一个必需检查还会在 Windows 实际执行 `npm run dist:win` 和 `npm run verify:release`，确保安装包与更新元数据可用于发布。
- 作者或维护者可在 PR 页面**主动**开启 GitHub 原生 Auto-merge；它不会由机器人绕过审查、状态检查或分支保护。
- 启用 Auto-merge 后，GitHub 只会在审批和必需 CI 均满足时自动合并。未开启时仍需人工合并。
- 分支保护和 Auto-merge 是仓库管理员在 GitHub 网页完成的一次性设置，具体步骤见 [docs/ci-cd.md](docs/ci-cd.md)。

## 提交边界

- 一笔提交只解决一个可描述的问题；不得把 UI、架构重构、格式化和无关修复混在一起。
- 先检查改动，再逐个暂存文件。**禁止使用 `git add .` 或 `git add -A` 作为上传前的默认操作。**
- 必须使用：

  ```powershell
  git status --short
  git diff
  git add <明确的文件路径>
  git diff --cached
  ```

- 提交信息采用 Conventional Commits：

  ```text
  feat: add branch switch confirmation
  fix: correlate planned and executed commands
  test: cover dirty worktree branch blocking
  docs: add upload rules
  chore: pin development dependencies
  ```

- 继续使用上述 Conventional Commits，`npm run release` 会据此生成 `CHANGELOG.md` 段落；普通功能或修复 PR **不要手动修改版本号或 CHANGELOG**。

- 不提交密钥、令牌、个人配置、真实仓库路径、用户日志或屏幕录制中的敏感内容。

## 不允许上传的内容

以下内容必须保持在 `.gitignore` 中，或在暂存前明确排除：

- `node_modules/`、`dist/`、临时缓存和编辑器目录
- `output/` 中的临时截图、录屏和本地 QA 产物；只有负责人明确要求的发布素材例外
- `demo-repo/`；它是本地 Git 嵌套仓库，不能作为子模块或 gitlink 提交
- `.env`、访问令牌、私钥、Git 凭据、生产数据、真实用户路径

发现疑似敏感文件时：不要上传，先通知项目负责人。

## 上传前必经检查

每次提交和推送前，执行并确认：

```powershell
npm test
npm run lint
npm run typecheck
npm run test:coverage
npm run build
git status --short
git diff --cached --check
git diff --cached
```

四个质量门槛的命令、配置与当前阈值见 [docs/conventions.md](docs/conventions.md#5-提交前必须通过-lint--typecheck--coverage)。

提交后、推送前再确认：

```powershell
git log --oneline -3
git status --short
git push -u origin <当前分支>
```

若 `git status --short` 出现不属于本任务的文件，停止上传。不要代替其他人提交，也不要用 `git stash`、`reset`、`checkout --` 清理他人的工作区。

## 发版协作

- 普通 PR 合并到 `main` **不会**发布任何东西；发版是维护者的显式动作。
- 版本号由维护者手写，且 `main` 只接受 PR：在 `chore/release-<版本>` 分支上执行 `npm run release -- 0.6.2 --no-tag`（Beta 用 `--beta`），脚本会更新 `package.json`/`package-lock.json`、写入 `CHANGELOG.md` 段落并提交 `chore(release): 0.6.2`。
- 合并该 PR（Rebase and merge）后，把 tag 打在 `origin/main` 上：`git fetch origin main && git tag -a v0.6.2 -m "GitGlass v0.6.2" origin/main && git push origin v0.6.2`。CI 会在该 `v*` tag 上构建 Windows 安装包并创建 GitHub Release。
- 本地仍可用以下命令验证 Windows 安装包；它保留 `--publish never`，不会上传任何内容：

  ```powershell
  npm ci
  npm run dist:win
  npm run verify:release
  ```

  预期在忽略的 `release/` 目录得到 EXE、ZIP 和 `SHA256SUMS.txt`。

- Electron 使用延迟下载。`npm test` 和 `npm run pack:win` 的前置脚本会先执行 `install-electron`；仅执行 `npm ci` 不保证 Electron 二进制已经下载。

- 发版完整流程、所需管理员配置及故障排查见 [docs/releasing.md](docs/releasing.md)。

## AI 代理额外规则

- AI 只能暂存和提交本次明确要求的文件；不得因为“顺手”提交其他未提交改动。
- 在执行 `git push` 前，AI 必须报告：目标远程、目标分支、将推送的提交列表、以及工作区剩余改动。
- 没有明确远程地址或用户授权时，AI 不得创建远程仓库、推送、强推、删除分支或修改仓库可见性。
- 合并到 `main` 前，必须由项目负责人或指定审查者验收功能、测试和 UI。

## 推荐交付流程

```text
需求确认 → 新建分支 → 实现 → npm test / npm run build
→ 审查 git diff --cached → 小而清晰的提交 → 客户验收
→ 合并或推送 main
```

如果规则与项目负责人的当次明确指令冲突，以当次明确指令为准。
