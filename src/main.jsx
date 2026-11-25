import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  ArrowsLeftRight,
  CheckCircle,
  Copy,
  File,
  FolderOpen,
  GitBranch,
  GitCommit,
  MagnifyingGlass,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import {
  countBySource,
  filterLedgerRecords,
  groupBackgroundRecords,
  ledgerGlanceRecord,
  reuseUnchangedRecords,
} from "./workbench-ledger.js";
import {
  binaryDiffPattern,
  changeKindLetter,
  changeOf,
  fullLocalTime,
  relativeTime,
} from "./history-search.js";
import { basename, fileLabel, stageSelectionKey } from "./file-labels.js";
import { displayGitCommand } from "./command-display.js";
import { BrandMark } from "./brand-mark.jsx";
import { RecentRepositoriesMenu } from "./recent-repositories-menu.jsx";
import { GENERIC_GIT_FAILURE, hunkOperationNotice, operationFinishedNotice, operationInProgressNotice, operationNotice } from "./user-notices.js";
import { AUTO_DISMISS_MS, createNoticeTimer, syncNoticeTimer } from "./notice-lifecycle.js";
import { canStartRepositoryContextOperation, resolveRepositoryRefresh } from "./repository-refresh.js";
import { shouldRefreshOnChange } from "./auto-refresh.js";
import { isBlockingContextOpen, resolveShortcut, shortcutLabel } from "./shortcut-policy.js";
import { commandAvailability } from "./command-palette-model.js";
import "./styles.css";
import { useAppUpdates, UpdateButton, UpdateDialog } from "./app-updates.jsx";
import { useHistoryReview } from "./use-history-review.js";
import { branchName, useSafetyPlans } from "./use-safety-plans.js";
import { useRemoteOverview } from "./use-remote-overview.js";
import { usePanelResize } from "./use-panel-resize.js";
import {
  BatchStageToolbar,
  BranchContext,
  CommitInspector,
  CommitRow,
  CommandLedger,
  CommandPalette,
  CopyButton,
  DiffContent,
  FileInspector,
  FileSection,
  HistoryFilters,
  HistoryResult,
  HistorySearch,
  NoRepositoryGuide,
  PanelSplitter,
  PathBreadcrumb,
  RecoveryContext,
  RemotePlanContext,
  SafetyContext,
  SidebarRemote,
  WorkspaceEmptyState,
  isDarwin,
  titleFor,
} from "./workbench-ui.jsx";

// 命令面板条目：纯函数，输入是这次渲染的可用性与动作，输出 CommandPalette 要的数组。
// 刻意不做 useMemo：每个 run 都闭包住最新的动作，依赖每帧都会变，
// memo 只会白算一次，还会让 exhaustive-deps 需要一份永远不完整的依赖表。
function buildPaletteCommands({
  availability,
  ledgerOpen,
  selected,
  commandShortcut,
  ledgerShortcut,
  historySearchShortcut,
  watcherActive = true,
  actions,
}) {
  return [
    { id: "open-repository", label: "打开仓库", shortcut: commandShortcut, keywords: "打开 文件夹 仓库", ...availability.openRepository, run: actions.chooseRepo },
    // ⟳ 常驻按钮已降级（0.6.5 验收反馈 #21）：自动刷新正常时没有手动入口，
    // watcher 不可用时才在面板里提供手动重读；label 写明「不联网」以区别「获取…」。
    ...(watcherActive
      ? []
      : [{ id: "refresh", label: "重新读取本地状态（不联网）", keywords: "刷新 状态 手动", ...availability.refresh, run: actions.refreshFromUser }]),
    { id: "workspace", label: "前往工作区", keywords: "工作区 文件", ...availability.workspace, run: () => actions.setHistoryMode(false) },
    { id: "history", label: "前往历史审查", keywords: "历史 提交", ...availability.history, run: () => actions.setHistoryMode(true) },
    { id: "ledger", label: ledgerOpen ? "收起命令账本" : "展开命令账本", shortcut: ledgerShortcut, keywords: "账本 命令", ...availability.ledger, run: () => actions.setLedgerOpen((value) => !value) },
    { id: "history-search", label: "聚焦历史搜索", shortcut: historySearchShortcut, keywords: "历史 搜索", ...availability.historySearch, run: actions.focusHistorySearch },
    { id: "stage-selected", label: "暂存当前选中文件", keywords: "暂存 文件", ...availability.stageSelected, run: () => selected?.area === "unstaged" && actions.operate("stage", { path: selected.path }) },
  ];
}

