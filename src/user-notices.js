// 面向普通用户的操作反馈只描述结果和下一步。Git 的原始 stderr、argv 与退出码
// 只在命令账本的技术详情中呈现，不能从这里透传到通知。
export const GENERIC_GIT_FAILURE = "Git 操作未完成，请查看命令账本中的诊断信息。";

export function operationNotice(action, result) {
  const execution = result?.execution;
  if (execution?.ok) {
    if (result.commit) return { type: "success", text: `已创建提交 ${result.commit}。` };
    if (action === "stageSelected") {
      return { type: "success", text: `已暂存所选 ${Math.max(execution.argv.length - 3, 0)} 个文件。` };
    }
    const success = {
      stage: "已暂存文件。",
      unstage: "已取消暂存文件。",
      stageAll: "已暂存全部改动。",
      unstageAll: "已取消全部暂存。",
      commit: "已创建提交。",
    };
    return { type: "success", text: success[action] || "操作已完成。" };
  }
  if (execution?.rejected) {
    return {
      type: "error",
      text: `本地校验拒绝，未执行 Git 命令。${execution.userMessage || "请刷新工作区后重试。"}`,
    };
  }
  if (action === "stageSelected") {
    return { type: "error", text: "暂存未全部完成，请查看命令账本与当前文件状态。" };
  }
  return { type: "error", text: GENERIC_GIT_FAILURE };
}

export function executionNotice(successText, execution) {
  return execution?.ok
    ? { type: "success", text: successText }
    : { type: "error", text: GENERIC_GIT_FAILURE };
}
