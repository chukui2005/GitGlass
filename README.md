# GitGlass — Commit Workbench MVP

GitGlass is a desktop Git UI that keeps the *real Git command*, its execution context, and its original output visible beside the workflow.

## Run

```powershell
npm install
npm run dev
```

Choose a local repository with **打开仓库**. GitGlass invokes the user's installed `git` executable directly; it does not use a Git library or manufacture equivalent command text.

## Included workflow

- Unstaged / staged file groups with add, modify, delete, and rename indicators
- Per-file diff preview, coloured for added and removed lines
- Per-file stage/unstage, plus Stage All and Unstage All
- Commit message validation and a disabled Commit state when nothing is staged
- State refresh and short commit hash after a successful commit
- Persistent Command Lens: planned command, exact command run, cwd, timestamps, stdout, stderr, exit code, and result

## Security / execution model

The Electron renderer is sandboxed with context isolation. It has a small, fixed preload API; only the main process can invoke Git. Git is executed with `spawn('git', args, { shell: false })`, so a filename or commit message is passed as an argument rather than interpolated into a shell command. Commit messages are limited to 4096 characters and all file operations use Git's `--` path separator.

## Local demo repository

`demo-repo/` is an optional, local-only smoke-test fixture. It is intentionally ignored by this repository because it contains its own Git history; clone GitGlass and select any local Git repository to test the application.
