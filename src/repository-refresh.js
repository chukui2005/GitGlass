import { GENERIC_GIT_FAILURE } from "./user-notices.js";

// 将读取失败归约为一个不可误读为“当前仓库状态”的空工作区。这个纯函数由
// renderer 使用，也可独立覆盖“首次启动静默 / 已打开仓库提示”的行为边界。
export function resolveRepositoryRefresh(previousRepo, next, { notifyOnFailure = Boolean(previousRepo) } = {}) {
  if (next?.ok) return { ok: true, state: next };
  return {
    ok: false,
    clearRepository: true,
    state: {
      ok: false,
      path: next?.path || "",
      branch: "",
      files: [],
    },
    notify: notifyOnFailure,
    message: next?.error || GENERIC_GIT_FAILURE,
  };
}

// 打开仓库和手动刷新都可能改变仓库上下文；已有异步 Git 操作时必须拒绝启动。
export function canStartRepositoryContextOperation(loading) {
  return !loading;
}
