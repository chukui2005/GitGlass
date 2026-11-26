import { useEffect, useMemo, useRef, useState } from "react";
import { emptyHistoryFilters, resolveHistoryEscape, sameHistoryFilters } from "./history-filter-state.js";
import { orderComparePair } from "./history-search.js";
import { layoutHistoryGraph } from "./history-graph.js";
import { refKindLabel } from "./history-refs.js";

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
 * @property {boolean} [ok]
 * @property {string} [reason]
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
 * @property {(filters: HistoryFilters) => Promise<{ commits?: HistoryCommit[], reason?: string, limit?: number }>} queryHistory
 * @property {() => Promise<{ commits?: HistoryCommit[], reason?: string, limit?: number }>} getCommits
 * @property {() => Promise<{ ok?: boolean, refs?: Array<Record<string, unknown>>, head?: Record<string, unknown> | null, truncated?: boolean, reason?: string }>} getRefs
 * @property {(hash: string) => Promise<{ ok?: boolean, commit?: HistoryCommit | null, reason?: string }>} getCommit
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
  const [listLimit, setListLimit] = useState(80);
  const [listTruncated, setListTruncated] = useState(false);
  const [refs, setRefs] = useState(/** @type {Array<Record<string, unknown>>} */ ([]));
  const [refsHead, setRefsHead] = useState(/** @type {Record<string, unknown> | null} */ (null));
  const [refsReason, setRefsReason] = useState("");
  const [refsTruncated, setRefsTruncated] = useState(false);
  const [refsLoading, setRefsLoading] = useState(false);
  const [refNotice, setRefNotice] = useState("");
  const searchRef = useRef(null);
  // 查询序号：只有最新一次查询的响应能落地（快速连点两次「应用筛选」时旧响应会被丢弃）。
  const querySequence = useRef(0);
  // Refs and commit selection have independent cancellation tokens. A response
  // that arrives after a repo switch or a newer ref click is discarded.
  const refsSequence = useRef(0);
  const selectionSequence = useRef(0);
  // Detail, Diff, file-history and comparison reads all belong to the current
  // selection. Selection changes and newer view requests advance this token, so
  // a late response can still refresh the ledger but cannot overwrite the view.
  const viewSequence = useRef(0);
  // An explicitly selected ref target may live outside the current page. A
  // background refresh of the same filters must not clear that selection merely
  // because the commit is not in the refreshed list.
  const outsideSelection = useRef("");
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
  function applyQueryResult(nextResult, { preserveOutsideSelection = false } = {}) {
    const nextCommits = nextResult?.commits || [];
    const hashes = new Set(nextCommits.map((commit) => commit.hash));
    setCommits(nextCommits);
    setCommitsReason(nextResult?.reason || "");
    if (Number.isSafeInteger(nextResult?.limit) && nextResult.limit > 0) setListLimit(nextResult.limit);
    setListTruncated(nextResult?.truncated === true);
    if (!preserveOutsideSelection) outsideSelection.current = "";
    const keepExplicitOutside = preserveOutsideSelection && selected && outsideSelection.current === selected.hash;
    if (!keepExplicitOutside) setRefNotice("");
    if (selected && !hashes.has(selected.hash) && !keepExplicitOutside) {
      selectionSequence.current += 1;
      viewSequence.current += 1;
      outsideSelection.current = "";
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
    applyQueryResult(nextResult, { preserveOutsideSelection: true });
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

  /**
   * Read refs for the current repository. The sequence guard covers two cases
   * the UI can produce quickly: switching repositories, and switching between
   * two history modes before the first read returns.
   */
  async function refreshRefs() {
    const sequence = ++refsSequence.current;
    setRefsLoading(true);
    try {
      const result = await gitglass.getRefs();
      if (sequence !== refsSequence.current) return false;
      setRefs(Array.isArray(result?.refs) ? result.refs : []);
      setRefsHead(result?.head || null);
      setRefsTruncated(result?.truncated === true);
      setRefsReason(result?.ok === false ? result.reason || "无法读取 Git 引用，请刷新后重试。" : result?.reason || "");
      return true;
    } catch {
      if (sequence !== refsSequence.current) return false;
      setRefs([]);
      setRefsHead(null);
      setRefsTruncated(false);
      setRefsReason("无法读取 Git 引用，请刷新后重试。");
      return false;
    } finally {
      if (sequence === refsSequence.current) setRefsLoading(false);
    }
  }

  /** 选中一个提交：命中缓存就直接显示，否则读详情并写缓存。 */
  async function selectCommit(commit, { notice = "" } = {}) {
    if (!commit) return;
    const token = ++selectionSequence.current;
    viewSequence.current += 1;
    outsideSelection.current = "";
    setRefNotice(notice);
    if (selected?.hash === commit.hash && detail) {
      setFile(null);
      setResult(null);
      // This selection cancels any older detail/Diff loading that may still be
      // owned by the previous request.
      setLoading(false);
      return;
    }
    setSelected(commit);
    setFile(null);
    setResult(null);
    const cached = detailCache.current.get(commit.hash);
    if (cached) {
      setDetail(cached);
      // Example: return to a cached list commit while an out-of-page ref read
      // is still pending. The newer selection owns the loading flag now.
      setLoading(false);
      return;
    }
    setLoading(true);
    setDetail(null);
    try {
      const nextDetail = await gitglass.getCommitDetail(commit.hash);
      // A newer row/ref selection or a repository switch owns the view now.
      if (token !== selectionSequence.current) return;
      detailCache.current.set(commit.hash, nextDetail);
      setDetail(nextDetail);
      await refreshLedger();
    } catch {
      if (token === selectionSequence.current) setRefNotice("读取提交详情失败，请刷新后重试。");
    } finally {
      if (token === selectionSequence.current) setLoading(false);
    }
  }

  /**
   * Navigate from a ref to its commit. If the target is outside the current
   * page, read it by full id; the placeholder gives immediate feedback while
   * the authoritative summary and detail arrive.
   */
  async function selectRef(ref) {
    if (!ref) return;
    const label = refKindLabel(ref);
    if (!ref.commit) {
      setRefNotice(ref.status || `无法从${label}「${ref.shortName || ref.fullName}」解析到提交。`);
      return;
    }
    const known = commits.find((entry) => entry.hash === ref.commit);
    if (known) {
      await selectCommit(known, {
        notice: `已从${label}「${ref.shortName || ref.fullName}」定位到当前列表中的提交 ${known.shortHash || ref.commit.slice(0, 7)}。`,
      });
      return;
    }

    const token = ++selectionSequence.current;
    viewSequence.current += 1;
    outsideSelection.current = ref.commit;
    const shortHash = ref.commit.slice(0, 7);
    setSelected({
      hash: ref.commit,
      shortHash,
      subject: `正在读取${label}「${ref.shortName || ref.fullName}」指向的提交…`,
      parents: [],
      author: "",
      authoredAt: "",
      refs: [],
    });
    setDetail(null);
    setFile(null);
    setResult(null);
    setRefNotice(`提交 ${shortHash} 不在当前列表，正在按完整 ID 读取…`);
    setLoading(true);
    try {
      const result = await gitglass.getCommit(ref.commit);
      if (token !== selectionSequence.current) return;
      if (!result?.ok || !result.commit) {
        outsideSelection.current = "";
        setSelected(null);
        setRefNotice(result?.reason || "无法按完整 ID 读取该提交，请刷新引用后重试。");
        return;
      }
      const commit = result.commit;
      setSelected(commit);
      setRefNotice(`引用「${ref.shortName || ref.fullName}」指向的提交不在当前列表，已按完整 ID ${shortHash} 读取并选中。`);
      const cached = detailCache.current.get(commit.hash);
      if (cached) {
        setDetail(cached);
      } else {
        const nextDetail = await gitglass.getCommitDetail(commit.hash);
        if (token !== selectionSequence.current) return;
        detailCache.current.set(commit.hash, nextDetail);
        setDetail(nextDetail);
        if (nextDetail?.ok === false) {
          setRefNotice(`已按完整 ID 选中提交 ${shortHash}，但提交详情读取失败：${nextDetail.reason || "请刷新后重试。"}`);
        }
      }
      await refreshLedger();
    } catch {
      if (token === selectionSequence.current) {
        outsideSelection.current = "";
        setSelected(null);
        setRefNotice("读取引用指向的提交失败，请刷新引用后重试。");
      }
    } finally {
      if (token === selectionSequence.current) setLoading(false);
    }
  }

  // Refs follow the repository and history mode. External ref changes arrive
  // through App's refreshAll(), which calls refreshRefs() as well.
  useEffect(() => {
    if (!mode || !repo) {
      refsSequence.current += 1;
      setRefs([]);
      setRefsHead(null);
      setRefsTruncated(false);
      setRefsReason("");
      setRefsLoading(false);
      setRefNotice("");
      return;
    }
    refreshRefs();
    // refreshRefs owns its sequence guard; repo/mode are the actual inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, repo]);

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
    const token = ++viewSequence.current;
    const commit = selected;
    setLoading(true);
    try {
      const nextResult = await gitglass.getCommitDiff(commit.hash);
      // The ledger records the real read even when the user has already moved
      // on, but only the current view may render the response.
      await refreshLedger();
      if (token !== viewSequence.current) return;
      setResult({ ...nextResult, kind: "commit" });
    } finally {
      if (token === viewSequence.current) setLoading(false);
    }
  }

  /** 提交详情里点某个文件：读该文件在这条提交里的 Diff。 */
  async function openCommitFileDiff(fileEntry) {
    if (!selected || !fileEntry) return;
    const token = ++viewSequence.current;
    const commit = selected;
    setLoading(true);
    try {
      const nextResult = await gitglass.getFileHistoryDiff(commit.hash, fileEntry.path);
      await refreshLedger();
      if (token !== viewSequence.current) return;
      setResult({
        ...nextResult,
        kind: "file",
        path: fileEntry.path,
        shortHash: commit.shortHash,
      });
    } finally {
      if (token === viewSequence.current) setLoading(false);
    }
  }

  /** 文件历史里点某条提交：读该文件在对应提交里的 Diff。 */
  async function openFileEntryDiff(commit) {
    if (!file || !commit) return;
    const token = ++viewSequence.current;
    const filePath = file.path;
    setLoading(true);
    try {
      const nextResult = await gitglass.getFileHistoryDiff(commit.hash, filePath);
      await refreshLedger();
      if (token !== viewSequence.current) return;
      setResult({
        ...nextResult,
        kind: "file",
        path: filePath,
        shortHash: commit.shortHash,
      });
    } finally {
      if (token === viewSequence.current) setLoading(false);
    }
  }

  async function openFileHistory(path) {
    const token = ++viewSequence.current;
    setLoading(true);
    try {
      const nextFile = await gitglass.getFileHistory(path);
      await refreshLedger();
      if (token !== viewSequence.current) return;
      setFile(nextFile);
      setResult(null);
    } finally {
      if (token === viewSequence.current) setLoading(false);
    }
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
    const token = ++viewSequence.current;
    setLoading(true);
    try {
      const nextResult = await gitglass.compareCommits(base.hash, target.hash);
      await refreshLedger();
      if (token !== viewSequence.current) return;
      setResult({
        ...nextResult,
        kind: "compare",
        baseShort: base.shortHash,
        targetShort: target.shortHash,
      });
    } finally {
      if (token === viewSequence.current) setLoading(false);
    }
  }

  /** 「返回列表」/「返回提交详情」：丢掉当前 Diff 结果与文件历史。 */
  function dismissResult() {
    // A pending Diff read belongs to the view being dismissed; it must not
    // pop back after the user has returned to the list.
    viewSequence.current += 1;
    setResult(null);
    setFile(null);
    setLoading(false);
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
    setListTruncated(false);
    setRefs([]);
    setRefsHead(null);
    setRefsTruncated(false);
    setRefsReason("");
    setRefsLoading(false);
    setRefNotice("");
    refsSequence.current += 1;
    selectionSequence.current += 1;
    viewSequence.current += 1;
    outsideSelection.current = "";
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
    setListTruncated(false);
    setRefs([]);
    setRefsHead(null);
    setRefsTruncated(false);
    setRefsReason("");
    setRefsLoading(false);
    setRefNotice("");
    refsSequence.current += 1;
    selectionSequence.current += 1;
    viewSequence.current += 1;
    outsideSelection.current = "";
  }

  // 图只使用 Git 返回的真实 parents；文件筛选会触发历史简化，因此保持列表。
  const graphAvailable = !applied?.filePath;
  const historyGraph = useMemo(
    () => layoutHistoryGraph(commits, { limit: listLimit, truncated: listTruncated }),
    [commits, listLimit, listTruncated],
  );
  const historyGraphRows = useMemo(
    () => new Map(historyGraph.rows.map((row) => [row.hash, row])),
    [historyGraph],
  );
  const selectedOutsideList = Boolean(selected && !commits.some((commit) => commit.hash === selected.hash));

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
    listLimit,
    refs,
    refsHead,
    refsReason,
    refsTruncated,
    refsLoading,
    refNotice,
    historyGraph,
    historyGraphRows,
    graphAvailable,
    selectedOutsideList,
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
    selectHistoryRef: selectRef,
    refreshHistoryRefs: refreshRefs,
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
