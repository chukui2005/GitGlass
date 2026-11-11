# GitGlass V0.2 architecture

## CommandRecord is the audit boundary

`GitCommandService` is the only module that imports `node:child_process` and invokes the user's local `git` executable. It always calls `spawn('git', argv, { shell: false })`. A shell command string is never constructed for execution; `displayCommand` exists only for presentation.

Each attempt becomes an immutable `CommandRecord` before it is returned to any IPC handler:

```text
id, operationId, intent, source, argv, displayCommand, cwd,
startedAt, endedAt, stdout, stderr, exitCode, ok
```

`source` is `user` for an explicit interaction and `background` for refreshes, status, diff, branch, and history reads. Records are retained in reverse chronological order in the in-memory ledger and exposed through the narrow `repo:ledger` IPC endpoint.

## Planned versus executed

`GitCommandService.plan()` returns an object with `phase: "planned"`; it is intentionally not a `CommandRecord`, has no execution timestamps/output/exit code, and is never inserted into the ledger. Branch switching first returns this plan. Only an explicit confirmation calls `executeSwitch`, which first rechecks that the worktree is clean, then produces a real CommandRecord.

## Repository operations

`RepositoryService` owns Git argument construction and data parsing. It uses `--` for file paths and validates repository paths, commit messages, and branch names before building argv. It does not stash, force-switch, reset a worktree, or discard data. If the worktree is dirty, branch switching is blocked with an explanation.

The Electron main process exposes a small context-isolated preload surface. The renderer cannot access Node or child processes. It can request state, diffs, ledger records, commits, branches, a branch plan, or an explicitly confirmed branch action.

## Renderer API contract

All methods below are exposed as `window.gitglass`; none expose Electron objects or a process handle.

| Method | Response shape | Ledger effect |
| --- | --- | --- |
| `getState()` | `{ ok, path, branch, files, records }` | two `background` records: branch + status |
| `getDiff(file)` | `CommandRecord` | one `background` diff record |
| `operate(action, payload)` | `{ execution: CommandRecord, state, commit }` | user operation plus background refresh records |
| `getLedger()` | `CommandRecord[]` newest first | read-only |
| `getBranches()` | `{ record, branches }` | one `background` branch record |
| `getCommits()` | `{ record, commits }` | one `background` log record |
| `prepareBranch(name, create)` | `{ ok, blocked, reason, plan, state }` | background cleanliness check; `plan.phase === 'planned'` is not a record |
| `executeBranch(name, create, operationId)` | `{ execution, ok, blocked, reason, plan, state }` | rechecks state, then appends a user record only if safe |

`file` is `{ path, area: 'staged' | 'unstaged' }`. `branches` contains `{ name, current, hash }`; `commits` contains `{ hash, parents, subject, author, authoredAt }`. A plan's `argv` is the exact Git argument array (for example `['switch', 'feature/report']`); `displayCommand` includes the executable. The renderer must display a planned branch command as a proposal until `executeBranch` returns an `execution` record; it must never add a plan to the ledger.

## State flow

```text
Renderer intent -> preload IPC -> RepositoryService -> GitCommandService
                                     |                    |
                                     v                    v
                                parsed state        CommandRecord -> ledger
                                     |                    |
                                     +------ IPC response-+
```

Failures are data, not exceptions hidden from the UI: stderr, exitCode, stdout and cwd stay in their CommandRecord for copy and inspection.