// Exported so the UI tests can mount the real workbench with a stubbed
// `window.gitglass` bridge instead of asserting on this file's source text.
// See tests/support/render-app.mjs.
export function App() {
  const updates = useAppUpdates();
  // 三栏宽度：持久化、窗口变窄时夹紧、拖拽与键盘调整（纯计算在 panel-resize.js）。
  const {
    panelWidths,
    workspaceRef,
    getPanelLimits,
    startPanelResize,
    resetPanelWidth,
    resizePanelWithKeyboard,
  } = usePanelResize();
  const [repo, setRepo] = useState(null);
  // 最近打开仓库：[{ path, name, exists }]，由主进程在每次读取时重算 exists。
  const [recentRepositories, setRecentRepositories] = useState([]);
  const [state, setState] = useState({ branch: "", files: [], ok: true });
  const [selected, setSelected] = useState(null);
  // 批量暂存勾选集合：Set<stageSelectionKey>，独立于右侧 Diff 选中状态；
  // 一律通过创建新的 Set 进行不可变更新。
  const [stageSelection, setStageSelection] = useState(() => new Set());
  const [diff, setDiff] = useState("");
  const [diffMessage, setDiffMessage] = useState("");
  // 当前 Diff 的块信息：{ area, path, snapshot, support }。只有它与 selected 指向
  // 同一个文件时才允许按块操作，避免用旧 Diff 的标识去改新的暂存内容。
  const [diffHunks, setDiffHunks] = useState(null);
  // 提交前总览：{ status, repoPath, files, totals, reason }。repoPath 记录这份数据
  // 属于哪个仓库，切库后旧数据不会再被当成当前暂存区。
  const [stagedOverview, setStagedOverview] = useState({ status: "idle", repoPath: null, files: [], totals: null, reason: "" });
  // 总览是否展开由 App 持有：只有这样「收起后不再跟随刷新、重新展开才按需读取」才成立。
  const [stagedOverviewOpen, setStagedOverviewOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState(null);
  // 悬停或聚焦在横幅内（含 × / 钉住按钮）时暂停自动收起，离开后重新计时。
  // 拆成两个标志，避免"鼠标离开但焦点还在横幅里"被误判成可以继续计时。
  const [noticeHovered, setNoticeHovered] = useState(false);
  const [noticeFocused, setNoticeFocused] = useState(false);
  const [branches, setBranches] = useState([]);
  const [records, setRecords] = useState([]);
  const [ledgerFilter, setLedgerFilter] = useState("user");
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [focusedOperationId, setFocusedOperationId] = useState(null);
  const [newBranch, setNewBranch] = useState("");
  // watcher 可用性：fs.watch 在网络盘 / 受限文件系统上会静默失败，主进程把
  // watch() 的结果（与句柄异步死亡）推给渲染层；不可用时命令面板才提供手动
  // 刷新，并在打开仓库时提示一次（0.6.5 验收反馈 #21）。挂载时先乐观置 true。
  const [watcherActive, setWatcherActive] = useState(true);
  const refreshSequence = useRef(0);
  // Diff 读取的序号：快速切换文件时，先发出的读取不能覆盖后选中的文件。
  const diffSequence = useRef(0);
  // 暂存总览的读取序号与「当前仓库」快照：迟到的响应（更晚的请求已发出、
  // 或仓库已经切换）必须丢弃，否则旧仓库的文件会显示在新仓库里。
  const stagedOverviewSequence = useRef(0);
  const currentRepository = useRef(null);
  useEffect(() => {
    currentRepository.current = repo;
  }, [repo]);
  // 自动刷新（窗口重新聚焦 / 主进程看到 .git 变化）用的最新闭包与订阅状态：
  // 订阅只建立一次，所以 refreshAll 必须通过 ref 取用，不能闭包住首帧的仓库。
  const refreshAllRef = useRef(null);
  const automaticRefresh = useRef({
    loading: false,
    hasRepository: false,
    refreshing: false,
    lastRefreshAt: Date.now(),
  });
  // Last merge/rebase/cherry-pick/revert state we already told the user about,
  // so a background refresh does not repeat the same banner every cycle.
  const operationNoticeRef = useRef(null);
  // 瞬时通知（成功/失败）的自动收起计时器。只创建一次，onExpire 里再把通知置空；
  // 「仓库处于合并/变基中」的状态横幅永远不进入这个计时器（见 notice-lifecycle.js）。
  const noticeTimerRef = useRef(null);
  if (!noticeTimerRef.current) {
    noticeTimerRef.current = createNoticeTimer({
      onExpire: () => setNotice((current) => (current && !current.pinned ? null : current)),
    });
  }
  const refreshCycles = useRef(new Map());
  const paletteTriggerRef = useRef(null);
  const paletteReturnFocusRef = useRef(null);
  // 历史审查领域的状态与动作都在 hook 里；这里保留原有变量名，JSX 不用改。
  const {
    historyMode,
    setHistoryMode,
    historySelected,
    historyDetail,
    historyResult,
    historyFile,
    historyCompare,
    historyDraft,
    historyApplied,
    commits,
    commitsReason,
    historyFiltersDirty,
    historySearchRef,
    detailSubject,
    detailAuthor,
    detailEmail,
    detailTime,
    historyTitle,
    historySubtitle,
    historyNotice,
    updateDraft,
    applySelectedFile,
    applyHistoryFilters,
    beginQuery,
    applyQueryResultIfCurrent,
    selectHistoryCommit,
    viewParentCommit,
    readHistoryDiff,
    openCommitFileDiff,
    openFileEntryDiff,
    openFileHistory,
    pinCompare,
    swapCompare,
    readCompare,
    clearCompare,
    dismissResult,
    handleEscape,
    resetAll: resetHistoryState,
    resetReview: resetHistoryReview,
  } = useHistoryReview({
    gitglass: window.gitglass,
    repo,
    loading,
    setLoading,
    refreshLedger,
  });
  // 计划类操作只预设账本筛选，不再自动弹出（0.6.6-beta 验收反馈：任何操作都不要
  // 直接弹账本）。用户按 J 或顶栏按钮打开时，直接落在对应的筛选上。
  const presetLedger = (tab) => {
    if (tab) setLedgerFilter(tab);
  };
  // 计划类操作（撤销 / 删除分支 / 救援分支 / 切换分支）与恢复中心。
  const {
    safetyPlan,
    setSafetyPlan,
    branchPlan,
    setBranchPlan,
    recoveryOpen,
    setRecoveryOpen,
    reflogEntries,
    reflogReason,
    acknowledgement,
    setAcknowledgement,
    requestSwitch,
    confirmBranch,
    requestDiscard,
    requestDeleteMergedBranch,
    openRecovery,
    requestRescue,
    confirmSafety,
  } = useSafetyPlans({
    gitglass: window.gitglass,
    branch: state.branch,
    loading,
    setLoading,
    refreshLedger,
    refreshAll,
    setNotice,
    presetLedger,
    setFocusedOperationId,
  });
  // 远程域：overview 与 fetch / push / pull 的计划。
  const {
    remote,
    applyOverview,
    remotePlan,
    setRemotePlan,
    fetch: fetchRemote,
    push: pushRemote,
    pull: pullRemote,
    confirmRemote,
  } = useRemoteOverview({
    gitglass: window.gitglass,
    repo,
    loading,
    setLoading,
    refreshLedger,
    refreshAll,
    setNotice,
    presetLedger,
    setFocusedOperationId,
  });
  const staged = useMemo(
    () => state.files.filter((file) => file.area === "staged"),
    [state.files],
  );
  const unstaged = useMemo(
    () => state.files.filter((file) => file.area === "unstaged"),
    [state.files],
  );
  // 勾选集合只包含仍存在于未暂存区的文件（刷新 / 暂存成功 / 切换仓库后自动对齐）。
  const checkedForStaging = useMemo(
    () =>
      unstaged.filter((file) =>
        stageSelection.has(stageSelectionKey(file.area, file.path)),
      ),
    [unstaged, stageSelection],
  );
  const checkedCount = checkedForStaging.length;
  const ledgerCounts = useMemo(() => countBySource(records), [records]);
  const visibleRecords = useMemo(
    () => filterLedgerRecords(records, ledgerFilter, focusedOperationId),
    [records, ledgerFilter, focusedOperationId],
  );
  const ledgerGroups = useMemo(
    () => groupBackgroundRecords(visibleRecords),
    [visibleRecords],
  );
  // CommandLedger 是 memo 的：这几个回调必须保持稳定引用，否则每次 App 重渲染都会
  // 让整列（最多 300 条）记录跟着重渲染。行为与内联箭头函数完全一致。
  const toggleLedger = useCallback(() => setLedgerOpen((value) => !value), []);
  const changeLedgerFilter = useCallback((tab) => {
    setLedgerFilter(tab);
    setFocusedOperationId(null);
  }, []);
  // 收起态摘要：与展开面板的筛选状态无关——有用户操作就显示最近一条，没有才回退系统读取。
  const glanceRecord = useMemo(() => ledgerGlanceRecord(records), [records]);
  // 点摘要展开账本，并切到这条记录对应的来源；用户操作还要定位到它自己的 operationId。
  const openLedgerAt = useCallback(() => {
    setLedgerOpen(true);
    if (!glanceRecord) return;
    setLedgerFilter(glanceRecord.source === "background" ? "background" : "user");
    setFocusedOperationId(glanceRecord.source === "user" ? glanceRecord.operationId || null : null);
  }, [glanceRecord]);
  // 命令预览跟随动作：当前文件可暂存时用**账本同一套参数格式化**拼出 `git add -- …`，
  // 含空格或引号的路径因此与账本里的记录逐字一致（例如 `git add -- "guide for project.md"`）。
  // 已暂存文件的取消暂存取决于仓库是否有 HEAD（无 HEAD 时是另一条命令），现有状态无法确定参数，
  // 所以预览只在能确定的场景出现（交接稿：界面应避免猜测）。
  const stagePreview =
    selected && selected.area === "unstaged"
      ? displayGitCommand(["add", "--", selected.path])
      : "";
  const commitPreview =
    staged.length > 0 && message.trim()
      ? displayGitCommand(["commit", "-m", message.trim()])
      : "";
  // 首屏恢复与自动刷新订阅都只建立一次，两者都要"最新一份" refreshAll：
  // 每次渲染先把最新的闭包与仓库 / loading 状态放进 ref，effect 里只读 ref。
  // 这个 effect 必须排在首屏恢复之前，挂载时才能保证 ref 已经就位。
  useEffect(() => {
    refreshAllRef.current = refreshAll;
    automaticRefresh.current.loading = loading;
    automaticRefresh.current.hasRepository = Boolean(repo);
  });
  // 首屏：先恢复更新前保存的草稿与模式，再整体刷新一次；哨兵只用一次。
  // 依赖里只有 setHistoryMode（useHistoryReview 暴露的稳定 setter）：
  // refreshAll 通过 ref 取最新闭包，所以这个 effect 不会重复执行。
  useEffect(() => {
    (async () => {
      const resume = await window.gitglass.getUpdateResume();
      if (resume) {
        setMessage(resume.commitMessage);
        setHistoryMode(resume.historyMode);
      }
      await refreshAllRef.current?.();
      if (resume) await window.gitglass.consumeUpdateResume();
    })().catch(() => setNotice({ type: "error", text: "无法恢复工作区，请重新打开仓库。" }));
  }, [setHistoryMode]);
  useEffect(() => {
    loadRecentRepositories();
  }, []);
  // 窗口重新获得焦点、或主进程在 .git 上看到变化（终端里 commit / 切换分支）
  // 时静默刷新一次：不弹通知、不打开账本。loading、静默刷新进行中一律丢弃；
  // 刷新结束后 1 秒内的事件也丢弃，但与 index 无关的 HEAD / refs 变化可以穿过
  // 静默窗（见 src/auto-refresh.js），这样"终端里连续 add + commit"不会漏掉。
  useEffect(() => {
    const triggerAutomaticRefresh = async (reason = "") => {
      const guard = automaticRefresh.current;
      if (
        !shouldRefreshOnChange({
          loading: guard.loading,
          refreshing: guard.refreshing,
          hasRepository: guard.hasRepository,
          lastRefreshAt: guard.lastRefreshAt,
          reason,
        })
      )
        return;
      guard.refreshing = true;
      try {
        await refreshAllRef.current?.();
      } catch {
        // 静默刷新失败不打扰用户：下一次事件或窗口聚焦会再试一次。
      } finally {
        guard.refreshing = false;
        guard.lastRefreshAt = Date.now();
      }
    };
    const onRepositoryChanged = (payload) => {
      triggerAutomaticRefresh(payload?.reason || "");
    };
    // 聚焦事件必须显式传空串，否则 FocusEvent 会被当成 reason 传进策略函数。
    const onWindowFocus = () => {
      triggerAutomaticRefresh("");
    };
    const unsubscribe = window.gitglass.onRepositoryChanged?.(onRepositoryChanged);
    window.addEventListener("focus", onWindowFocus);
    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
      window.removeEventListener("focus", onWindowFocus);
    };
  }, []);
  // watcher 状态：挂载时读一次 + 订阅推送。不可用时只提示一次（同一段失败不
  // 重复打扰），恢复可用后重新武装；没有打开仓库时不提示（没有东西可刷新）。
  useEffect(() => {
    let disposed = false;
    window.gitglass.getWatcherState?.()
      .then((status) => {
        if (!disposed) setWatcherActive(status?.active !== false);
      })
      .catch(() => { /* 查询失败保持乐观值，下一次推送会纠正。 */ });
    const unsubscribe = window.gitglass.onWatcherChanged?.((payload) => setWatcherActive(payload?.active !== false));
    return () => {
      disposed = true;
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, []);
  const watcherNoticeArmed = useRef(true);
  useEffect(() => {
    if (watcherActive) {
      watcherNoticeArmed.current = true;
      return;
    }
    if (!repo || !watcherNoticeArmed.current) return;
    watcherNoticeArmed.current = false;
    setNotice({ type: "error", text: "自动刷新不可用（无法监视仓库变化），请从命令面板手动刷新。" });
  }, [watcherActive, repo]);
  // 刷新、暂存成功、切换仓库后：把勾选集合与当前未暂存列表重新对齐，
  // 移除已不存在于未暂存区的幽灵选择。
  useEffect(() => {
    setStageSelection((previous) => {
      if (!previous.size) return previous;
      const valid = new Set(
        unstaged.map((file) => stageSelectionKey(file.area, file.path)),
      );
      let changed = false;
      const next = new Set();
      for (const key of previous) {
        if (valid.has(key)) next.add(key);
        else changed = true;
      }
      return changed ? next : previous;
    });
  }, [unstaged]);
  function toggleStageSelection(file) {
    setStageSelection((previous) => {
      const key = stageSelectionKey(file.area, file.path);
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function selectAllUnstaged() {
    setStageSelection(
      new Set(unstaged.map((file) => stageSelectionKey(file.area, file.path))),
    );
  }
  function clearStageSelection() {
    setStageSelection(new Set());
  }
  async function applyState(next, preference, cycle) {
    setState(next);
    // 偏好只在「这个文件仍然存在」时生效：暂存完最后一块后同一区域可能已经消失，
    // 此时回落到同一路径的另一区域，再回落到第一个文件。
    const preferred = preference
      ? next.files.find(
          (file) => file.path === preference.path && file.area === preference.area,
        ) ||
        next.files.find((file) => file.path === preference.path) ||
        null
      : null;
    const nextFile = preferred || next.files[0] || null;
    setSelected(nextFile);
    if (nextFile) await loadDiff(nextFile, cycle);
    else {
      setDiff("");
      setDiffMessage("");
      setDiffHunks(null);
    }
  }
  async function refreshLedger(cycle) {
    const next = await window.gitglass.getLedger();
    setRecords((previous) =>
      reuseUnchangedRecords(
        previous,
        next.map((record) => {
          if (
            record.source === "background" &&
            cycle &&
            !refreshCycles.current.has(record.id)
          )
            refreshCycles.current.set(record.id, cycle);
          const refreshCycleId = refreshCycles.current.get(record.id);
          return refreshCycleId ? { ...record, refreshCycleId } : record;
        }),
      ),
    );
  }
  function clearStaleRepositoryState(failure) {
    setRepo(null);
    setState(failure.state);
    setSelected(null);
    setDiff("");
    setDiffMessage("");
    setDiffHunks(null);
    setStagedOverview({ status: "idle", repoPath: null, files: [], totals: null, reason: "" });
    setStagedOverviewOpen(false);
    setStageSelection(new Set());
    setBranches([]);
    resetHistoryState();
    applyOverview(null);
  }
  async function runRefresh(preference, options) {
    const sequence = ++refreshSequence.current;
    const cycle = `refresh-${Date.now()}-${sequence}`;
    const next = await window.gitglass.getState();
    // A newer refresh started while this one was in flight: its result would be
    // stale, so drop it instead of letting an older snapshot win.
    if (sequence !== refreshSequence.current) return { ok: false, stale: true };
    const resolved = resolveRepositoryRefresh(repo, next, options);
    if (!resolved.ok) {
      clearStaleRepositoryState(resolved);
      if (resolved.notify) {
        setLedgerOpen(true);
        setLedgerFilter("background");
        setNotice({ type: "error", text: resolved.message });
      }
      await refreshLedger(cycle);
      return resolved;
    }
    setRepo(next.path || repo);
    await applyState(next, preference, cycle);
    if (sequence !== refreshSequence.current) return { ok: false, stale: true };
    const queryToken = beginQuery();
    const [branchResult, commitResult, remoteResult] = await Promise.all([
      window.gitglass.getBranches(),
      historyApplied ? window.gitglass.queryHistory(historyApplied) : window.gitglass.getCommits(),
      window.gitglass.getRemoteOverview(),
    ]);
    setBranches(branchResult.branches || []);
    applyQueryResultIfCurrent(queryToken, commitResult);
    applyOverview(remoteResult);
    await refreshLedger(cycle);
    // 所有刷新（操作成功后、外部 Git 变化、切库）都经过这里：展开着的暂存总览必须
    // 跟着实际暂存区更新；收起（或从未展开）时保持按需读取，不多发后台命令。
    if (stagedOverviewOpen) {
      await refreshStagedOverview({ silent: true, repoPath: next.path || repo });
    }
    return resolved;
  }
  // 所有刷新（启动、手动、切换仓库、操作成功后、自动刷新）都经这里：结束时
  // 记录时间戳，作为自动刷新 1 秒静默窗的起点。
  async function refreshAll(preference, options) {
    try {
      return await runRefresh(preference, options);
    } finally {
      automaticRefresh.current.lastRefreshAt = Date.now();
    }
  }
  async function refreshFromUser() {
    if (!canStartRepositoryContextOperation(loading)) return;
    setLoading(true);
    try {
      await refreshAll();
    } finally {
      setLoading(false);
    }
  }
  async function loadDiff(file, cycle) {
    const sequence = ++diffSequence.current;
    setSelected(file);
    setDiff("");
    setDiffHunks(null);
    setDiffMessage("正在读取文件差异…");
    const result = await window.gitglass.getDiff(file);
    // 读取期间用户又选了别的文件：这份结果属于旧文件，绝不能覆盖当前视图。
    if (sequence !== diffSequence.current) {
      await refreshLedger(cycle);
      return;
    }
    if (!result.ok) {
      setDiffMessage("无法读取此文件的差异。请刷新工作区后重试；诊断信息已保留在命令账本。");
    } else if (binaryDiffPattern.test(result.stdout || "")) {
      setDiffMessage("这是二进制文件，Git 无法显示文本差异。请在命令账本查看诊断信息。");
    } else if (result.outputTruncated) {
      setDiff(result.stdout || "");
      setDiffMessage("Diff 已截断，可在命令账本复制真实命令后在终端查看完整输出。");
    } else if (!result.stdout) {
      setDiffMessage("没有可显示的文本差异。文件状态可能已变化，请刷新工作区后重试。");
    } else {
      setDiff(result.stdout);
      setDiffMessage("");
    }
    // 只有读取成功、且主进程下发了块清单时才允许按块操作。
    setDiffHunks(
      result.ok && result.snapshot
        ? {
            area: result.area || file.area,
            path: result.path || file.path,
            snapshot: result.snapshot,
            support: result.hunkSupport || { ok: false, reason: "", hunks: [] },
          }
        : null,
    );
    await refreshLedger(cycle);
  }
  // 按块暂存 / 取消暂存：只把下发的标识回传主进程，补丁由主进程重建。
  // 成功后保留当前文件（优先同一区域），并让界面按 Git 的真实结果刷新。
  async function applyHunkSelection(direction, hunk) {
    if (!repo || loading || !diffHunks?.support?.ok || !hunk) return;
    setLoading(true);
    try {
      const result = await window.gitglass.applyDiffHunk(direction, {
        path: diffHunks.path,
        snapshot: diffHunks.snapshot,
        hunk,
      });
      setFocusedOperationId(
        result?.execution?.operationId || result?.record?.operationId || null,
      );
      setNotice(hunkOperationNotice(direction, result));
      // refreshAll 会按真实状态刷新工作区，并顺带刷新展开着的暂存总览。
      await refreshAll(selected);
    } finally {
      setLoading(false);
    }
  }
  async function refreshStagedOverview(options = {}) {
    const requestedRepo = options.repoPath ?? repo;
    const sequence = ++stagedOverviewSequence.current;
    setStagedOverview((current) => ({ ...current, status: "loading" }));
    try {
      const overview = await window.gitglass.getStagedOverview();
      // 迟到的响应：已经有更新的读取发起，或仓库在读取期间被切换。
      if (sequence !== stagedOverviewSequence.current) return;
      if (currentRepository.current !== requestedRepo) return;
      setStagedOverview({
        status: overview?.ok === false ? "error" : "ready",
        repoPath: requestedRepo,
        files: Array.isArray(overview?.files) ? overview.files : [],
        totals: overview?.totals || null,
        reason: overview?.reason || "",
      });
    } catch {
      if (sequence !== stagedOverviewSequence.current) return;
      if (currentRepository.current !== requestedRepo) return;
      setStagedOverview({ status: "error", repoPath: requestedRepo, files: [], totals: null, reason: "无法读取暂存总览。" });
      if (!options.silent) setNotice({ type: "error", text: GENERIC_GIT_FAILURE });
    }
  }
  async function loadRecentRepositories() {
    try {
      const list = await window.gitglass.getRecentRepositories();
      setRecentRepositories(Array.isArray(list) ? list : []);
    } catch {
      // 最近仓库列表不可用时保持当前内容，不影响主工作区。
    }
  }
  async function forgetRecentRepository(candidate, options = {}) {
    try {
      const list = await window.gitglass.forgetRecentRepository(candidate);
      setRecentRepositories(Array.isArray(list) ? list : []);
      if (!options.silent) {
        setNotice({ type: "success", text: `已从最近仓库移除：${candidate}` });
      }
    } catch {
      if (!options.silent) {
        setNotice({ type: "error", text: "无法从最近仓库移除该路径。" });
      }
    }
  }
  // 打开仓库成功后的统一收尾：选目录与最近仓库切换都必须走这里，
  // 避免出现第二份「清历史/清勾选」逻辑。
  async function applyOpenedRepository(result) {
    const opened = resolveRepositoryRefresh(repo, result.state, { notifyOnFailure: true });
    if (!opened.ok) {
      clearStaleRepositoryState(opened);
      setLedgerOpen(true);
      setLedgerFilter("background");
      setNotice({ type: "error", text: opened.message });
      await refreshLedger();
      await loadRecentRepositories();
      return { ok: false, message: opened.message };
    }
    setRepo(result.path);
    // 切换仓库后清空历史审阅状态，避免旧仓库的选中提交与缓存混入。
    resetHistoryReview();
    // 切换仓库后清空批量暂存选择，避免旧仓库的勾选混入新仓库。
    setStageSelection(new Set());
    // 新仓库从收起态开始：总览按需读取，不会带着旧仓库的数据自动展开。
    setStagedOverviewOpen(false);
    setStagedOverview({ status: "idle", repoPath: null, files: [], totals: null, reason: "" });
    const refreshed = await refreshAll(undefined, { notifyOnFailure: true });
    if (refreshed.ok) setNotice({ type: "success", text: `已打开仓库：${result.path}` });
    await loadRecentRepositories();
    return refreshed;
  }
  async function chooseRepo() {
    if (!canStartRepositoryContextOperation(loading)) return;
    setLoading(true);
    try {
      const result = await window.gitglass.chooseRepository();
      if (result.canceled) return;
      if (!result.ok) {
        setLedgerOpen(true);
        setLedgerFilter("background");
        setNotice({ type: "error", text: result.message || GENERIC_GIT_FAILURE });
        await refreshLedger();
        return;
      }
      await applyOpenedRepository(result);
    } catch {
      setLedgerOpen(true);
      setLedgerFilter("background");
      setNotice({ type: "error", text: GENERIC_GIT_FAILURE });
      await refreshLedger();
    } finally {
      setLoading(false);
    }
  }
  async function openRecentRepository(item) {
    if (!item?.path || !canStartRepositoryContextOperation(loading)) return;
    setLoading(true);
    try {
      const result = await window.gitglass.openRepository(item.path);
      if (!result?.ok) {
        setLedgerOpen(true);
        setLedgerFilter("background");
        setNotice({ type: "error", text: result?.message || GENERIC_GIT_FAILURE });
        await refreshLedger();
        // 路径已在磁盘上消失：给出中文原因并把它从最近列表移除，而不是静默失败。
        if (result?.missing || item.exists === false) {
          await forgetRecentRepository(item.path, { silent: true });
        }
        return;
      }
      await applyOpenedRepository(result);
    } catch {
      setLedgerOpen(true);
      setLedgerFilter("background");
      setNotice({ type: "error", text: GENERIC_GIT_FAILURE });
      await refreshLedger();
    } finally {
      setLoading(false);
    }
  }
  async function operate(action, payload = {}) {
    if (!repo || loading) return;
    setLoading(true);
    // 0.6.6-beta 验收反馈：操作不再自动弹出命令账本；成功与否由通知横幅表达，
    // 收起态的账本摘要行（最近：xx）仍然可见，需要细节时用户自己展开。
    const result = await window.gitglass.operate(action, payload);
    setFocusedOperationId(result.execution?.operationId || null);
    setNotice(operationNotice(action, result));
    if (result.commit) setMessage("");
    await refreshAll();
    setLoading(false);
  }
  const shortcutPlatform = navigator.userAgent;
  const commandShortcut = shortcutLabel("K", shortcutPlatform);
  const historySearchShortcut = shortcutLabel("F", shortcutPlatform);
  const ledgerShortcut = shortcutLabel("J", shortcutPlatform);
  const modalOpen = isBlockingContextOpen({
    paletteOpen,
    safetyPlan,
    branchPlan,
    remotePlan,
    recoveryOpen,
  });
  const blockingContextOpen = modalOpen || updates.open;
  // A merge/rebase in progress is state, not a transient message: keep it
  // visible until the user resolves it, even if a notice is dismissed.
  const operationBanner = state?.operation ? operationInProgressNotice(state.operation) : null;
  const workspaceBanner = operationBanner || notice;
  const noticeWaiting = noticeHovered || noticeFocused;
  // 瞬时通知出现（或被新内容替换）就开始计时；文案变化会重新计满整段时间。
  // 依赖只放 notice 对象和 state.operation 原始值，并在 effect 里就地推出
  // operationBanner：`workspaceBanner` 那个对象每次渲染都是新的，放进依赖会
  // 让计时器被无限重启，6 秒永远走不完。
  useEffect(() => {
    syncNoticeTimer(noticeTimerRef.current, {
      notice,
      operationBanner: state?.operation ? operationInProgressNotice(state.operation) : null,
    });
  }, [notice, state?.operation]);
  // 悬停/聚焦暂停；离开后重新计满整段时间，所以不会"鼠标一离开就消失"。
  useEffect(() => {
    if (noticeWaiting) noticeTimerRef.current.pause();
    else noticeTimerRef.current.resume();
  }, [noticeWaiting, notice, state?.operation]);
  // 横幅被 × 或自动收起时不会有 mouseleave，暂停标志必须在新通知出现时归零，
  // 否则下一条通知会一出现就处于暂停状态，再也不自动收起。
  useEffect(() => {
    setNoticeHovered(false);
    setNoticeFocused(false);
  }, [notice]);
  useEffect(() => () => noticeTimerRef.current.cancel(), []);
  // Announce the end of a merge/rebase once, after the banner disappears.
  useEffect(() => {
    const operation = state?.operation ?? null;
    if (operation) {
      operationNoticeRef.current = operation;
      return;
    }
    if (operationNoticeRef.current) {
      operationNoticeRef.current = null;
      setNotice(operationFinishedNotice());
    }
  }, [state?.operation]);
  function openCommandPalette(trigger = document.activeElement) {
    paletteReturnFocusRef.current = trigger instanceof HTMLElement ? trigger : paletteTriggerRef.current;
    setPaletteOpen(true);
  }
  function closeCommandPalette() {
    setPaletteOpen(false);
    requestAnimationFrame(() => paletteReturnFocusRef.current?.focus?.());
  }
  function escapeCurrentContext() {
    if (safetyPlan) { setSafetyPlan(null); return; }
    if (branchPlan) { setBranchPlan(null); return; }
    if (remotePlan) { setRemotePlan(null); return; }
    if (recoveryOpen) { setRecoveryOpen(false); return; }
    // 历史模式自己决定 Esc 的三段语义（关 Diff → 丢草稿 → 还原筛选 → 退出模式）。
    handleEscape();
  }
  // 全局快捷键。订阅每次渲染重建、不写依赖数组：处理器用到的函数（operate /
  // escapeCurrentContext / 打开面板）与状态都是本次渲染的最新闭包，比维护一份
  // 永远少一项的依赖表更可靠，也不会出现"旧闭包读到旧仓库"的问题。
  useEffect(() => {
    const onKeyDown = (event) => {
      const action = resolveShortcut(event, {
        paletteOpen,
        blockingContextOpen,
        historyMode,
        loading,
        hasStaged: staged.length > 0,
        hasMessage: Boolean(message.trim()),
      });
      if (!action) return;
      event.preventDefault();
      if (action === "open-palette") openCommandPalette(document.activeElement);
      else if (action === "close-palette") closeCommandPalette();
      else if (action === "focus-history-search") {
        historySearchRef.current?.focus();
        historySearchRef.current?.select();
      } else if (action === "toggle-ledger") setLedgerOpen((value) => !value);
      else if (action === "commit") operate("commit", { message });
      else if (action === "escape") escapeCurrentContext();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });
  // 命令面板的条目由纯函数生成：`run` 闭包住 App 里最新的动作，
  // 所以不放进 useMemo（放进去了依赖也每帧都变，白算一次）。
  const paletteCommands = buildPaletteCommands({
    availability: commandAvailability({
      hasRepository: Boolean(repo),
      loading,
      historyMode,
      selectedArea: selected?.area,
    }),
    ledgerOpen,
    selected,
    watcherActive,
    commandShortcut,
    ledgerShortcut,
    historySearchShortcut,
    actions: {
      chooseRepo,
      refreshFromUser,
      setHistoryMode,
      setLedgerOpen,
      operate,
      focusHistorySearch: () => {
        historySearchRef.current?.focus();
        historySearchRef.current?.select();
      },
    },
  });
  function executePaletteCommand(command) {
    if (!command.available) return;
    closeCommandPalette();
    command.run();
  }
  // 块操作的入口数据：只有「当前 Diff 的块信息」与「当前选中文件」指向同一区域
  // 同一个文件时才下发按钮，旧 Diff 的标识永远不会被用来改新的暂存内容。
  const hunkActions =
    diffHunks && selected && diffHunks.path === selected.path && diffHunks.area === selected.area
      ? {
          direction: diffHunks.area === "staged" ? "unstage" : "stage",
          hunks: diffHunks.support?.hunks || [],
          enabled: Boolean(diffHunks.support?.ok) && !loading,
          reason: diffHunks.support?.reason || "",
          onApply: applyHunkSelection,
        }
      : null;
  const inspector = safetyPlan ? (
    <SafetyContext
      plan={safetyPlan}
      acknowledgement={acknowledgement}
      onAcknowledgement={setAcknowledgement}
      loading={loading}
      onConfirm={confirmSafety}
      onCancel={() => setSafetyPlan(null)}
    />
  ) : branchPlan ? (
    <BranchContext
      plan={branchPlan}
      loading={loading}
      onConfirm={confirmBranch}
      onCancel={() => setBranchPlan(null)}
    />
  ) : remotePlan ? (
    <RemotePlanContext
      plan={remotePlan}
      loading={loading}
      onConfirm={confirmRemote}
      onCancel={() => setRemotePlan(null)}
    />
  ) : recoveryOpen ? (
    <RecoveryContext
      entries={reflogEntries}
      reason={reflogReason}
      loading={loading}
      onRescue={requestRescue}
      onClose={() => setRecoveryOpen(false)}
    />
  ) : !repo ? (
    <NoRepositoryGuide loading={loading} onOpen={chooseRepo} />
  ) : (
    <>
      {/* 右栏固定两段：上「当前文件」（只影响这一个文件），下「创建提交」（影响整个暂存区）。
          文件区与提交区之间只用一条细线分隔，动作预览各自跟随上下文。 */}
      {selected ? (
        <FileInspector
          file={selected}
          label={fileLabel(selected.path)}
          stagedCount={staged.length}
          loading={loading}
          preview={stagePreview}
          onStage={(file) =>
            operate(file.area === "staged" ? "unstage" : "stage", {
              path: file.path,
            })
          }
          onDiscard={requestDiscard}
        />
      ) : (
        <section className="inspector-flow current-file current-file-empty">
          <div className="section-label">
            <h2>当前文件</h2>
          </div>
          <p className="inspector-hint">从左侧文件列表选择文件后，这里显示它的暂存与丢弃动作。</p>
        </section>
      )}
      <CommitInspector
        staged={staged}
        unstaged={unstaged}
        message={message}
        loading={loading}
        onMessage={setMessage}
        onOperate={operate}
        preview={commitPreview}
        platform={shortcutPlatform}
        overview={stagedOverview}
        currentRepo={repo}
        overviewOpen={stagedOverviewOpen}
        onToggleOverview={(next) => {
          setStagedOverviewOpen(next);
          // 展开时按需读取一次；收起后不再跟随刷新。
          if (next) refreshStagedOverview({ repoPath: repo });
        }}
        onOpenStagedFile={(file) => loadDiff({ path: file.path, area: "staged" })}
      />
    </>
  );
  return (
    <main
      className={`app-shell ${ledgerOpen ? "ledger-open" : "ledger-closed"} ${isDarwin ? "platform-darwin" : ""} ${workspaceBanner ? "has-banner" : ""}`}
    >
      <a className="skip-link" href="#workspace-main">
        跳至主工作区
      </a>
      {/* 顶栏三组：左「品牌 / 仓库 / 分支 / 改动」，中「工作区 / 历史审查」，右动作区。
          当前视图用蓝色下划线与 aria-pressed 同时表达；1240px 以下先把文字标签折成图标。 */}
      <header className="topbar">
        <div className="topbar-group topbar-left">
          <div className="brand">
            <BrandMark size={20} />
            <h1>GitGlass</h1>
            <span className="topbar-divider" aria-hidden="true" />
            <strong title={repo || ""}>{repo ? basename(repo) : "未打开仓库"}</strong>
          </div>
          <div className="top-state">
            <span>
              <GitBranch size={14} aria-hidden="true" />
              <code>{state.branch || "—"}</code>
            </span>
            <span className={state.files.length ? "dirty" : "clean"}>
              {repo
                ? state.files.length
                  ? `${state.files.length} 个改动`
                  : "工作区干净"
                : "等待仓库"}
            </span>
            {remote?.upstream && (
              <span className="sync-counts">
                <b className={remote.ahead > 0 ? "ahead" : ""}>
                  ↑ {remote.ahead}
                </b>
                <b className={remote.behind > 0 ? "behind" : ""}>
                  ↓ {remote.behind}
                </b>
              </span>
            )}
          </div>
        </div>
        <nav className="view-switch" aria-label="视图">
          <button
            type="button"
            className="view-tab"
            onClick={() => setHistoryMode(false)}
            aria-label="工作区"
            title="工作区"
            aria-pressed={!historyMode}
          >
            <File size={15} aria-hidden="true" />
            <span className="view-tab-label">工作区</span>
          </button>
          <button
            type="button"
            className="view-tab"
            onClick={() => setHistoryMode(true)}
            aria-label="历史审查"
            title="历史审查"
            aria-pressed={historyMode}
          >
            <GitCommit size={15} aria-hidden="true" />
            <span className="view-tab-label">历史审查</span>
          </button>
        </nav>
        <div className="topbar-group top-actions">
          <UpdateButton updates={updates} disabled={modalOpen} />
          <button
            type="button"
            className="toolbar-button"
            ref={paletteTriggerRef}
            onClick={(event) => openCommandPalette(event.currentTarget)}
            aria-label="命令面板"
            title={`命令面板（${commandShortcut}）`}
            aria-haspopup="dialog"
            aria-keyshortcuts={isDarwin ? "Meta+K" : "Control+K"}
            disabled={loading || blockingContextOpen}
          >
            <MagnifyingGlass size={15} />
            <span className="top-action-label">命令</span>
          </button>
          <button
            type="button"
            className="toolbar-button"
            aria-label="恢复"
            title="恢复"
            disabled={!repo || loading}
            onClick={openRecovery}
          >
            <ArrowCounterClockwise size={15} />
            <span className="top-action-label">恢复</span>
          </button>
          <span className="topbar-divider" aria-hidden="true" />
          <div className="open-repository">
            <button type="button" className="secondary-button" onClick={chooseRepo} aria-label="打开仓库" title="打开仓库" disabled={loading}>
              <FolderOpen size={15} />
              <span className="top-action-label">打开仓库</span>
            </button>
            <RecentRepositoriesMenu
              repositories={recentRepositories}
              currentPath={repo}
              disabled={loading}
              onOpen={openRecentRepository}
              onForget={forgetRecentRepository}
            />
          </div>
          <button
            type="button"
            className="secondary-button"
            aria-label="获取远程更新（先查看计划）"
            title="联网拉取远程更新（先生成计划，不会立即执行）"
            disabled={!repo || loading || !remote?.remotes?.length}
            onClick={fetchRemote}
          >
            <ArrowClockwise size={15} />
            <span className="top-action-label">获取…</span>
          </button>
        </div>
      </header>
      {workspaceBanner && (
        <div
          className={`app-notice ${workspaceBanner.type}`}
          role="status"
          aria-live="polite"
          onMouseEnter={() => setNoticeHovered(true)}
          onMouseLeave={() => setNoticeHovered(false)}
          onFocus={() => setNoticeFocused(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setNoticeFocused(false);
          }}
        >
          {workspaceBanner.type === "success" ? (
            <CheckCircle size={15} weight="fill" />
          ) : (
            <WarningCircle size={15} weight="fill" />
          )}
          <span>{workspaceBanner.text}</span>
          {!operationBanner && (
            <>
              <button
                type="button"
                className="app-notice-pin"
                aria-pressed={Boolean(notice?.pinned)}
                title={notice?.pinned ? "取消钉住：恢复自动收起" : `钉住提示：不再自动收起（默认 ${AUTO_DISMISS_MS / 1000} 秒后收起）`}
                onClick={() => setNotice((current) => (current ? { ...current, pinned: !current.pinned } : current))}
              >
                {notice?.pinned ? "已钉住" : "钉住"}
              </button>
              <button type="button" className="app-notice-dismiss" onClick={() => setNotice(null)} aria-label="关闭提示">×</button>
            </>
          )}
        </div>
      )}
      {historyMode ? <div ref={workspaceRef} id="workspace-main" className="workspace history-workspace" style={{ "--left-panel-width": `${panelWidths.left}px`, "--right-panel-width": `${panelWidths.right}px` }} tabIndex="-1">
        <aside className="status-panel">
          <div className="panel-heading"><h2>历史审查</h2></div>
          <p className="inspector-copy">默认读取最近 80 条；应用筛选后最多返回 200 条。所有查询都作为系统读取记录在命令账本中。</p>
          <HistoryFilters
            draft={historyDraft}
            branches={branches}
            currentBranch={state.branch}
            selectedFile={selected}
            loading={loading}
            dirty={historyFiltersDirty}
            onChange={(field, value) => updateDraft(field, value)}
            onApply={() => applyHistoryFilters()}
            onReset={() => applyHistoryFilters(undefined, true)}
            onUseSelected={() => applySelectedFile(selected)}
          />
          <section className="branch-list compare-panel">
            <div className="section-label"><span>双提交比较</span></div>
            <p className="selection-line">
              基准 {historyCompare.base ? (
                <>
                  <code>{historyCompare.base.shortHash}</code>
                  <span className="selection-subject" title={historyCompare.base.subject}>{historyCompare.base.subject}</span>
                </>
              ) : "未选择"}
            </p>
            <p className="selection-line">
              对比 {historyCompare.target ? (
                <>
                  <code>{historyCompare.target.shortHash}</code>
                  <span className="selection-subject" title={historyCompare.target.subject}>{historyCompare.target.subject}</span>
                </>
              ) : "未选择"}
            </p>
            {historyCompare.base && historyCompare.target && (
              <>
                <p className="compare-direction">
                  比较方向：<code>{historyCompare.base.shortHash}</code> → <code>{historyCompare.target.shortHash}</code>（基准 → 对比）
                </p>
                <div className="compare-actions">
                  <button
                    type="button"
                    className="secondary-action"
                    aria-label="交换基准提交与对比提交"
                    title="交换基准提交与对比提交"
                    onClick={swapCompare}
                  >
                    <ArrowsLeftRight size={14} aria-hidden="true" />
                    交换
                  </button>
                  <button type="button" className="secondary-action" onClick={readCompare} disabled={loading}>
                    读取比较
                  </button>
                </div>
              </>
            )}
            {(historyCompare.base || historyCompare.target) && (
              <button
                type="button"
                className="text-action"
                aria-label="清除比较选择"
                title="清除比较选择"
                onClick={clearCompare}
              >
                清除比较选择
              </button>
            )}
          </section>
        </aside>
        <PanelSplitter side="left" value={panelWidths.left} limits={getPanelLimits("left")} onPointerDown={startPanelResize} onDoubleClick={resetPanelWidth} onKeyDown={resizePanelWithKeyboard} />
        <section className="main-panel">
          <div className="main-toolbar">
            <div>
              <h2>{historyTitle}</h2>
              <span title={historySubtitle}>{historySubtitle}</span>
            </div>
            {historyResult?.record && (
              <button
                type="button"
                className="icon-button"
                aria-label="复制真实 Git 命令"
                title="复制真实 Git 命令"
                onClick={() => navigator.clipboard?.writeText(historyResult.record?.displayCommand || "")}
              >
                <Copy size={15} aria-hidden="true" />
              </button>
            )}
            {historyResult && (
              <button
                type="button"
                className="secondary-action"
                aria-label="返回提交列表"
                title="返回提交列表"
                onClick={dismissResult}
              >
                返回列表
              </button>
            )}
          </div>
          <div className="main-content"><div className="history-notice" role="status" aria-live="polite">{historyNotice}</div>
            <div className="history-view">
              {historyResult ? (
                <HistoryResult result={historyResult} onBack={dismissResult} />
              ) : (
                <div className="history-browser">
                  {!historyFile && (
                    <>
                      <HistorySearch
                        value={historyDraft.keyword}
                        onChange={(keyword) => updateDraft("keyword", keyword)}
                        onSubmit={() => applyHistoryFilters()}
                        inputRef={historySearchRef}
                        total={commits.length}
                        shortcut={historySearchShortcut}
                        loading={loading}
                      />
                      {historyApplied && <p className="history-filter-summary" aria-live="polite">已应用：{historyApplied.keyword && <code>关键词：{historyApplied.keyword}</code>}{historyApplied.author && <code>作者：{historyApplied.author}</code>}{historyApplied.branch && <code>分支：{historyApplied.branch}</code>}{historyApplied.filePath && <code>文件：{historyApplied.filePath}</code>}</p>}
                    </>
                  )}
                  <div className="commit-list">
                    {!repo ? (
                      <div className="history-empty"><p>打开仓库后可查看提交历史。</p></div>
                    ) : loading && !commits.length && !historyFile ? (
                      <div className="history-empty"><p>正在读取提交历史…</p></div>
                    ) : historyFile ? (
                      (historyFile.entries || []).length ? (
                        historyFile.entries.map((entry) => (
                          <CommitRow
                            key={entry.hash}
                            commit={entry}
                            selected={false}
                            onSelect={() => openFileEntryDiff(entry)}
                            busy={loading}
                          />
                        ))
                      ) : (
                        <div className="history-empty">
                          <p>此文件没有可读取的历史提交。</p>
                          {historyFile.reason && <span>{historyFile.reason}</span>}
                        </div>
                      )
                    ) : !commits.length && historyApplied ? (
                      <div className="history-empty">
                        <MagnifyingGlass size={22} aria-hidden="true" />
                        <p>当前筛选条件下没有匹配的提交。</p>
                        <span>可以调整条件后再次应用，或重置筛选查看最近提交。</span>
                        <button type="button" className="secondary-action" onClick={() => applyHistoryFilters(undefined, true)} disabled={loading}>
                          重置筛选
                        </button>
                      </div>
                    ) : commitsReason ? (
                      <div className="history-empty"><p>{commitsReason}</p></div>
                    ) : (
                      commits.map((commit) => (
                        <CommitRow
                          key={commit.hash}
                          commit={commit}
                          selected={historySelected?.hash === commit.hash}
                          compareRole={
                            historyCompare.base?.hash === commit.hash
                              ? "base"
                              : historyCompare.target?.hash === commit.hash
                                ? "target"
                                : null
                          }
                          onSelect={() => selectHistoryCommit(commit)}
                          onCompare={() => pinCompare(commit)}
                          busy={loading}
                        />
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
        <PanelSplitter side="right" value={panelWidths.right} limits={getPanelLimits("right")} onPointerDown={startPanelResize} onDoubleClick={resetPanelWidth} onKeyDown={resizePanelWithKeyboard} />
        <aside className="context-panel">
          {historyFile ? (
            <div className="inspector-flow">
              <div className="inspector-heading"><span>文件历史</span><h2 title={historyFile.path}>{historyFile.path}</h2></div>
              <p className="inspector-copy">点击左侧列表中的提交，可查看该文件在对应提交中的真实 Diff。</p>
              <button type="button" className="text-action" onClick={dismissResult}>
                返回提交详情
              </button>
            </div>
          ) : historySelected ? (
            <div className="inspector-flow">
              <div className="inspector-heading"><span>提交详情</span><h2 title={detailSubject}>{detailSubject}</h2></div>
              <dl className="file-facts">
                <div>
                  <dt>完整 SHA</dt>
                  <dd>
                    <code title={historySelected.hash}>{historySelected.hash}</code>
                    <CopyButton value={historySelected.hash} label="复制完整 SHA" />
                  </dd>
                </div>
                <div>
                  <dt>父提交</dt>
                  <dd className="parent-list">
                    {historySelected.parents?.length ? (
                      historySelected.parents.map((parent) => (
                        <button
                          type="button"
                          className="parent-link"
                          key={parent}
                          title={`查看父提交 ${parent}`}
                          aria-label={`查看父提交 ${parent}`}
                          onClick={() => viewParentCommit(parent)}
                        >
                          <code>{parent.slice(0, 7)}</code>
                        </button>
                      ))
                    ) : (
                      <span className="initial-commit">初始提交（没有父提交）</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>作者</dt>
                  <dd title={detailAuthor}>{detailAuthor || "—"}</dd>
                </div>
                <div>
                  <dt>邮箱</dt>
                  <dd title={detailEmail}>{detailEmail || "—"}</dd>
                </div>
                <div>
                  <dt>时间</dt>
                  <dd className="commit-time">
                    <span>{relativeTime(detailTime)}</span>
                    <span className="full-time" title={fullLocalTime(detailTime)}>{fullLocalTime(detailTime)}</span>
                  </dd>
                </div>
              </dl>
              <div className="commit-stats" aria-label="变更统计">
                <span className="stat-chip">变更文件 {historyDetail?.filesChanged ?? 0}</span>
                <span className="stat-chip added">新增 +{historyDetail?.insertions ?? 0}</span>
                <span className="stat-chip deleted">删除 −{historyDetail?.deletions ?? 0}</span>
              </div>
              <div className="commit-message-block">
                <span className="section-label">完整提交说明</span>
                <pre className="commit-message">{historyDetail?.message || detailSubject}</pre>
              </div>
              <button type="button" className="secondary-button" onClick={readHistoryDiff} disabled={loading}>
                查看完整 Diff
              </button>
              <section className="history-files">
                <h3>改动文件</h3>
                {historyDetail?.changedFiles?.length ? (
                  historyDetail.changedFiles.map((file) => {
                    const kind = changeOf(file.status);
                    return (
                      <div className="history-file-row" key={`${file.status}-${file.path}`}>
                        <button
                          type="button"
                          className="history-file"
                          title={`查看 ${file.path} 在此提交中的 Diff`}
                          onClick={() => openCommitFileDiff(file)}
                          disabled={loading}
                        >
                          <span className={`file-kind-tag ${kind}`}>
                            {changeKindLetter[kind]} {titleFor[kind]}
                          </span>
                          <code>{file.path}</code>
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`查看 ${file.path} 的文件历史`}
                          title={`查看 ${file.path} 的文件历史`}
                          onClick={() => openFileHistory(file.path)}
                          disabled={loading}
                        >
                          <GitCommit size={14} aria-hidden="true" />
                        </button>
                      </div>
                    );
                  })
                ) : (
                  <p className="inspector-copy">{loading ? "正在读取改动文件…" : "没有读取到改动文件。"}</p>
                )}
              </section>
            </div>
          ) : (
            <div className="inspector-flow">
              <h2>选择一个提交</h2>
              <p className="inspector-copy">这是只读审阅，不会切换分支或改写工作区。选中提交后可查看详情、文件 Diff，并可将两个提交加入比较。</p>
            </div>
          )}
        </aside>
      </div> : <div ref={workspaceRef} id="workspace-main" className="workspace" style={{ "--left-panel-width": `${panelWidths.left}px`, "--right-panel-width": `${panelWidths.right}px` }} tabIndex="-1">
        <aside className="status-panel">
          <div className="panel-heading">
            <h2>工作区</h2>
          </div>
          {repo ? (
            <>
              <FileSection
                title="未暂存改动"
                files={unstaged}
                emptyText={state.files.length ? "没有未暂存的改动。" : "工作区干净，没有待暂存的改动。"}
                selected={selected}
                onSelect={loadDiff}
                onStage={(file) => operate("stage", { path: file.path })}
                toolbar={
                  <BatchStageToolbar
                    total={unstaged.length}
                    count={checkedCount}
                    loading={loading}
                    onSelectAll={selectAllUnstaged}
                    onClear={clearStageSelection}
                    onStageSelected={() =>
                      operate("stageSelected", {
                        paths: checkedForStaging.map((file) => file.path),
                      })
                    }
                  />
                }
                checkable
                isChecked={(file) =>
                  stageSelection.has(stageSelectionKey(file.area, file.path))
                }
                onToggleCheck={toggleStageSelection}
                busy={loading}
              />
              <FileSection
                title="已暂存改动"
                files={staged}
                emptyText="没有已暂存的改动。"
                selected={selected}
                onSelect={loadDiff}
                onStage={(file) => operate("unstage", { path: file.path })}
                busy={loading}
              />
              {!state.files.length && (
                <div className="clean-state">
                  <CheckCircle size={17} weight="fill" />
                  工作区干净，没有待暂存的改动。
                </div>
              )}
              <section className="branch-list">
                <div className="section-label">
                  <span>本地分支</span>
                  <b>{branches.length}</b>
                </div>
                {branches.map((branch) => {
                  const current =
                    branchName(branch) === state.branch || branch.current;
                  return (
                    <div className="branch-item" key={branchName(branch)}>
                      <button
                        type="button"
                        className={`branch-row ${current ? "current" : ""}`}
                        onClick={() => requestSwitch(branch)}
                        disabled={loading}
                      >
                        <GitBranch size={14} />
                        <code>{branchName(branch)}</code>
                        {current && <span>当前</span>}
                      </button>
                      {!current && (
                        <button
                          type="button"
                          className="branch-delete"
                          aria-label={`删除已合并分支 ${branchName(branch)}`}
                          title="删除已合并分支"
                          onClick={() =>
                            requestDeleteMergedBranch(branchName(branch))
                          }
                          disabled={loading}
                        >
                          <Trash size={14} />
                        </button>
                      )}
                    </div>
                  );
                })}
                <div className="branch-create">
                  <input
                    name="branch-name"
                    autoComplete="off"
                    value={newBranch}
                    onChange={(event) => setNewBranch(event.target.value)}
                    placeholder="新分支名称"
                    aria-label="新分支名称"
                  />
                  <button
                    type="button"
                    className="secondary-action"
                    disabled={!newBranch.trim() || loading}
                    onClick={() => requestSwitch(newBranch, true)}
                  >
                    创建
                  </button>
                </div>
              </section>
              <SidebarRemote
                remote={remote}
                files={state.files}
                loading={loading}
                onFetch={fetchRemote}
                onPush={pushRemote}
                onPull={pullRemote}
              />
            </>
          ) : (
            <div className="empty-repo">
              <FolderOpen size={24} />
              <p>打开本地 Git 仓库</p>
              <span>查看改动、历史与真实命令记录。</span>
              <button
                type="button"
                className="primary-button"
                onClick={chooseRepo}
                disabled={loading}
              >
                打开仓库
              </button>
            </div>
          )}
        </aside>
        <PanelSplitter side="left" value={panelWidths.left} limits={getPanelLimits("left")} onPointerDown={startPanelResize} onDoubleClick={resetPanelWidth} onKeyDown={resizePanelWithKeyboard} />
        <section className="main-panel">
          {/* 中央只保留一条标题：面包屑承载路径，右侧是「未暂存 / 已暂存差异」与文件状态。
              「文件差异」作为可访问标题保留给读屏，不再重复显示在视觉层。 */}
          <div className="main-toolbar diff-title">
            <h2 className="visually-hidden">文件差异</h2>
            {selected ? (
              <>
                <PathBreadcrumb path={selected.path} className="diff-title-path" />
                <div className="diff-title-meta">
                  <span className={selected.area === "staged" ? "staged-diff-label" : ""}>
                    {selected.area === "staged" ? "已暂存差异" : "未暂存差异"}
                  </span>
                  <span className={`file-kind ${selected.status}`}>
                    {titleFor[selected.status]}
                  </span>
                </div>
              </>
            ) : (
              <span className="diff-title-empty">未选择文件</span>
            )}
          </div>
          {selected ? (
            <div className="diff-view">
              {diffMessage ? (
                <div className="diff-empty" role="status" aria-live="polite">
                  <p>{diffMessage}</p>
                </div>
              ) : (
                <DiffContent diff={diff} titlePath={selected.path} hunkActions={hunkActions} />
              )}
            </div>
          ) : (
            <WorkspaceEmptyState hasChanges={staged.length + unstaged.length > 0} />
          )}
        </section>
        <PanelSplitter side="right" value={panelWidths.right} limits={getPanelLimits("right")} onPointerDown={startPanelResize} onDoubleClick={resetPanelWidth} onKeyDown={resizePanelWithKeyboard} />
        <aside className="context-panel">{inspector}</aside>
      </div>}
      <CommandLedger
        open={ledgerOpen}
        onToggle={toggleLedger}
        onOpen={openLedgerAt}
        latestRecord={glanceRecord}
        filter={ledgerFilter}
        onFilter={changeLedgerFilter}
        counts={ledgerCounts}
        totalRecords={records.length}
        groups={ledgerGroups}
        shortcut={ledgerShortcut}
      />
      {updates.open && (
        <UpdateDialog
          updates={updates}
          blockedReason={loading ? "Git 操作尚未完成，请完成后再更新。" : modalOpen ? "请先完成或关闭当前操作。" : ""}
          onInstall={() => updates.install({ commitMessage: message, historyMode })}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          commands={paletteCommands}
          platform={shortcutPlatform}
          onClose={closeCommandPalette}
          onExecute={executePaletteCommand}
        />
      )}
    </main>
  );
}

// 生产环境里 index.html 一定有 #root；import 时的守卫只是让测试可以直接 import
// 本模块（挂载到自己的容器里），不会顺带渲染一个真实应用的第二个实例。
const rootElement = document.getElementById("root");
if (rootElement) createRoot(rootElement).render(<App />);
