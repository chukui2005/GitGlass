import { useState } from "react";
import { executionNotice } from "./user-notices.js";

// 远程域：overview（远程列表 / 上游 / ahead-behind）、远程跟踪分支，以及四类「先预览，
// 再执行」的操作——fetch / push / pull、远程配置的添加与编辑、检出远程跟踪分支 /
// 设置上游、首次推送并设置上游。
//
// 所有计划都留在同一个 `remoteTask` 槽位里：右栏一次只显示一份计划，Esc 与「返回」
// 只有一条路径，主进程那边按 operationId 取出预览时记下的 argv 执行。

const CONFIG_ERROR = "无法预览这次远程配置修改，请查看命令账本。";
const BRANCH_ERROR = "无法预览这次分支操作，请查看命令账本。";

/** @param {unknown} value */
const asText = (value) => (typeof value === "string" ? value : "");

/**
 * @typedef {object} RemoteTask
 * @property {"config" | "checkout" | "set-upstream" | "first-push"} kind
 * @property {"add" | "set-url"} [mode]
 * @property {{ name: string, url: string }} [form]
 * @property {string} [remoteBranch]
 * @property {string} [localName]
 * @property {any} [plan]
 * @property {boolean} [blocked]
 * @property {string} [reason]
 * @property {any} [preview]
 */

/**
 * @typedef {object} RemoteOverviewOptions
 * @property {any} gitglass preload 暴露的桥；测试里换成假桥。
 * @property {string | null} repo
 * @property {boolean} loading
 * @property {(value: boolean) => void} setLoading
 * @property {(cycle?: string) => Promise<void>} refreshLedger
 * @property {() => Promise<unknown>} refreshAll
 * @property {(notice: { type: string, text: string }) => void} setNotice
 * @property {(tab?: "user" | "background") => void} presetLedger
 * @property {(operationId: string | null) => void} setFocusedOperationId
 */

/**
 * 远程状态与全部远程/上游入口。
 * @param {RemoteOverviewOptions} options
 */
