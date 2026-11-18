// 计划面板顶部的风险标签。
//
// 只有「会丢东西 / 会删东西 / 能救人」的三类计划才有风险等级：
// - high：丢弃工作区改动，不可撤销；
// - caution：删除已合并的本地分支；
// - safe：创建救援分支（只新增 ref，不动历史）。
//
// 切换分支、获取远程更新这类普通计划不显示标签——它们的说明文字里已经写清楚
// 会改什么。此前 `PlannedContext` 用三元表达式的兜底分支渲染了
// 「安全：创建救援分支」，导致 fetch 计划也顶着「创建救援分支」的标签。
const RISK_LABELS = {
  high: "高风险：不可直接撤销",
  caution: "谨慎：删除已合并本地分支",
  safe: "安全：创建救援分支",
};

export function riskLabel(tone) {
  if (typeof tone !== "string") return null;
  return RISK_LABELS[tone] ?? null;
}
