import { useRef, useState } from "react";
import { emptyHistoryFilters, resolveHistoryEscape, sameHistoryFilters } from "./history-filter-state.js";
import { orderComparePair } from "./history-search.js";

// 历史审查领域：筛选（草稿 / 已应用）、提交查询序号、提交选择与详情缓存、
// 双提交比较、文件历史与 Diff。`App` 只负责把它接到 JSX 上。
//
// 这里刻意不碰 `window`：IPC 桥由调用方以 `gitglass` 传入（App 传
// `window.gitglass`，测试传假桥），所以 hook 自身可以用纯对象单测。

/**
 * 历史筛选条件。
 * @typedef {object} HistoryFilters
 * @property {string} keyword
 * @property {string} author
 * @property {string} branch
 * @property {string} filePath
 */

/**
 * 提交列表里的一条（`parseCommits` 的输出）。
 * @typedef {object} HistoryCommit
 * @property {string} hash
 * @property {string} [shortHash]
 * @property {string[]} [parents]
 * @property {string} subject
 * @property {string} [author]
 * @property {string} [authoredAt]
 * @property {string[]} [refs]
 */

/**
 * 提交详情（`getCommitDetail` 的输出里界面要用的字段）。
 * @typedef {object} HistoryDetail
 * @property {string} [subject]
 * @property {string} [message]
 * @property {string} [authorName]
 * @property {string} [authorEmail]
 * @property {string} [authoredAt]
 * @property {number} [filesChanged]
 * @property {number} [insertions]
 * @property {number} [deletions]
 * @property {{ status: string, path: string }[]} [changedFiles]
 */

/**
 * Diff / 比较结果（`getCommitDiff` / `compareCommits` / `getFileHistoryDiff`）。
 * @typedef {object} HistoryDiffResult
 * @property {string} [kind] commit | file | compare，由 hook 补上
 * @property {boolean} [ok]
 * @property {boolean} [binary]
 * @property {boolean} [truncated]
 * @property {string} [diff]
 * @property {string} [reason]
 * @property {string} [suggestion]
 * @property {string} [path]
 * @property {string} [shortHash]
 * @property {string} [baseShort]
 * @property {string} [targetShort]
 * @property {{ displayCommand?: string }} [record]
 */

/**
 * 文件历史列表（`getFileHistory`）。
 * @typedef {object} HistoryFileState
 * @property {string} [path]
 * @property {HistoryCommit[]} [entries]
 * @property {string} [reason]
 */

/**
 * 双提交比较的两端；顺序由 `orderComparePair` 决定（base 总是较早的提交）。
 * @typedef {object} ComparePair
 * @property {HistoryCommit | null} base
 * @property {HistoryCommit | null} target
 */

/**
 * `useHistoryReview` 依赖的 IPC 子集（`electron/preload.cjs` 暴露）。
 * @typedef {object} HistoryIpc
 * @property {(filters: HistoryFilters) => Promise<{ commits?: HistoryCommit[], reason?: string }>} queryHistory
 * @property {() => Promise<{ commits?: HistoryCommit[], reason?: string }>} getCommits
 * @property {(hash: string) => Promise<HistoryDetail>} getCommitDetail
 * @property {(hash: string) => Promise<HistoryDiffResult>} getCommitDiff
 * @property {(base: string, target: string) => Promise<HistoryDiffResult>} compareCommits
 * @property {(path: string) => Promise<HistoryFileState>} getFileHistory
 * @property {(hash: string, path: string) => Promise<HistoryDiffResult>} getFileHistoryDiff
 */

/**
 * @typedef {object} HistoryReviewOptions
 * @property {HistoryIpc} gitglass 渲染进程的 IPC 桥
 * @property {string | null} repo 当前仓库路径；没有仓库时筛选/比较入口保持关闭
 * @property {boolean} loading 任何 Git 操作进行中都为 true（这些函数会自己开关它）
 * @property {(value: boolean) => void} setLoading
 * @property {(cycle?: string) => Promise<void>} refreshLedger 每次读取后刷新命令账本
 */