export function useRemoteOverview({
  gitglass,
  repo,
  loading,
  setLoading,
  refreshLedger,
  refreshAll,
  setNotice,
  presetLedger,
  setFocusedOperationId,
}) {
  const [remote, setRemote] = useState(/** @type {any} */ (null));
  const [remoteBranches, setRemoteBranches] = useState(/** @type {any[]} */ ([]));
  const [remotePlan, setRemotePlan] = useState(/** @type {any} */ (null));
  const [remoteTask, setRemoteTask] = useState(/** @type {RemoteTask | null} */ (null));

  /** 直接写入一份 overview：整体刷新并行读完远程状态后经这里落地。 */
  const applyOverview = (next) => setRemote(next);

  /** 远程跟踪分支同样由整体刷新落地，列表永远来自 Git 的实际读取。 */
  const applyRemoteBranches = (next) => setRemoteBranches(Array.isArray(next) ? next : []);

  /** 「获取…」/「推送」/「拉取」：只拿计划，右栏进入确认态，绝不直接执行。 */
  async function requestRemote(kind) {
    if (!repo || loading) return;
    setLoading(true);
    const prepared = await gitglass.prepareRemote(kind);
    await refreshLedger();
    setRemote(prepared.overview || remote);
    setRemotePlan(
      prepared.plan
        ? {
            ...prepared,
            kind,
            operationId: prepared.plan.operationId,
            displayCommand: prepared.plan.displayCommand,
          }
        : { ...prepared, kind, blocked: true },
    );
    setLoading(false);
  }

  async function confirmRemote() {
    if (!remotePlan?.plan) return;
    setLoading(true);
    presetLedger();
    const result = await gitglass.executeRemote(remotePlan.kind, remotePlan.operationId);
    setFocusedOperationId(result.execution?.operationId || remotePlan.operationId || null);
    const remoteSuccess = {
      fetch: "已获取远程更新。",
      push: "已将当前分支推送到远程仓库。",
      pull: "已以快进方式拉取远程更新。",
    };
    setNotice(executionNotice(remoteSuccess[remotePlan.kind] || "远程操作已完成。", result.execution));
    if (result.execution?.ok) setRemotePlan(null);
    await refreshAll();
    setLoading(false);
  }

  // ---------------------------------------------------------------- 远程配置

  /** 「添加远程…」/「编辑地址」：先打开表单，表单不执行任何 Git 命令。 */
  function openRemoteConfig(mode, preset) {
    if (!repo || loading) return;
    setRemoteTask({
      kind: "config",
      mode: mode === "set-url" ? "set-url" : "add",
      form: { name: asText(preset?.name), url: asText(preset?.url) },
      plan: null,
      blocked: false,
      reason: "",
    });
  }

  function updateRemoteForm(field, value) {
    setRemoteTask((task) =>
      task && task.kind === "config"
        ? { ...task, form: { ...task.form, [field]: value }, plan: null, blocked: false, reason: "" }
        : task,
    );
  }

  async function prepareRemoteConfig() {
    if (loading) return;
    const task = remoteTask;
    if (!task || task.kind !== "config") return;
    setLoading(true);
    try {
      const result = await gitglass.prepareRemoteConfig(task.mode, task.form);
      await refreshLedger();
      setRemoteTask((current) =>
        current && current.kind === "config"
          ? {
              ...current,
              plan: result?.plan || null,
              blocked: !result?.ok,
              reason: result?.ok ? "" : result?.reason || CONFIG_ERROR,
              preview: result || null,
            }
          : current,
      );
    } catch {
      setRemoteTask((current) => (current ? { ...current, plan: null, blocked: true, reason: CONFIG_ERROR } : current));
    } finally {
      setLoading(false);
    }
  }

  async function confirmRemoteConfig() {
    const task = remoteTask;
    if (!task || task.kind !== "config" || !task.plan) return;
    setLoading(true);
    presetLedger();
    try {
      const result = await gitglass.executeRemoteConfig(task.mode, task.form, task.plan.operationId);
      setFocusedOperationId(result?.execution?.operationId || task.plan.operationId || null);
      if (result?.ok) {
        setNotice({
          type: "success",
          text: `${task.mode === "add" ? "已添加远程" : "已更新远程地址"}：${task.form.name}`,
        });
        setRemoteTask(null);
        if (result.overview) setRemote(result.overview);
      } else {
        setNotice({ type: "error", text: result?.reason || "远程配置没有完成，请查看命令账本。" });
        // 预览是一次性的：失败或过期后必须重新预览，这里把计划清掉并保留原因。
        setRemoteTask((current) =>
          current && current.kind === "config"
            ? { ...current, plan: null, blocked: true, reason: result?.reason || CONFIG_ERROR }
            : current,
        );
      }
      await refreshAll();
    } finally {
      setLoading(false);
    }
  }

  // ------------------------------------------------- 远程跟踪分支 / 上游 / 首次推送

  /** 检出时的本地分支名：改了就要重新预览（计划和输入必须一致）。 */
  function updateRemoteLocalName(value) {
    setRemoteTask((task) => (task ? { ...task, localName: asText(value), plan: null, blocked: false, reason: "" } : task));
  }

  /** 用当前输入重新取一份计划（配置表单 / 检出的本地分支名都走这里）。 */
  function reprepareRemoteTask() {
    if (!remoteTask) return undefined;
    if (remoteTask.kind === "config") return prepareRemoteConfig();
    return prepareRemoteTask(remoteTask.kind, remoteTask.remoteBranch, remoteTask.localName);
  }

  async function prepareRemoteTask(kind, remoteBranch, localName) {
    if (!repo || loading) return;
    setLoading(true);
    try {
      const result =
        kind === "set-upstream"
          ? await gitglass.prepareRemoteBranch("set-upstream", remoteBranch)
          : kind === "checkout"
            ? await gitglass.prepareRemoteBranch("checkout", remoteBranch, localName)
            : await gitglass.prepareFirstPush({});
      await refreshLedger();
      setRemoteTask({
        kind,
        remoteBranch: remoteBranch || result?.remoteBranch || "",
        localName: asText(localName) || asText(result?.local),
        plan: result?.plan || null,
        blocked: !result?.ok,
        reason: result?.ok ? "" : result?.reason || BRANCH_ERROR,
        preview: result || null,
      });
    } catch {
      setRemoteTask({ kind, remoteBranch: asText(remoteBranch), localName: asText(localName), plan: null, blocked: true, reason: BRANCH_ERROR });
    } finally {
      setLoading(false);
    }
  }

  async function confirmRemoteTask() {
    const task = remoteTask;
    if (!task || !task.plan) return;
    setLoading(true);
    presetLedger();
    try {
      const result =
        task.kind === "checkout"
          ? await gitglass.executeRemoteBranch("checkout", task.remoteBranch, task.localName || task.preview?.local, task.plan.operationId)
          : task.kind === "set-upstream"
            ? await gitglass.executeRemoteBranch("set-upstream", task.remoteBranch, undefined, task.plan.operationId)
            : await gitglass.executeFirstPush({}, task.plan.operationId);
      setFocusedOperationId(result?.execution?.operationId || task.plan.operationId || null);
      if (result?.ok) {
        const message =
          task.kind === "checkout"
            ? `已检出并跟踪 ${result.remoteBranch || task.remoteBranch}。`
            : task.kind === "set-upstream"
              ? `已设置上游：${result.upstream?.ref || task.remoteBranch}。`
              : `已推送并设置上游：${result.upstream?.ref || result.targetRef || ""}。`;
        setNotice({ type: "success", text: message });
        setRemoteTask(null);
        if (result.overview) setRemote(result.overview);
      } else {
        setNotice({ type: "error", text: result?.reason || "分支操作没有完成，请查看命令账本。" });
        setRemoteTask((current) => (current ? { ...current, plan: null, blocked: true, reason: result?.reason || BRANCH_ERROR } : current));
      }
      await refreshAll();
    } finally {
      setLoading(false);
    }
  }

  return {
    remote,
    remoteBranches,
    applyOverview,
    applyRemoteBranches,
    remotePlan,
    setRemotePlan,
    requestRemote,
    confirmRemote,
    remoteTask,
    setRemoteTask,
    openRemoteConfig,
    updateRemoteForm,
    updateRemoteLocalName,
    reprepareRemoteTask,
    prepareRemoteConfig,
    confirmRemoteConfig,
    requestCheckoutRemote: (remoteBranch, localName) => prepareRemoteTask("checkout", remoteBranch, localName),
    requestSetUpstream: (remoteBranch) => prepareRemoteTask("set-upstream", remoteBranch),
    requestFirstPush: () => prepareRemoteTask("first-push"),
    confirmRemoteTask,
    /** 顶栏与侧栏的三个入口：语义化名字，参数已经固定。 */
    fetch: () => requestRemote("fetch"),
    push: () => requestRemote("push"),
    pull: () => requestRemote("pull"),
  };
}
