import { useState } from "react";
import { executionNotice } from "./user-notices.js";

// 远程域：overview（远程列表 / 上游 / ahead-behind）与 fetch / push / pull 的
// 「先看计划，再执行」两步。overview 的读取放在这里，`App` 的整体刷新只管调用
// `readOverview()` 并和其它读取并行。
//
// 远程计划也归这个 hook：prepare/confirm 与 overview 是同一份状态（计划面板要显示
// 上游分支与领先/落后），拆到两个 hook 会互相依赖。

/**
 * 远程概览（`getRemoteOverview`）。
 * @typedef {object} RemoteOverview
 * @property {boolean} [ok]
 * @property {string[]} [remotes]
 * @property {{ name?: string, url?: string } | null} [remote]
 * @property {{ ref?: string, branch?: string, remote?: string } | null} [upstream]
 * @property {number} [ahead]
 * @property {number} [behind]
 * @property {string} [reason]
 * @property {string} [suggestion]
 */

/**
 * fetch / push / pull 的计划对象（prepare 的返回值 + 渲染层补的 kind）。
 * @typedef {object} RemotePlan
 * @property {"fetch" | "push" | "pull"} kind
 * @property {{ operationId?: string, displayCommand?: string }} [plan]
 * @property {boolean} [blocked]
 * @property {string} [reason]
 * @property {string} [operationId]
 * @property {string} [displayCommand]
 * @property {RemoteOverview} [overview]
 */

/**
 * `useRemoteOverview` 依赖的 IPC 子集。
 * @typedef {object} RemoteIpc
 * @property {() => Promise<RemoteOverview>} getRemoteOverview
 * @property {(kind: "fetch" | "push" | "pull") => Promise<{ plan?: { operationId?: string, displayCommand?: string }, overview?: RemoteOverview, blocked?: boolean, reason?: string }>} prepareRemote
 * @property {(kind: "fetch" | "push" | "pull", operationId: string) => Promise<{ execution?: { ok?: boolean, operationId?: string } }>} executeRemote
 */

/**
 * @typedef {object} RemoteOverviewOptions
 * @property {RemoteIpc} gitglass
 * @property {string | null} repo
 * @property {boolean} loading
 * @property {(value: boolean) => void} setLoading
 * @property {(cycle?: string) => Promise<void>} refreshLedger
 * @property {() => Promise<unknown>} refreshAll
 * @property {(notice: { type: string, text: string }) => void} setNotice
 * @property {(tab?: "user" | "background") => void} openLedger
 * @property {(operationId: string | null) => void} setFocusedOperationId
 */

/**
 * 远程状态与三个入口。
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
  openLedger,
  setFocusedOperationId,
}) {
  const [remote, setRemote] = useState(/** @type {RemoteOverview | null} */ (null));
  const [remotePlan, setRemotePlan] = useState(/** @type {RemotePlan | null} */ (null));

  /** 直接写入一份 overview：整体刷新并行读完远程状态后经这里落地。 */
  const applyOverview = (next) => setRemote(next);

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
    openLedger();
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

  return {
    remote,
    applyOverview,
    remotePlan,
    setRemotePlan,
    requestRemote,
    confirmRemote,
    /** 顶栏与侧栏的三个入口：语义化名字，参数已经固定。 */
    fetch: () => requestRemote("fetch"),
    push: () => requestRemote("push"),
    pull: () => requestRemote("pull"),
  };
}
