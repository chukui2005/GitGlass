# GitGlass V0.2 QA Report

**Result: PASS**  
**Scope:** Command Ledger + Branch Workspace  
**QA method:** independent source audit, Vitest/build verification, real local Git repository integration, and Electron renderer inspection.

## Automated checks

```text
npm test
Test Files  3 passed (3)
Tests       7 passed (7)

npm run build
vite v8.3.7 building client environment for production...
✓ built in 1.50s
```

The test suite contains real files for command execution, status parsing, and repository/branch behavior:

- `tests/git-command-service.test.cjs`
- `tests/git-parsers.test.cjs`
- `tests/repository-service.test.cjs`

## Real-repository verification

Performed against temporary local Git repositories through `GitCommandService` and `RepositoryService`, then independently through Electron's rendered UI.

| Scenario | Result | Evidence |
| --- | --- | --- |
| Modify file, read diff, stage, commit | Pass | `git diff`, `git add -- note.txt`, and `git commit -m ...` returned real command records. |
| Create branch from clean worktree | Pass | Plan showed `git switch -c qa/branch`; confirmed execution used `['git', 'switch', '-c', 'qa/branch']`. |
| Switch branch from clean worktree | Pass | Electron UI displayed the planned command and required a second confirm action before `git switch master`. |
| Block switch in dirty worktree | Pass | Electron displayed the blocking explanation and did not offer a force/stash workaround. |
| Failed commit retains raw error | Pass | Empty local identity caused exit code `128`; the renderer showed `Author identity unknown` and the original stderr in Command Ledger. |
| Background reads appear in Ledger | Pass | Electron Ledger listed `git branch --show-current`, `git status --porcelain=v1 -z`, `git branch --format=...`, and `git log -30 ...` as background entries. |
| Ledger details/copy data | Pass | Expanded entry shows cwd, raw `argv`, command, stdout, stderr, exit code, and copy affordances. |

The final QA repository was returned to a clean `master` worktree.

## Safety audit

Static scan command:

```powershell
rg -n "shell\s*:\s*true|\beval\s*\(|execSync|child_process|spawn\(" . -g '!node_modules' -g '!dist' -g '!output'
```

Result: the only `child_process`/`spawn` import is `electron/git-command-service.cjs`; it invokes `spawn('git', argv, { shell: false, windowsHide: true })`. No `shell:true`, `eval`, string-executed command, automatic stash, force-switch, push, pull, merge, or rebase implementation was found. Package dependency ranges are fixed; no root `latest` dependency remains.

## Visual and accessibility review

- Professional, restrained desktop-tool hierarchy; no gradients, glow, glass treatment, or pill-card layout.
- Chinese primary UI text is consistent; Git commands, paths, and hashes use monospace styling.
- Checked empty state, disabled Commit state, hover styling, error styling, loading spinner, and branch-confirmation context.
- `button`, `textarea`, and branch-name `input` all have visible keyboard focus outlines.
- At 1024px, Command Ledger remains present. Its stdout and stderr outputs stack vertically rather than hiding stderr.

## Captured evidence

- `output/design/gitglass-1440.png`
- `output/design/gitglass-1280.png`
- `output/design/gitglass-1024.png`
- `output/qa/live-ledger-argv.png` — live Electron Ledger with an expanded raw argv field

No GIF was generated or evaluated: the user explicitly removed that delivery requirement.

## Reproduction commands

```powershell
npm test
npm run build
npm run dev
```

Then open a local Git repository, modify a file, stage it, submit it, create a branch from a clean worktree, and attempt a switch with an uncommitted file. Inspect the Command Ledger after each action.
