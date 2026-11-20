import { useState } from "react";
import { executionNotice } from "./user-notices.js";

// 计划类操作：撤销未暂存改动、删除已合并分支、从 reflog 建救援分支、切换/创建分支，
// 以及恢复中心（reflog 列表）。所有会改变仓库状态的入口都走「先 prepare 出计划，
// 用户在右栏确认后才 execute」两步，和以前完全一样——这里只是把状态从 `App` 搬出来。
//
// 远程计划的 prepare/confirm 与 overview 同属远程域，放在 use-remote-overview.js；
// 这里只保留本地仓库上下文的安全操作与分支切换。

/**
 * 分支条目可能是字符串（真实 IPC 返回 `{ name, current }`，旧路径也接受字符串）。
 * @param {string | { name: string }} branch
 * @returns {string}
 */
export const branchName = (branch) => (typeof branch === "string" ? branch : branch.name);

/**
 * 救援分支名：从 reflog 时间戳生成稳定且合法的分支名。
 * @param {ReflogEntry} entry
 * @returns {string}
 */
const rescueName = (entry) =>
  `rescue/${
    String(entry.occurredAt || "reflog")
      .replace(/[^0-9A-Za-z]+/g, "-")
      .replace(/^-+|-+$/g, "") || "reflog"
  }-${entry.shortHash}`;

/**
 * 「计划 → 执行」两步里第一步的返回值：主进程给的 plan 与可展示的命令。
 * @typedef {object} OperationPlan
 * @property {{ operationId?: string, displayCommand?: string }} [plan]
 * @property {boolean} [blocked] 计划被本地校验阻断
 * @property {string} [reason] 阻断原因（中文）
 * @property {{ operationId?: string, displayCommand?: string }} [execution]
 */

/**
 * @typedef {OperationPlan & { kind: "discard" | "delete-merged-branch" | "rescue-branch", path?: string, branch?: string, hash?: string, operationId?: string, displayCommand?: string }} SafetyPlan
 */

/**
 * @typedef {OperationPlan & { name: string, create: boolean, operationId?: string, displayCommand?: string }} BranchPlan
 */

/**
 * 「计划 → 执行」两步里第二步的返回值：真实命令的执行结果。
 * @typedef {object} ExecutionResult
 * @property {{ ok?: boolean, operationId?: string }} [execution]
 */

/**
 * reflog 里的一条可选恢复点。
 * @typedef {object} ReflogEntry
 * @property {string} hash
 * @property {string} [shortHash]
 * @property {string} [occurredAt]
 * @property {string} [subject]
 */

/**
 * `useSafetyPlans` 依赖的 IPC 子集。
 * @typedef {object} SafetyIpc
 * @property {(name: string, create: boolean) => Promise<OperationPlan>} prepareBranch
 * @property {(name: string, create: boolean, operationId: string) => Promise<ExecutionResult>} executeBranch
 * @property {(path: string) => Promise<OperationPlan>} prepareDiscard
 * @property {(branch: string) => Promise<OperationPlan>} prepareDeleteMergedBranch
 * @property {() => Promise<{ entries?: ReflogEntry[], reason?: string }>} getReflog
 * @property {(hash: string, branch: string) => Promise<OperationPlan>} prepareRescueBranch
 * @property {(path: string, operationId: string) => Promise<ExecutionResult>} executeDiscard
 * @property {(branch: string, operationId: string) => Promise<ExecutionResult>} executeDeleteMergedBranch
 * @property {(hash: string, branch: string, operationId: string) => Promise<ExecutionResult>} executeRescueBranch
 */

/**
 * @typedef {object} SafetyPlanOptions
 * @property {SafetyIpc} gitglass
 * @property {string} branch 当前分支名（切换分支的重复判断用）
 * @property {boolean} loading
 * @property {(value: boolean) => void} setLoading
 * @property {(cycle?: string) => Promise<void>} refreshLedger
 * @property {() => Promise<unknown>} refreshAll 执行成功后整体刷新
 * @property {(notice: { type: string, text: string }) => void} setNotice
 * @property {(tab?: "user" | "background") => void} presetLedger 预设命令账本筛选（不再自动弹出面板）
 * @property {(operationId: string | null) => void} setFocusedOperationId 账本聚焦到本次操作
 */

/**
 * 计划类操作的完整状态与动作。
 * 返回值沿用 `App` 里的变量名。
 * @param {SafetyPlanOptions} options
 */
