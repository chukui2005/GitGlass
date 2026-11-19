# GitGlass V0.3 architecture

## V0.5 History & Review Lens

`RepositoryService` 是历史审查的唯一入口：它先验证 40 位 commit SHA 或已跟踪路径，再经 `GitCommandService.run()` 读取 `log`、`show`、`diff`。这些记录均标记为 `source: background`，并保留 argv、cwd、stdout、stderr、exit code。Diff 收集上限为 1 MiB，`outputTruncated` 会传到 UI；服务不会暴露任何历史改写命令。

## CommandRecord is the audit boundary

`GitCommandService` is the only module that imports `node:child_process` and invokes the user's local `git` executable. It always calls `spawn('git', argv, { shell: false })`. A shell command string is never constructed for execution; `displayCommand` exists only for presentation.

Each attempt becomes an immutable `CommandRecord` before it is returned to any IPC handler:

```text
id, operationId, intent, source, argv, displayCommand, cwd,
startedAt, endedAt, stdout, stderr, exitCode, ok
```

`source` is `user` for an explicit interaction and `background` for refreshes, status, diff, branch, and history reads. Records are retained in reverse chronological order in the in-memory ledger and exposed through the narrow `repo:ledger` IPC endpoint.

Every command runs with `GIT_TERMINAL_PROMPT=0` and empty `GIT_ASKPASS` / `SSH_ASKPASS`, so a missing credential fails instead of blocking the main process. Local commands are killed after 60 seconds and remote operations (`fetch`, `push`, `pull`) after 300 seconds; a killed attempt records `timedOut: true` and a Chinese explanation. Captured output is capped at 64 KiB per attempt (diff-style reads may raise it to 1 MiB) and sets `outputTruncated`, so the 300-entry in-memory ledger and the `repo:ledger` response stay bounded.

Credentials never reach the ledger: `redactCredentials()` strips `scheme://user:password@host` user info and `token`/`access_token`/`password`-style query parameters from every stdout and stderr before the record is retained, and `git remote get-url` additionally uses the narrower URL redaction described below.

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
| `queryHistory(filters)` | `{ ok, commits, filters, reason, record }` | fixed `background` branch/file validation and history query records |
| `prepareBranch(name, create)` | `{ ok, blocked, reason, plan, state }` | background cleanliness check; generated `plan.operationId` is not a record |
| `executeBranch(name, create, operationId)` | `{ execution, ok, blocked, reason, plan, state }` | rechecks state, then appends a user record with the reviewed plan's operation ID if safe |
| `getRemoteOverview()` | `{ remote, upstream, ahead, behind, reason, suggestion, state }` | background records for remote/upstream URL/count reads |
| `prepareRemote(kind)` | `{ ok, blocked, reason, plan, overview }` | background remote safety reads; plan is not a ledger entry |
| `executeRemote(kind, operationId)` | `{ execution, ok, blocked, reason, plan, overview }` | repeats safety reads, then appends one user record with the planned operation ID |
| `openRepository(path)` | `{ ok, path, state, execution }` or `{ ok: false, message }` | one `background` `rev-parse --show-toplevel` record |
| `getRecentRepositories()` | `[{ path, name, exists }]` newest first, at most five | read-only, no record |
| `forgetRecentRepository(path)` | same list after removal | read-only, no record |
| `onRepositoryChanged(listener)` | subscription; callback receives `{ reason: 'head' \| 'refs' \| 'index' }` | none (watcher never writes the repository) |

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

## Renderer structure (0.6.5)

`src/main.jsx` is the App shell only: workspace state (files, diff, commit message, ledger, notices), the refresh pipeline, repository switching, and the JSX that places the three panes. The domain logic lives in hooks, and the presentational pieces live in one components module:

| File | Owns |
| --- | --- |
| `src/main.jsx` | App shell + JSX, refresh/ledger pipeline, repository open/switch, notice banner, global shortcuts, command palette wiring |
| `src/use-history-review.js` | history mode, filters (draft/applied), query sequence, commit selection + detail cache, compare pair, file history, Esc semantics |
| `src/use-safety-plans.js` | discard / delete-merged-branch / reflog rescue / branch switch plans and the recovery panel |
| `src/use-remote-overview.js` | remote overview and the fetch/push/pull plans (the plan needs the overview, so both live here) |
| `src/use-panel-resize.js` | panel widths: persistence, clamping, drag, keyboard |
| `src/workbench-ui.jsx` | every presentational component (diff rows, file sections, batch toolbar, ledger, plan/inspector panels, history rows/filters, command palette, command ledger) |

