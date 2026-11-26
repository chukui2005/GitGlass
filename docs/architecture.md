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

`source` is `user` for an explicit interaction and `background` for refreshes, status, diff, branch, and history reads. Records are retained in reverse chronological order in the in-memory ledger and exposed through the narrow `repo:ledger` IPC endpoint. A patch operation adds two optional audit fields (`target`, `hunk`) because its argv cannot name either; see [Diff hunk boundary](#diff-hunk-boundary-069).

Every command runs with `GIT_TERMINAL_PROMPT=0` and empty `GIT_ASKPASS` / `SSH_ASKPASS`, so a missing credential fails instead of blocking the main process. Local commands are killed after 60 seconds and remote operations (`fetch`, `push`, `pull`) after 300 seconds; a killed attempt records `timedOut: true` and a Chinese explanation. Captured output is capped at 64 KiB per attempt (diff-style reads may raise it to 1 MiB) and sets `outputTruncated`, so the 300-entry in-memory ledger and the `repo:ledger` response stay bounded.

Credentials never reach the ledger: `redactCredentials()` strips `scheme://user:password@host` user info and `token`/`access_token`/`password`-style query parameters from every stdout and stderr before the record is retained, and `git remote get-url` additionally uses the narrower URL redaction described below.

`GitCommandService.run()` supports an output-redaction function for the narrow case where a Git command returns a remote URL. Redaction happens before the immutable record is retained or sent over IPC: URL username/password, query parameters, and fragments never enter the Command Ledger. `runCapturingOutput()` performs the same execution and returns the same redacted record, plus the raw stdout captured before redaction; only patch construction uses it, and the raw text is never retained or sent to the renderer (see [Diff hunk boundary](#diff-hunk-boundary-069)).

## Planned versus executed

`GitCommandService.plan()` returns an object with `phase: "planned"` and a newly generated `operationId`; it is intentionally not a `CommandRecord`, has no execution timestamps/output/exit code, and is never inserted into the ledger. Branch switching and remote synchronization first return this plan. The renderer returns that exact `operationId` on explicit confirmation; execution rechecks its safety preconditions, then produces a real CommandRecord carrying the same ID.

## Repository operations

`RepositoryService` owns Git argument construction and data parsing. It uses `--` for file paths and validates repository paths, commit messages, and branch names before building argv. It does not stash, force-switch, reset a worktree, or discard data. If the worktree is dirty, branch switching is blocked with an explanation.

The Electron main process exposes a small context-isolated preload surface. The renderer cannot access Node or child processes. It can request state, diffs, ledger records, commits, branches, remote overview data, and an explicitly confirmed branch or remote action.

## Diff hunk boundary (0.6.9)

Staging and unstaging a single hunk are the first operations whose *input* is a patch instead of a path. The renderer never builds or supplies that patch, and it never names a file outside a diff the main process itself produced:

- `electron/patch-hunks.cjs` owns the fixed patch parameters (`--no-color --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/ -U3 --inter-hunk-context=0`) and the snapshot, parse and single-hunk patch helpers. `git diff -- path` (index → worktree) and `git diff --cached -- path` (HEAD → index) are the only two reads; the display read and the operation read use the same helper, so local colour, external-diff, textconv, prefix, context or inter-hunk configuration cannot change what "one hunk" means.
- Two fidelity rules keep the index equal to the selected bytes, because both the read and the apply step could silently rewrite them:
  - **Redaction never reaches the patch.** Credential redaction still applies to every CommandRecord and to everything sent over IPC, so the diff the user reads never shows a token. Patch construction instead uses `GitCommandService.runCapturingOutput()`, which returns the same redacted record plus the raw stdout captured before redaction. The snapshot id and the hunk content hashes are computed from that raw text on both sides, so a line that merely looks like a credential URL neither breaks the snapshot comparison nor lands in the index as `<redacted>`.
  - **Apply flags are pinned.** `git apply --cached --whitespace=nowarn --no-ignore-whitespace -` (with `-R` for unstaging) overrides `apply.whitespace` and `apply.ignoreWhitespace`: `fix` would strip trailing whitespace from the staged line and `ignoreWhitespace` would loosen context matching. Git's own line-ending normalisation (`core.autocrlf`) still applies, exactly as it does for `git add`.
- `RepositoryService.diff()` returns the CommandRecord plus `{ area, path, snapshot, hunkSupport }`. `snapshot` is a SHA-256 over repository path, area, file path and the exact diff bytes; `hunkSupport.hunks` carries `{ index, range, oldStart, oldLines, newStart, newLines, contentHash }` per hunk, and `hunkSupport.reason` explains in Chinese why hunk operations are unavailable (binary, added/deleted/renamed, mode change combined with text hunks, unmerged, truncated, or output whose bytes were lost to UTF-8 decoding). `range` is only the `@@ -a,b +c,d @@` span: the hunk header's function context stays in the main process, because a custom `diff.<driver>.xfuncname` can make it carry an arbitrary line of the file — including something that looks like a credential. A test builds exactly that case and asserts the token never leaves the main process.
- `applyDiffHunk(direction, locator)` with `locator = { path, snapshot, hunk: { index, contentHash, range? } }` is the only entry. The main process re-reads the same area, recomputes the snapshot, rejects a different diff, re-checks the target file against the current working-tree state (tracked, `modified`, in the matching area), locates the hunk by index and content hash (the optional `range` only re-checks the position), rebuilds a patch containing only the selected hunk, and runs `git apply --cached --whitespace=nowarn --no-ignore-whitespace -` (stage) or the same argv with `-R` (unstage). Git owns the index lock and the applicability decision.
- A diff that carries `old mode`/`new mode` next to text hunks is refused for hunk operations: those header lines are part of the patch, so `git apply` would change the index mode too (and `-R` would revert a staged mode change together with the selected text). Whole-file staging keeps working.
- There is deliberately no separate prepare/execute round trip: the argv is fixed, the patch is derived from Git's own output after the check, and nothing the user could review is built renderer-side. Every attempt still produces a user CommandRecord, and a local rejection produces `recordRejection` ("本地校验拒绝，未执行 Git 命令") with the same intent, so the ledger distinguishes `Stage diff hunk` from `Unstage diff hunk` and from whole-file staging.
- The patch text travels over stdin as command input, so it is neither an argv entry nor part of any record. Because `git apply --cached -` does not name the file, the record carries the two audit facts separately: `target` (repository-relative path) and `hunk` (the `@@ -a,b +c,d @@` range). Both fields appear only on patch operations, and the `hunk` annotation still passes through `redactCredentials()` so no annotation can become a way around the credential filter.
- Boundaries kept on purpose: new, deleted, renamed, binary, permission-changing, unmerged and truncated diffs are rejected for hunk operations and keep the existing whole-file flow; so is any diff Node could not decode byte-exactly, because re-encoding it would corrupt the index entry.

## Clone and open boundary (0.6.10)

`repo:clone:*` is the first write flow that can start with **no repository open**, so its validation is earlier and narrower than every other operation:

- The renderer sends only `{ source, parent, name }` (an empty `name` means "derive it") plus the `operationId` of the plan it reviewed. `normalizeCloneRequest()` refuses unknown keys, so argv, a working directory or switches such as `--bare` can never travel from the renderer.
- `classifyCloneSource()` parses the address structurally (`new URL` for anything with a scheme, the scp-like form, absolute local paths) instead of matching text: an SSH username is an ordinary address part and is kept, while an SSH password, any HTTP(S)/git/file user info, and sensitive query parameters — including percent-encoded spellings such as `access%5Ftoken` or `%74oken` — are refused. Absolute local paths stay supported (real-Git tests and local mirrors need them).
- Every address-bearing string is built through `redactCloneSource()`/`redactCloneOutput()`, which replace credential components with the visible placeholder `<redacted>`: the preview `displayCommand`, the record's stdout/stderr (a remote that echoes a URL back reads as `https://<redacted>@host/…`). The edit is textual, so every byte that is not a credential stays exactly as typed — the preview, the argv Git receives and the ledger record therefore describe one and the same address. Because a credential-bearing address never reaches the plan, a rejected request has no plan, no spawned Git and no ledger record at all — the rejection produces no record, so the secret cannot be echoed back.
- A URL fragment is stripped once, before the plan is built, because it is never part of what Git clones and keeping it would make the preview and the argv disagree. A `#` inside an absolute local path is a filename character and is kept; `file://` addresses are accepted as local paths only when their host is empty or `localhost`.
- The execution matrix is `git -c protocol.allow=never -c protocol.<p>.allow=always clone -- <source> <name>`, and the child process additionally receives `GIT_ALLOW_PROTOCOL=<p>`: `<p>` is fixed by the classified address (`https`/`http`/`ssh`/`git`/`file`, a local folder being `file`). Git's default is "any transport it knows", so a `url.<base>.insteadOf` rewrite could otherwise move a validated HTTPS address onto the local file transport (or a future helper). The `-c` flags set the default, while `GIT_ALLOW_PROTOCOL` is a whitelist that overrides `protocol.<name>.allow` from the user's configuration — which matters when that configuration explicitly allows the file transport. Real-Git tests cover both controls (the rewrite really is live without the pin, and the `-c` flags alone are not enough once the config allows `file`), plus absolute local paths still cloning under the same isolated config. `GitCommandService` accepts this as a narrow `env` extension; the three credential-prompt variables stay owned by the service and cannot be overridden through it.
- Cloning runs with `cwd` set to the chosen parent folder (Git itself creates the final folder), the same `NETWORK_TIMEOUT_MS` deadline and the shared `GIT_TERMINAL_PROMPT=0` environment. The ledger keeps the real argv, `cwd`, exit code and stdout/stderr; a plan is presentation only and never a `CommandRecord`.
- `repo:clone:prepare` returns the plan and final directory, `repo:clone:execute` replays it with the same `operationId`. Changing the address, the target position or the folder name drops the reviewed plan, and the renderer additionally guards the read itself: each preview carries a sequence number, a response that arrives after a field edit, after the dialog was closed, or in a new dialog session is discarded, and `confirm` re-checks the reviewed input against the current fields before executing.
- `validateCloneTarget()` requires an existing parent folder and a target directory that is either absent or empty, and returns the exact final directory. `resolveRepositoryName()` refuses separators, `.`/`..`, Windows reserved names and a trailing dot or space; an empty name is derived from the address (`origin.git` → `origin`).
- A failure cleans up nothing itself: Git rolls back what it created, an existing empty folder and any other user files stay exactly as they were. Only a successful clone goes through `openRepositoryPath()` — still `git rev-parse --show-toplevel` for the real root, still the same "remember + watcher" tail — so a failed clone leaves the open repository, commit draft and staged content untouched.
- `describeCloneFailure()` maps timeout, authentication failure, an existing destination, a missing remote and an unreachable host to one Chinese sentence each; the raw stderr stays in the ledger for diagnosis.

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
| `getDiff(file)` | `CommandRecord` plus `{ area, path, snapshot, hunkSupport: { ok, reason, hunks } }` | one `background` diff record |
| `applyDiffHunk(direction, locator)` | `{ ok, direction, area, path, hunk, execution, record, state, reason }` | one background re-read, then a `user` record (or a local rejection) carrying `target` and `hunk` |
| `getStagedOverview()` | `{ ok, files: [{ path, oldPath, status, insertions, deletions, binary, statUnavailable }], totals, reason }` | one `background` `diff --cached --numstat -z` record when the index has staged files |
| `operate(action, payload)` | `{ execution: CommandRecord, state, commit }` | user operation plus background refresh records |
| `getLedger()` | `CommandRecord[]` newest first | read-only |
| `getBranches()` | `{ record, branches }` | one `background` branch record |
| `getCommits()` | `{ record, commits, limit }` | one `background` log record |
| `queryHistory(filters)` | `{ ok, commits, filters, limit, reason, record }` | fixed `background` branch/file validation and history query records |
| `getRefs()` | `{ ok, head, refs, truncated, records, reason }`; each ref carries `fullName`, `shortName`, `kind`, `commit` (and `targetRef` for `origin/HEAD`) | background reads: refs, symbolic HEAD, HEAD commit, remote list, one symbolic read per remote default alias |
| `getCommit(sha)` | `{ ok, commit, record, reason }` | `background` verify + one-line commit summary read by full ID |
| `prepareBranch(name, create)` | `{ ok, blocked, reason, plan, state }` | background cleanliness check; generated `plan.operationId` is not a record |
| `executeBranch(name, create, operationId)` | `{ execution, ok, blocked, reason, plan, state }` | rechecks state, then appends a user record with the reviewed plan's operation ID if safe |
| `getRemoteOverview()` | `{ remote, upstream, ahead, behind, reason, suggestion, state }` | background records for remote/upstream URL/count reads |
| `prepareRemote(kind)` | `{ ok, blocked, reason, plan, overview }` | background remote safety reads; plan is not a ledger entry |
| `executeRemote(kind, operationId)` | `{ execution, ok, blocked, reason, plan, overview }` | repeats safety reads, then appends one user record with the planned operation ID |
| `openRepository(path)` | `{ ok, path, state, execution }` or `{ ok: false, message }` | one `background` `rev-parse --show-toplevel` record |
| `chooseCloneTarget()` | `{ canceled: true }` or `{ canceled: false, path }` | none (a folder picker, no Git command) |
| `prepareClone(request)` | `{ ok, blocked, reason, plan, target, existingEmpty, name, parent, source }` | none; the plan is not a ledger entry |
| `executeClone(request)` | `{ ok, path, state, target, plan, execution }` or `{ ok: false, reason, target, execution }` | one `user` `Clone repository` record, then one `background` `rev-parse --show-toplevel` record on success |
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

## Hunk actions and staged overview in the workbench (0.6.9)

The renderer keeps three pieces of state per diff: the raw text, a loading/empty message, and the locator bundle `getDiff` returned (`{ area, path, snapshot, hunkSupport }`). A hunk action is only rendered when that bundle still matches the selected file *and* its area, so a stale diff can never drive an operation against new staged content. Each diff read carries a sequence number; a result that arrives after the user selected another file is dropped instead of overwriting the view.

- `presentDiff()` keeps the raw (already redacted) `@@ … @@` line on each hunk row as `rawHeader` for display and debugging, but the workbench does not locate blocks by that text: it numbers hunk rows in document order and pairs the Nth row with `hunkSupport.hunks[N]`. Redaction changes text, never the number of lines, so that position is stable — and it works for a header whose context was replaced with `<redacted>`.
- The hunk button sits in the hunk row and is named after its block's range (`暂存此块：@@ -28,7 +28,7 @@` / `取消暂存此块：…`), which is unique per file and carries no file content. It sends only `{ path, snapshot, hunk }` through `applyDiffHunk(direction, locator)`; `src/user-notices.js#hunkOperationNotice()` turns a rejection or a real Git failure into one Chinese notice, and the workspace then refreshes from Git's actual result while keeping the same file selected when it still exists.
- The staged overview is entry `查看暂存总览` inside the existing 创建提交 section — the right panel keeps exactly two sections (当前文件, 创建提交). Expanding it reads `getStagedOverview()`, which lists the real staged files with per-file `+N −M`, `二进制` or `统计不可用`; clicking a row loads that file's staged diff in the centre pane.
- An expanded overview follows the real index: every refresh cycle (whole-file stage/unstage, batch staging, a commit, an external Git change, a repository switch) re-reads it, while a collapsed overview stops following refreshes and reads again only when it is opened. The expanded/collapsed flag lives in the App shell, because only the owner of the refresh pipeline can decide whether a refresh should read the index. Each read carries a request sequence number and the repository it was started for; a response that arrives after a newer request, or after the repository changed, is dropped, and the panel only renders data whose `repoPath` matches the current repository.
- The command ledger's expanded record lists `目标文件` and `块范围` from the record's `target`/`hunk` fields, because a patch operation's argv names neither. That is what keeps an audit line readable: the command says `git apply --cached … -`, the facts say which file and which `@@ -a,b +c,d @@` it touched.

## Renderer structure (0.6.5)

`src/main.jsx` is the App shell only: workspace state (files, diff, commit message, ledger, notices), the refresh pipeline, repository switching, and the JSX that places the three panes. The domain logic lives in hooks, and the presentational pieces live in one components module:

| File | Owns |
| --- | --- |
| `src/main.jsx` | App shell + JSX, refresh/ledger pipeline, repository open/switch, notice banner, global shortcuts, command palette wiring |
| `src/use-history-review.js` | history mode, filters (draft/applied), query sequence, commit selection + detail cache, compare pair, file history, Esc semantics |
| `src/use-safety-plans.js` | discard / delete-merged-branch / reflog rescue / branch switch plans and the recovery panel |
| `src/use-remote-overview.js` | remote overview and the fetch/push/pull plans (the plan needs the overview, so both live here) |
| `src/use-panel-resize.js` | panel widths: persistence, clamping, drag, keyboard |
| `src/workbench-ui.jsx` | every presentational component (diff rows and their hunk actions, file sections, batch toolbar, staged overview, ledger, plan/inspector panels, history rows/filters, command palette, command ledger) |

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

`WindowStateStore` (`electron/window-state.cjs`) keeps the main window's last bounds in `userData/window-state.json` under the same fault-tolerance rules: a missing, oversized or damaged file falls back to defaults instead of blocking launch. `resolveLaunchBounds()` turns that state into launch options — the default size is 80% of the primary work area capped at 1400×940 and never below `minWidth`/`minHeight` (1024×680), so a 1366×768 laptop gets a window that fits. A saved position only survives when the saved rectangle still intersects some display's work area by at least 200×100 px with at least half of a 64px title strip visible; otherwise the window is centered again and the size falls back to the default. Sizes are clamped against the display the window will actually appear on, so a window saved on a now-disconnected large monitor shrinks to the primary work area. `trackWindowBounds()` records `resize`/`move` readings while skipping maximized, minimized and full-screen states (the Windows `-32000` minimized coordinates and maximized bounds must never reach the file) and writes the last normal bounds once on `close`; a failed write never blocks closing.

## 0.6.3 additions

### Recent repositories switcher

`electron/repository-opener.cjs` holds the single "resolve a folder to a worktree root" routine: `path.resolve` → `git rev-parse --show-toplevel` → set the current repository and remember the resolved root. Both the folder dialog (`repo:choose`) and the top-bar switcher (`repo:open`) go through it, so the renderer-supplied string is never trusted as a repository root, and there is exactly one `rev-parse` record shape.

`repo:recent` and `repo:recent:forget` are registered outside the operation gate: the list must be readable before any repository is open and while a long network operation is running. `forget` rejects non-strings, NUL characters and oversized paths with a Chinese error. `describeRecent()` recomputes `exists` on every call (never cached), so a repository deleted outside GitGlass is shown as missing instead of being opened. Selecting a missing entry reports the reason and removes it.

### Automatic refresh

`electron/repository-watcher.cjs` watches the resolved git directory, `refs`, `refs/heads` and `logs` with `fs.watch({ persistent: false })`. Filenames are classified into three reasons: `head` (HEAD/ORIG_HEAD/MERGE_HEAD/rebase-merge/…, plus `logs/HEAD`), `refs` (everything inside `refs/` or `refs/heads/`, `packed-refs`, the `refs`/`logs` directory entries) and `index`. The classification is directory-aware because `fs.watch` reports bare names: a branch created as `refs/heads/feature` arrives as `feature`, and the `logs` directory entry only means "some reflog changed" (usually a ref), so it is reported as `refs` instead of pretending to be `head`. Per-ref reflogs below `logs/` are ignored: the matching `refs/*` event already reports the same change, so they would only double the refresh.

Events are coalesced with a leading edge plus a trailing debounce: the first event of a quiet period is reported immediately, further events are merged (highest-priority reason wins, `head` > `refs` > `index`) and reported once the burst has been quiet for 800 ms, and a burst that never pauses is still reported every 2 s. That keeps a 200-ref fetch or a batch of branches to a handful of notifications instead of one per file: measured on Windows, 200 refs written by one `git update-ref --stdin` produce ~1200 filesystem events but two notifications, while `git commit`/`git checkout -b` report a leading `index`/`refs` within ~50 ms and a merged `head` ~800 ms later. `notifyIgnored(1500)` opens a silent window around the six channels that write the repository, so GitGlass never reports its own writes as an external change; reads open a shorter index-only window instead, because `repo:state` runs `git status`, which may rewrite `.git/index` while an external HEAD/ref change still has to be reported. The watcher follows every `openRepository()` success and is closed on repository switch, window close and quit.

The renderer subscribes once and reads the latest `refreshAll` from a ref, then performs a silent refresh (no notice, no ledger open) on `repo:changed` and on window focus. A one-second quiet window after each refresh suppresses self-triggered loops; `head` and `refs` events bypass it because only `git status`-style reads rewrite `.git/index`, while HEAD/refs writes always come from outside the app (our own writes are already silenced in the main process). Watching can fail silently (network drives, restricted filesystems), so `RepositoryWatcher.watch()` reports `false` when no directory could be watched, dying handles report through an `onError` callback once the last one is gone, and the main process exposes the result as `watcher:state` / `watcher:changed` (`{ active }`). The renderer announces the loss once per failure streak and offers a manual "重新读取本地状态（不联网）" command in the palette only while automatic refresh is unavailable; the remote entry's title spells out that fetching goes online (issue #21).

### Notice lifecycle

`src/notice-lifecycle.js` owns the banner rules, `src/main.jsx` only wires them up: transient success/error notices auto-dismiss after `AUTO_DISMISS_MS` (6 s), the timer restarts when the text changes, hover and focus pause it, `×` closes immediately and a pin toggle disables auto-dismiss. The `state.operation` banner (merge/rebase in progress) is repository state, so it never times out and has no dismiss button. When the banner disappears the `has-banner` class is removed with it, which returns `.app-shell` to its three-row grid.

### Remote entry semantics

The top-bar entry reads `获取…` and its plan panel starts with 「这一步不会执行任何命令。」; the only execution point is the confirm button in the plan. The ellipsis is intentional and documented in `docs/design.md`.

`RepositoryService.state()` also reports `operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null`, derived from the marker files (`MERGE_HEAD`, `rebase-merge`, `rebase-apply`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`) inside the resolved git directory, so the renderer can explain an in-progress operation instead of blaming uncommitted changes. `refreshAll` compares its refresh sequence before and after each await and drops a snapshot that a newer refresh has superseded.

## Refs and bounded history graph boundary (0.6.10 PR 3)

This round is read-only: it creates, deletes and pushes no refs, edits no remote, checks out no tracking branch, and sets no upstream. Refs are navigation, not an action surface.

`getRefs()` runs one fixed `git for-each-ref` over `refs/heads`, `refs/remotes` and `refs/tags` with a tab-delimited format, plus `git symbolic-ref -q HEAD`, `git rev-parse --verify --quiet HEAD^{commit}` and `git remote`. The parser (`electron/git-refs.cjs`) keeps the full ref name and full commit id for every row; the renderer may shorten them only for display. A local branch and a tag may share `release`: they remain two rows because `refs/heads/release` and `refs/tags/release` are different identifiers. An annotated tag uses `%(*objectname)` (the peeled commit), a lightweight tag uses `%(objectname)`, and a tag pointing at a tree/blob is retained with a Chinese `status` instead of becoming a clickable commit.

`for-each-ref` omits a symbolic `refs/remotes/<remote>/HEAD` once its target branch has been deleted, so `getRefs()` asks Git for every configured remote's default alias explicitly. A valid alias is kind `alias`, keeps its `targetRef`, and resolves to the target branch's commit. If the target is absent from the ref rows—most importantly when a large `for-each-ref` result was truncated before `refs/remotes`—Git resolves the exact target with `rev-parse --verify --quiet <target>^{commit}`. Only a failed resolution marks the alias as dangling; a truncated-list miss does not. A dangling alias stays visible, keeps `targetRef`/`targetShortName`, drops the stale object id, and carries the status `目标分支不存在`; it is never a clickable commit. The 900-local-branch regression verifies that `仅显示部分引用` and a working `origin/HEAD` jump can coexist.

The 64 KiB CommandRecord limit applies to refs too. When the `for-each-ref` record reports `outputTruncated`, the parser drops the trailing incomplete line (it could otherwise become a fabricated unresolved tag), returns only complete records, and sets `truncated: true`. The refs panel says `仅显示部分引用`; the real-Git regression uses 900 tags to cross the limit.

When a ref targets a commit outside the current `getCommits()` page, `getCommit(fullSha)` verifies the 40-hex id and reads one structured summary by that id. The renderer shows a placeholder, then the selected commit and its existing `getCommitDetail()`/`getCommitDiff()` path; the ref read, the summary read and the detail read are all `background` CommandRecords. `getRefs()` is also re-read by `refreshAll()`, which reacts to the repository watcher's `head`/`refs` events.

Three independent tokens own the asynchronous view: `refsSequence` drops a refs response after a repository switch or a newer refs refresh; `selectionSequence` owns commit detail and loading state; `viewSequence` owns Diff, comparison and file-history reads. A newer row/ref selection advances all relevant tokens, so a late detail or Diff response can still refresh the ledger but cannot overwrite the new selection. Returning to a cached list commit while an out-of-page ref read is pending ends that read's loading state immediately; rows remain selectable once a selection exists, rather than being disabled by the very read they should cancel.

`src/history-graph.js` is a pure lane layout over the real `parents` array from `git log`/`git show`. History reads use `--topo-order`, so a child is always read before its parents even when commit dates are skewed; the real-Git regression creates a merge whose second parent is dated years after the merge and verifies every solid edge lands on the lane that later row actually occupies. The layout keeps lane columns stable, draws every parent edge of a merge, and marks a parent absent from the current read window as a `boundary` edge instead of silently dropping it. `outputTruncated`, the 80/200 page limit, keyword/author/branch filters and a missing parent all surface as a boundary badge and a graph note. A file filter (`git log -- <path>`) may invoke Git's history simplification, so that view deliberately keeps the list and states that the graph is unavailable until the file condition is cleared. The seven-lane cap is explicit: a parent edge that cannot get a truthful lane is marked `omitted`, is not drawn as a solid line, and appears as `省略 N` on the row and `已省略 N 条连接` in the graph note. Refs and commit rows are native buttons; Up/Down/Home/End move focus between them, and the graph itself is an aria-hidden visual inside the row button.