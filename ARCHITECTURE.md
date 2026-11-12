# GitGlass V0.3 architecture

## CommandRecord is the audit boundary

`GitCommandService` is the only module that imports `node:child_process` and invokes the user's local `git` executable. It always calls `spawn('git', argv, { shell: false })`. A shell command string is never constructed for execution; `displayCommand` exists only for presentation.

Each attempt becomes an immutable `CommandRecord` before it is returned to any IPC handler:

```text
id, operationId, intent, source, argv, displayCommand, cwd,
startedAt, endedAt, stdout, stderr, exitCode, ok
```

`source` is `user` for an explicit interaction and `background` for refreshes, status, diff, branch, and history reads. Records are retained in reverse chronological order in the in-memory ledger and exposed through the narrow `repo:ledger` IPC endpoint.

`GitCommandService.run()` supports an output-redaction function for the narrow case where a Git command returns a remote URL. Redaction happens before the immutable record is retained or sent over IPC: URL username/password, query parameters, and fragments never enter the Command Ledger.

## Planned versus executed

`GitCommandService.plan()` returns an object with `phase: "planned"` and a newly generated `operationId`; it is intentionally not a `CommandRecord`, has no execution timestamps/output/exit code, and is never inserted into the ledger. Branch switching and remote synchronization first return this plan. The renderer returns that exact `operationId` on explicit confirmation; execution rechecks its safety preconditions, then produces a real CommandRecord carrying the same ID.

## Repository operations

`RepositoryService` owns Git argument construction and data parsing. It uses `--` for file paths and validates repository paths, commit messages, and branch names before building argv. It does not stash, force-switch, reset a worktree, or discard data. If the worktree is dirty, branch switching is blocked with an explanation.

The Electron main process exposes a small context-isolated preload surface. The renderer cannot access Node or child processes. It can request state, diffs, ledger records, commits, branches, remote overview data, and an explicitly confirmed branch or remote action.

## Remote synchronization safety boundary

`RepositoryService.remoteOverview()` reads `git remote`, `git rev-parse --abbrev-ref --symbolic-full-name @{upstream}`, `git remote get-url <remote>`, and `git rev-list --left-right --count @{upstream}...HEAD`. Each is a background CommandRecord. It returns a clear absence reason for a missing remote or upstream instead of fabricating counts.

Remote plans are built only from validated data read from the current repository:

| Operation | Exact argv | Required preconditions |
| --- | --- | --- |
| Fetch | `['fetch', remote]` | at least one configured remote |
| Push | `['push', remote, '<local>:<upstream>']` | upstream exists and Ahead > 0 |
| Pull | `['pull', '--ff-only', remote, upstreamBranch]` | upstream exists, Behind > 0, worktree clean, and `merge-base --is-ancestor HEAD @{upstream}` succeeds |

Before any operation is executed, the repository repeats the overview and safety checks with the planned `operationId`. It never uses `--force`, `--force-with-lease`, a remote deletion refspec, automatic merge/rebase/stash, reset, or a force checkout. A failed `pull --ff-only` remains an ordinary CommandRecord with its original stdout, stderr, and exit code.

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
| `prepareBranch(name, create)` | `{ ok, blocked, reason, plan, state }` | background cleanliness check; generated `plan.operationId` is not a record |
| `executeBranch(name, create, operationId)` | `{ execution, ok, blocked, reason, plan, state }` | rechecks state, then appends a user record with the reviewed plan's operation ID if safe |
| `getRemoteOverview()` | `{ remote, upstream, ahead, behind, reason, suggestion, state }` | background records for remote/upstream URL/count reads |
| `prepareRemote(kind)` | `{ ok, blocked, reason, plan, overview }` | background remote safety reads; plan is not a ledger entry |
| `executeRemote(kind, operationId)` | `{ execution, ok, blocked, reason, plan, overview }` | repeats safety reads, then appends one user record with the planned operation ID |

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

## V0.4 Safety & Recovery boundary

V0.4 retains the same `GitCommandService` execution boundary. New state-changing actions are never run from renderer clicks: the renderer first calls a `prepare*` IPC method, displays the returned non-ledger plan and risk explanation, then sends the unchanged `operationId` to a matching `execute*` method. The service repeats its checks immediately before running the reviewed argv as a `user` CommandRecord.

| Operation | Prechecks | Exact execution argv |
| --- | --- | --- |
| Discard one file | path is present in unstaged state, not staged, and `git ls-files --error-unmatch -- <path>` succeeds | `['restore', '--worktree', '--', path]` |
| Delete merged branch | valid non-current local ref and `git merge-base --is-ancestor <branch> HEAD` succeeds | `['branch', '-d', branch]` |
| Create rescue branch | 40-hex commit, valid rescue ref, verified commit, and target branch absent | `['branch', rescueBranch, fullSha]` |

The recovery reader uses `git reflog -20 --date=iso --pretty=format:%H%x1f%h%x1f%gd%x1f%gs` as a background record. Reflog entries can only be used to create a new branch; V0.4 deliberately exposes no reset, force checkout, history rewrite, `git clean`, `restore --source`, `checkout .`, `reset --hard`, or `branch -D` route. Branch names and commit SHA values are validated before becoming argv entries, and file paths retain Git's `--` separator.