Hooks receive the IPC bridge as a `gitglass` argument instead of reading `window`, so they can be unit tested with a plain object. The JSX, class names, `aria-*` attributes and Chinese copy are unchanged from the single-file version — the rendered tests in `tests/ui/*.test.mjs` assert them.

### Command ledger rendering

The ledger keeps up to 300 records in memory and re-reads all of them through `getLedger()` on every refresh, but only one or two of them are new. Three cheap mechanisms keep that from turning into a full re-render:

1. `reuseUnchangedRecords(previous, next)` in `src/workbench-ledger.js` keeps the previous object identity for a record whose fields did not change, so a refresh only replaces the objects that actually changed.
2. `CommandLedger`, `LedgerEntry`, `RefreshGroup` and `Output` are `memo`ized, and the ledger callbacks in `main.jsx` are `useCallback`s, so unrelated App state (notices, command palette, panel resize) no longer walks the record list.
3. A record's details panel (`ledger-details`, stdout/stderr, technical details) is only mounted while that record is expanded.

`tests/ui/ledger-rendering.test.mjs` pins both properties: expanding one record mounts exactly one details block, and an unrelated App re-render reads zero record fields (measured through a `Proxy`; the same probe read 3600 fields for 120 records before the change). No virtual list: with 300 two-line rows the DOM is not the bottleneck, and windowing would cost keyboard reachability and scroll-position fidelity.

## V0.5.6 history query boundary

`history:query(filters)` accepts only `{ keyword, author, branch, filePath }`; unknown keys, non-strings, NUL/control characters and overlong text are rejected in the main process and recorded as a background local validation rejection. `branch` is rechecked against `git branch --format=…`; `filePath` must be a repository-relative safe path and pass `git ls-files --error-unmatch -- <path>`. Only then does `RepositoryService` construct fixed-structure `git log -200 --date=iso-strict --regexp-ignore-case …`; keyword-only queries add `--fixed-strings`, while queries containing an author use Git's regex matcher with both author and keyword safely escaped as literals. It never accepts renderer-supplied argv or a command string, never uses `--all`, and never exposes remote branch or rewrite operations.

## V0.4 Safety & Recovery boundary

V0.4 retains the same `GitCommandService` execution boundary. New state-changing actions are never run from renderer clicks: the renderer first calls a `prepare*` IPC method, displays the returned non-ledger plan and risk explanation, then sends the unchanged `operationId` to a matching `execute*` method. The service repeats its checks immediately before running the reviewed argv as a `user` CommandRecord.

| Operation | Prechecks | Exact execution argv |
| --- | --- | --- |
| Discard one file | path is present in unstaged state, not staged, and `git ls-files --error-unmatch -- <path>` succeeds | `['restore', '--worktree', '--', path]` |
| Delete merged branch | valid non-current local ref and `git merge-base --is-ancestor <branch> HEAD` succeeds | `['branch', '-d', branch]` |
| Create rescue branch | 40-hex commit, valid rescue ref, verified commit, and target branch absent | `['branch', rescueBranch, fullSha]` |

The recovery reader uses `git reflog -20 --date=iso --pretty=format:%H%x1f%h%x1f%gd%x1f%gs` as a background record. Reflog entries can only be used to create a new branch; V0.4 deliberately exposes no reset, force checkout, history rewrite, `git clean`, `restore --source`, `checkout .`, `reset --hard`, or `branch -D` route. Branch names and commit SHA values are validated before becoming argv entries, and file paths retain Git's `--` separator.


## Startup and workspace state

`RecentRepositories` (`electron/recent-repositories.cjs`) keeps the last five opened repository roots in `userData/recent-repos.json`; only local paths are stored. Startup order is: `GITGLASS_REPOSITORY`, then an update restart draft, then the most recent path that still exists on disk. A missing, oversized or damaged list is ignored rather than blocking launch. `chooseRepository` records the resolved worktree root, not the folder the user picked.

