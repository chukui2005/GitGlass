function enabled() {
  return { available: true, reason: "" };
}

function disabled(reason) {
  return { available: false, reason };
}

// This model deliberately describes availability only. Command handlers stay in
// the renderer, so the palette can never become an arbitrary command executor.
export function commandAvailability({ hasRepository, loading, historyMode, selectedArea }) {
  const busy = disabled("正在执行其他操作。");
  const needsRepository = disabled("请先打开仓库。");
  return {
    openRepository: loading ? busy : enabled(),
    refresh: !hasRepository ? needsRepository : loading ? busy : enabled(),
    workspace: enabled(),
    history: hasRepository ? enabled() : needsRepository,
    ledger: enabled(),
    historySearch: historyMode ? enabled() : disabled("仅在历史审查中可用。"),
    stageSelected: !hasRepository
      ? needsRepository
      : loading
        ? busy
        : selectedArea === "unstaged"
          ? enabled()
          : disabled("请先选择一个未暂存文件。"),
  };
}