export function useSafetyPlans({
  gitglass,
  branch,
  loading,
  setLoading,
  refreshLedger,
  refreshAll,
  setNotice,
  presetLedger,
  setFocusedOperationId,
}) {
  const [safetyPlan, setSafetyPlan] = useState(/** @type {SafetyPlan | null} */ (null));
  const [branchPlan, setBranchPlan] = useState(/** @type {BranchPlan | null} */ (null));
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [reflogEntries, setReflogEntries] = useState(/** @type {ReflogEntry[]} */ ([]));
  const [reflogReason, setReflogReason] = useState("");
  const [acknowledgement, setAcknowledgement] = useState("");

  /** 切换或创建分支：先拿计划，右栏进入确认态。 */
  async function requestSwitch(nextBranch, create = false) {
    if (loading) return;
    const name = create ? nextBranch.trim() : branchName(nextBranch);
    if (!name || (!create && (name === branch || nextBranch.current))) return;
    const prepared = await gitglass.prepareBranch(name, create);
    await refreshLedger();
    setBranchPlan(
      prepared.plan
        ? {
            name,
            create,
            ...prepared,
            operationId: prepared.plan.operationId,
            displayCommand: prepared.plan.displayCommand,
          }
        : { name, create, ...prepared, blocked: true },
    );
  }

  async function confirmBranch() {
    if (!branchPlan?.plan) return;
    setLoading(true);
    presetLedger();
    const result = await gitglass.executeBranch(branchPlan.name, branchPlan.create, branchPlan.operationId);
    setFocusedOperationId(result.execution?.operationId || branchPlan.operationId || null);
    setNotice(
      executionNotice(
        `已${branchPlan.create ? "创建并切换到" : "切换到"} ${branchPlan.name}。`,
        result.execution,
      ),
    );
    if (result.execution?.ok) setBranchPlan(null);
    await refreshAll();
    setLoading(false);
  }

  /** 丢弃某个文件的未暂存改动（不可撤销，需要先勾选确认）。 */
  async function requestDiscard(path) {
    setLoading(true);
    setAcknowledgement("");
    const prepared = await gitglass.prepareDiscard(path);
    await refreshLedger();
    setSafetyPlan(
      prepared.plan
        ? {
            ...prepared,
            kind: "discard",
            path,
            operationId: prepared.plan.operationId,
            displayCommand: prepared.plan.displayCommand,
          }
        : { ...prepared, kind: "discard", path, blocked: true },
    );
    setLoading(false);
  }

  async function requestDeleteMergedBranch(targetBranch) {
    if (loading) return;
    setLoading(true);
    const prepared = await gitglass.prepareDeleteMergedBranch(targetBranch);
    await refreshLedger();
    setSafetyPlan(
      prepared.plan
        ? {
            ...prepared,
            kind: "delete-merged-branch",
            branch: targetBranch,
            operationId: prepared.plan.operationId,
            displayCommand: prepared.plan.displayCommand,
          }
        : { ...prepared, kind: "delete-merged-branch", branch: targetBranch, blocked: true },
    );
    setLoading(false);
  }

  /** 打开恢复中心：读 reflog（只读）。 */
  async function openRecovery() {
    setLoading(true);
    const result = await gitglass.getReflog();
    setReflogEntries(result.entries || []);
    setReflogReason(result.reason || "");
    setRecoveryOpen(true);
    await refreshLedger();
    setLoading(false);
  }

  /** 从 reflog 建救援分支：先把恢复中心收起来，再进计划确认。 */
  async function requestRescue(entry) {
    setLoading(true);
    const rescue = rescueName(entry);
    const prepared = await gitglass.prepareRescueBranch(entry.hash, rescue);
    await refreshLedger();
    setRecoveryOpen(false);
    setSafetyPlan(
      prepared.plan
        ? {
            ...prepared,
            kind: "rescue-branch",
            branch: rescue,
            hash: entry.hash,
            operationId: prepared.plan.operationId,
            displayCommand: prepared.plan.displayCommand,
          }
        : {
            ...prepared,
            kind: "rescue-branch",
            branch: rescue,
            hash: entry.hash,
            blocked: true,
          },
    );
    setLoading(false);
  }

  /** 确认执行：三种安全操作各走一条真实 Git 命令，成功后整体刷新。 */
  async function confirmSafety() {
    if (!safetyPlan?.plan) return;
    setLoading(true);
    presetLedger("user");
    let result;
    if (safetyPlan.kind === "discard")
      result = await gitglass.executeDiscard(safetyPlan.path, safetyPlan.operationId);
    else if (safetyPlan.kind === "delete-merged-branch")
      result = await gitglass.executeDeleteMergedBranch(safetyPlan.branch, safetyPlan.operationId);
    else
      result = await gitglass.executeRescueBranch(
        safetyPlan.hash,
        safetyPlan.branch,
        safetyPlan.operationId,
      );
    setFocusedOperationId(result.execution?.operationId || safetyPlan.operationId || null);
    const safetySuccess =
      safetyPlan.kind === "discard"
        ? "已丢弃该文件的未暂存改动。"
        : safetyPlan.kind === "delete-merged-branch"
          ? `已删除分支 ${safetyPlan.branch}。`
          : `已创建救援分支 ${safetyPlan.branch}。`;
    setNotice(executionNotice(safetySuccess, result.execution));
    if (result.execution?.ok) setSafetyPlan(null);
    await refreshAll();
    setLoading(false);
  }

  return {
    // 状态 + 原始 setter（JSX 的 onCancel / onClose 直接复用）
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
    // 动作
    requestSwitch,
    confirmBranch,
    requestDiscard,
    requestDeleteMergedBranch,
    openRecovery,
    requestRescue,
    confirmSafety,
  };
}