## 0.6.3 additions

### Recent repositories switcher

`electron/repository-opener.cjs` holds the single "resolve a folder to a worktree root" routine: `path.resolve` → `git rev-parse --show-toplevel` → set the current repository and remember the resolved root. Both the folder dialog (`repo:choose`) and the top-bar switcher (`repo:open`) go through it, so the renderer-supplied string is never trusted as a repository root, and there is exactly one `rev-parse` record shape.

`repo:recent` and `repo:recent:forget` are registered outside the operation gate: the list must be readable before any repository is open and while a long network operation is running. `forget` rejects non-strings, NUL characters and oversized paths with a Chinese error. `describeRecent()` recomputes `exists` on every call (never cached), so a repository deleted outside GitGlass is shown as missing instead of being opened. Selecting a missing entry reports the reason and removes it.

### Automatic refresh

`electron/repository-watcher.cjs` watches the resolved git directory, `refs`, `refs/heads` and `logs` with `fs.watch({ persistent: false })`. Filenames are classified into three reasons: `head` (HEAD/ORIG_HEAD/MERGE_HEAD/rebase-merge/…, plus `logs/HEAD`), `refs` (everything inside `refs/` or `refs/heads/`, `packed-refs`, the `refs`/`logs` directory entries) and `index`. The classification is directory-aware because `fs.watch` reports bare names: a branch created as `refs/heads/feature` arrives as `feature`, and the `logs` directory entry only means "some reflog changed" (usually a ref), so it is reported as `refs` instead of pretending to be `head`. Per-ref reflogs below `logs/` are ignored: the matching `refs/*` event already reports the same change, so they would only double the refresh.

Events are coalesced with a leading edge plus a trailing debounce: the first event of a quiet period is reported immediately, further events are merged (highest-priority reason wins, `head` > `refs` > `index`) and reported once the burst has been quiet for 800 ms, and a burst that never pauses is still reported every 2 s. That keeps a 200-ref fetch or a batch of branches to a handful of notifications instead of one per file: measured on Windows, 200 refs written by one `git update-ref --stdin` produce ~1200 filesystem events but two notifications, while `git commit`/`git checkout -b` report a leading `index`/`refs` within ~50 ms and a merged `head` ~800 ms later. `notifyIgnored(1500)` opens a silent window around the six channels that write the repository, so GitGlass never reports its own writes as an external change; reads open a shorter index-only window instead, because `repo:state` runs `git status`, which may rewrite `.git/index` while an external HEAD/ref change still has to be reported. The watcher follows every `openRepository()` success and is closed on repository switch, window close and quit.

The renderer subscribes once and reads the latest `refreshAll` from a ref, then performs a silent refresh (no notice, no ledger open) on `repo:changed` and on window focus. A one-second quiet window after each refresh suppresses self-triggered loops; `head` and `refs` events bypass it because only `git status`-style reads rewrite `.git/index`, while HEAD/refs writes always come from outside the app (our own writes are already silenced in the main process).

### Notice lifecycle

`src/notice-lifecycle.js` owns the banner rules, `src/main.jsx` only wires them up: transient success/error notices auto-dismiss after `AUTO_DISMISS_MS` (6 s), the timer restarts when the text changes, hover and focus pause it, `×` closes immediately and a pin toggle disables auto-dismiss. The `state.operation` banner (merge/rebase in progress) is repository state, so it never times out and has no dismiss button. When the banner disappears the `has-banner` class is removed with it, which returns `.app-shell` to its three-row grid.

### Remote entry semantics

The top-bar entry reads `获取…` and its plan panel starts with 「这一步不会执行任何命令。」; the only execution point is the confirm button in the plan. The ellipsis is intentional and documented in `docs/design.md`.

`RepositoryService.state()` also reports `operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null`, derived from the marker files (`MERGE_HEAD`, `rebase-merge`, `rebase-apply`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`) inside the resolved git directory, so the renderer can explain an in-progress operation instead of blaming uncommitted changes. `refreshAll` compares its refresh sequence before and after each await and drops a snapshot that a newer refresh has superseded.