/**
 * 历史审查的全部状态与动作。
 * 返回值沿用 `App` 里的变量名，便于把 JSX 原样接过来。
 * @param {HistoryReviewOptions} options
 */
export function useHistoryReview({ gitglass, repo, loading, setLoading, refreshLedger }) {
  const [mode, setMode] = useState(false);
  const [selected, setSelected] = useState(/** @type {HistoryCommit | null} */ (null));
  const [detail, setDetail] = useState(/** @type {HistoryDetail | null} */ (null));
  const [result, setResult] = useState(/** @type {HistoryDiffResult | null} */ (null));
  const [file, setFile] = useState(/** @type {HistoryFileState | null} */ (null));
  const [compare, setCompare] = useState(/** @type {ComparePair} */ ({ base: null, target: null }));
  const [draft, setDraft] = useState(/** @type {HistoryFilters} */ (emptyHistoryFilters));
  const [applied, setApplied] = useState(/** @type {HistoryFilters | null} */ (null));
  const [commits, setCommits] = useState(/** @type {HistoryCommit[]} */ ([]));
  const [commitsReason, setCommitsReason] = useState("");
  const searchRef = useRef(null);
  // 查询序号：只有最新一次查询的响应能落地（快速连点两次「应用筛选」时旧响应会被丢弃）。
  const querySequence = useRef(0);
  // 提交详情按 SHA 缓存：再次查看同一个提交不再执行 Git 命令。
  const detailCache = useRef(new Map());

  const filtersDirty = !sameHistoryFilters(draft, applied || emptyHistoryFilters);

  const updateDraft = (field, value) =>
    setDraft((current) => ({ ...current, [field]: value }));

  /** 「使用当前选中文件」：只填草稿，不发查询。 */
  const applySelectedFile = (fileEntry) => {
    if (!fileEntry) return;
    setDraft((current) => ({ ...current, filePath: fileEntry.path }));
  };

  /** 查询结果落地：提交列表、原因，并把已失效的选中 / 比较端点收掉。 */
  function applyQueryResult(nextResult) {
    const nextCommits = nextResult?.commits || [];
    const hashes = new Set(nextCommits.map((commit) => commit.hash));
    setCommits(nextCommits);
    setCommitsReason(nextResult?.reason || "");
    if (selected && !hashes.has(selected.hash)) {
      setSelected(null);
      setDetail(null);
      setResult(null);
      setFile(null);
    }
    setCompare((previous) => ({
      base: previous.base && hashes.has(previous.base.hash) ? previous.base : null,
      target: previous.target && hashes.has(previous.target.hash) ? previous.target : null,
    }));
    detailCache.current.clear();
  }

  /**
   * 取一个新的查询序号。`App` 的整体刷新与「应用筛选」共用同一个计数器：
   * 谁后发起谁生效，先发起的旧响应必须丢弃。
   * @returns {number}
   */
  function beginQuery() {
    return ++querySequence.current;
  }

  /**
   * 只在序号仍是最新时落地结果。
   * @param {number} token `beginQuery()` 的返回值
   * @param {{ commits?: HistoryCommit[], reason?: string }} nextResult
   * @returns {boolean} 是否被采纳
   */
  function applyQueryResultIfCurrent(token, nextResult) {
    if (token !== querySequence.current) return false;
    applyQueryResult(nextResult);
    return true;
  }

  /** 「应用筛选」/「重置」：一次服务端查询，带序号防串台。 */
  async function applyFilters(next = draft, reset = false) {
    if (loading || !repo) return;
    const filters = reset ? emptyHistoryFilters : { ...next };
    setLoading(true);
    const sequence = beginQuery();
    try {
      const nextResult = reset ? await gitglass.getCommits() : await gitglass.queryHistory(filters);
      if (sequence !== querySequence.current) return;
      setApplied(reset ? null : filters);
      setDraft(filters);
      applyQueryResult(nextResult);
      await refreshLedger();
    } finally {
      if (sequence === querySequence.current) setLoading(false);
    }
  }

  /** 选中一个提交：命中缓存就直接显示，否则读详情并写缓存。 */
  async function selectCommit(commit) {
    if (!commit) return;
    if (selected?.hash === commit.hash && detail) {
      setFile(null);
      setResult(null);
      return;
    }
    setSelected(commit);
    setFile(null);
    setResult(null);
    const cached = detailCache.current.get(commit.hash);
    if (cached) {
      setDetail(cached);
      return;
    }
    setLoading(true);
    setDetail(null);
    const nextDetail = await gitglass.getCommitDetail(commit.hash);
    detailCache.current.set(commit.hash, nextDetail);
    setDetail(nextDetail);
    await refreshLedger();
    setLoading(false);
  }

  /** 父提交可能是列表里没有的更早提交：先用占位对象选中，详情回来后再替换。 */
  function viewParentCommit(parentHash) {
    if (!parentHash) return;
    const known = commits.find((entry) => entry.hash === parentHash);
    selectCommit(
      known || {
        hash: parentHash,
        shortHash: parentHash.slice(0, 7),
        subject: "正在读取父提交…",
        parents: [],
        author: "",
        authoredAt: "",
        refs: [],
      },
    );
  }

  async function readHistoryDiff() {
    if (!selected) return;
    setLoading(true);
    const nextResult = await gitglass.getCommitDiff(selected.hash);
    setResult({ ...nextResult, kind: "commit" });
    await refreshLedger();
    setLoading(false);
  }

  /** 提交详情里点某个文件：读该文件在这条提交里的 Diff。 */
  async function openCommitFileDiff(fileEntry) {
    if (!selected || !fileEntry) return;
    setLoading(true);
    const nextResult = await gitglass.getFileHistoryDiff(selected.hash, fileEntry.path);
    setResult({
      ...nextResult,
      kind: "file",
      path: fileEntry.path,
      shortHash: selected.shortHash,
    });
    await refreshLedger();
    setLoading(false);
  }

  /** 文件历史里点某条提交：读该文件在对应提交里的 Diff。 */
  async function openFileEntryDiff(commit) {
    if (!file || !commit) return;
    setLoading(true);
    const nextResult = await gitglass.getFileHistoryDiff(commit.hash, file.path);
    setResult({
      ...nextResult,
      kind: "file",
      path: file.path,
      shortHash: commit.shortHash,
    });
    await refreshLedger();
    setLoading(false);
  }

  async function openFileHistory(path) {
    setLoading(true);
    const nextFile = await gitglass.getFileHistory(path);
    setFile(nextFile);
    setResult(null);
    await refreshLedger();
    setLoading(false);
  }

  /** 加入双提交比较：重复点同一个提交 = 取消；两个都选好后按时间排序。 */
  function pinCompare(commit) {
    setCompare((value) => {
      if (!value.base) return { base: commit, target: null };
      if (value.base.hash === commit.hash) return { base: null, target: null };
      if (value.target?.hash === commit.hash) return { ...value, target: null };
      if (value.target) return { base: commit, target: null };
      return orderComparePair(value.base, commit);
    });
  }

  function swapCompare() {
    setCompare((value) => ({ base: value.target, target: value.base }));
  }

  function clearCompare() {
    setCompare({ base: null, target: null });
  }

  async function readCompare() {
    const { base, target } = compare;
    if (!base || !target) return;
    setLoading(true);
    const nextResult = await gitglass.compareCommits(base.hash, target.hash);
    setResult({
      ...nextResult,
      kind: "compare",
      baseShort: base.shortHash,
      targetShort: target.shortHash,
    });
    await refreshLedger();
    setLoading(false);
  }

  /** 「返回列表」/「返回提交详情」：丢掉当前 Diff 结果与文件历史。 */
  function dismissResult() {
    setResult(null);
    setFile(null);
  }

  /**
   * Esc 在历史模式里的三段语义（见 history-filter-state.js）：
   * 先关掉 Diff 结果，再丢弃草稿改动，然后还原已应用的筛选，最后退出历史模式。
   * @returns {boolean} 是否消费了这次 Esc
   */
  function handleEscape() {
    if (result || file) {
      dismissResult();
      return true;
    }
    if (!mode) return false;
    const next = resolveHistoryEscape(draft, applied);
    if (next.kind === "discard-draft") setDraft(next.filters);
    else if (next.kind === "reset-applied") applyFilters(undefined, true);
    else setMode(false);
    return true;
  }

  /** 仓库上下文失效：连提交列表一起清掉。 */
  function resetAll() {
    setMode(false);
    setSelected(null);
    setDetail(null);
    setResult(null);
    setFile(null);
    setCompare({ base: null, target: null });
    setDraft(emptyHistoryFilters);
    setApplied(null);
    setCommits([]);
    setCommitsReason("");
    detailCache.current.clear();
  }

  /** 切换仓库：清掉审阅状态，提交列表由随后的 refresh 重新填充。 */
  function resetReview() {
    detailCache.current.clear();
    setSelected(null);
    setDetail(null);
    setResult(null);
    setFile(null);
    setCompare({ base: null, target: null });
    setDraft(emptyHistoryFilters);
    setApplied(null);
  }

  const detailSubject = detail?.subject || selected?.subject || "";
  const detailAuthor = detail?.authorName || selected?.author || "";
  const detailEmail = detail?.authorEmail || "";
  const detailTime = detail?.authoredAt || selected?.authoredAt || "";
  const title = file
    ? "文件历史"
    : result?.kind === "compare"
      ? "提交比较"
      : result?.kind === "file"
        ? "文件 Diff"
        : result
          ? "提交 Diff"
          : "提交历史";
  const subtitle = file
    ? file.path
    : result?.kind === "compare"
      ? `基准 ${result.baseShort} → 对比 ${result.targetShort}`
      : result?.kind === "file"
        ? `${result.path} @ ${result.shortHash}`
        : result
          ? selected?.subject || ""
          : selected?.subject || "选择提交以查看审阅详情";
  // 状态条一次只说一到两件事：读取中 / 截断 / 比较方向 / 二进制提示。
  // 比较方向与二进制提示彼此独立：一个 compare 结果里可能两者都成立。
  const direction =
    result?.kind === "compare" && result.ok
      ? `比较方向「基准 → 对比」：${result.baseShort} → ${result.targetShort}`
      : "";
  const binaryHint =
    result?.binary && result.ok
      ? "结果中包含二进制文件，Git 无法为它们生成文本 Diff。"
      : "";
  const notice = loading
    ? "正在读取历史…"
    : result?.truncated
      ? "Diff 已截断，可在命令账本复制真实命令后在终端查看完整输出。"
      : [direction, binaryHint].filter(Boolean).join(" ");

  return {
    // 状态（沿用 App 里的变量名）
    historyMode: mode,
    setHistoryMode: setMode,
    historySelected: selected,
    historyDetail: detail,
    historyResult: result,
    historyFile: file,
    historyCompare: compare,
    historyDraft: draft,
    historyApplied: applied,
    commits,
    commitsReason,
    historyFiltersDirty: filtersDirty,
    historySearchRef: searchRef,
    // 派生文案
    detailSubject,
    detailAuthor,
    detailEmail,
    detailTime,
    historyTitle: title,
    historySubtitle: subtitle,
    historyNotice: notice,
    // 动作
    updateDraft,
    applySelectedFile,
    applyHistoryFilters: applyFilters,
    applyQueryResult,
    beginQuery,
    applyQueryResultIfCurrent,
    selectHistoryCommit: selectCommit,
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
    resetAll,
    resetReview,
  };
}
