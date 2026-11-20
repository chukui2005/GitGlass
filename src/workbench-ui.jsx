// 工作台的展示组件：只接收 props，不做 IPC 调用，所以从 main.jsx 抽出来单独成文件。
// 结构与类名必须与拆分前逐字一致——真渲染测试、Electron 探针与样式契约都按 DOM 断言。
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  CaretDown,
  CheckCircle,
  CircleNotch,
  Copy,
  File,
  FolderOpen,
  GitCommit,
  MagnifyingGlass,
  Minus,
  Plus,
  TerminalWindow,
  Trash,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { fullLocalTime, isHeadCommit, relativeTime } from "./history-search.js";
import { presentDiff } from "./diff-presentation.js";
import { riskLabel } from "./plan-risk.js";
import { formatLedgerOutput, glanceSummary, intentLabel, recordDurationLabel, recordStatusLabel, recordTypeLabel } from "./workbench-ledger.js";
import { shortcutLabel } from "./shortcut-policy.js";

export const isDarwin = /Macintosh/.test(navigator.userAgent);
export const iconFor = { added: "+", modified: "M", deleted: "−", renamed: "R" };
export const titleFor = {
  added: "新增",
  modified: "修改",
  deleted: "删除",
  renamed: "重命名",
};
export const time = (value) =>
  value
    ? new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(new Date(value))
    : "—";
export const basename = (value) =>
  value?.split(/[\\/]/).filter(Boolean).at(-1) || "未打开仓库";
// 批量暂存选择集合的稳定键：区域 + 路径，与 Diff 选中状态完全解耦。
export const stageSelectionKey = (path) => `unstaged:${path}`;


export function PanelSplitter({ side, value, limits, onPointerDown, onDoubleClick, onKeyDown }) {
  const label = side === "left" ? "调整工作区边栏宽度" : "调整文件详情面板宽度";
  return (
    <div
      className={`panel-splitter panel-splitter-${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={limits.min}
      aria-valuemax={limits.max}
      aria-valuenow={value}
      tabIndex="0"
      onPointerDown={(event) => onPointerDown(side, event)}
      onDoubleClick={() => onDoubleClick(side)}
      onKeyDown={(event) => onKeyDown(side, event)}
    />
  );
}

export function DiffLine({ row }) {
  // 文件头只有一行面包屑（路径，或重命名时的「旧 → 新」），不再有行号槽与标签列。
  if (row.type === "file") {
    return (
      <div className="diff-line file">
        <code>{row.content}</code>
      </div>
    );
  }
  return (
    <div className={`diff-line ${row.type}`}>
      <span className="diff-line-number" aria-label={row.oldLine ? `原文件第 ${row.oldLine} 行` : undefined}>{row.oldLine || ""}</span>
      <span className="diff-line-number" aria-label={row.newLine ? `新文件第 ${row.newLine} 行` : undefined}>{row.newLine || ""}</span>
      <span className="diff-marker" aria-hidden="true">{row.marker || ""}</span>
      {row.label && <span className="diff-label">{row.label}</span>}
      <code>{row.content}</code>
    </div>
  );
}

export function DiffContent({ diff }) {
  return (
    <div className="diff-content">
      {presentDiff(diff).map((row, index) => <DiffLine key={index} row={row} />)}
    </div>
  );
}
// 输出面板只在展开的记录里出现，但 stdout/stderr 单条最大 64 KiB：格式化结果按 body 记忆，
// 这样父级重渲染或点「复制」都不会把整段文本重新扫一遍。
export const Output = memo(function Output({ title, body, danger, warning }) {
  const [copied, setCopied] = useState(false);
  // 展示层格式化：控制字符转成可读文本，复制的内容与看到的内容一致。
  const text = useMemo(() => formatLedgerOutput(body), [body]);
  async function copy() {
    await navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }
  return (
    <div className="output">
      <div
        className={`output-heading ${danger ? "danger" : ""} ${warning ? "warning" : ""}`}
      >
        <span>{title}</span>
        <button type="button" onClick={copy} aria-label={`复制 ${title}`}>
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre>{text}</pre>
    </div>
  );
});
export function FileRow({
  file,
  selected,
  onSelect,
  onStage,
  checkable,
  checked,
  onToggleCheck,
  busy,
}) {
  const stageLabel =
    file.area === "staged" ? `取消暂存 ${file.path}` : `暂存 ${file.path}`;
  return (
    <div className={`file-row ${selected ? "selected" : ""}`}>
      {checkable && (
        <input
          type="checkbox"
          className="stage-check"
          checked={checked}
          onChange={() => onToggleCheck(file)}
          aria-label={`选择暂存 ${file.path}`}
          title={`选择暂存 ${file.path}`}
          disabled={busy}
        />
      )}
      <button
        type="button"
        className="file-select"
        aria-label={`选择文件 ${file.path}`}
        title={file.path}
        onClick={() => onSelect(file)}
      >
        <span className={`status ${file.status}`}>{iconFor[file.status]}</span>
        <span className="file-path">
          <File size={14} />
          {file.path}
        </span>
      </button>
      <button
        type="button"
        className="row-action"
        aria-label={stageLabel}
        title={stageLabel}
        disabled={busy}
        onClick={() => onStage(file)}
      >
        {file.area === "staged" ? <Minus size={14} /> : <Plus size={14} />}
      </button>
    </div>
  );
}
export function FileSection({
  title,
  files,
  selected,
  onSelect,
  onStage,
  toolbar,
  checkable,
  isChecked,
  onToggleCheck,
  busy,
  emptyText,
}) {
  return (
    <section className="file-section">
      <div className="section-label">
        <span>{title}</span>
        <b>{files.length}</b>
      </div>
      {toolbar}
      {files.length ? files.map((file, index) => (
        <FileRow
          key={`${file.area}-${file.path}-${index}`}
          file={file}
          selected={
            selected?.area === file.area && selected?.path === file.path
          }
          onSelect={onSelect}
          onStage={onStage}
          checkable={checkable}
          checked={checkable && isChecked(file)}
          onToggleCheck={onToggleCheck}
          busy={busy}
        />
      )) : <p className="section-empty">{emptyText || "此区域没有文件。"}</p>}
    </section>
  );
}

// 未暂存区的批量选择工具栏：全选 / 清除 / 已选计数 / “暂存所选 N 个”主按钮。
// 未选择时主按钮禁用并用 title 说明原因，不制造可点击假象。
export function BatchStageToolbar({ total, count, loading, onSelectAll, onClear, onStageSelected }) {
  const stageTitle = loading
    ? "正在执行其他操作…"
    : count
      ? `将暂存所选 ${count} 个文件`
      : "先在上方勾选要暂存的文件";
  return (
    <div className="batch-toolbar">
      <div className="batch-tools-row">
        <button
          type="button"
          className="batch-tool"
          onClick={onSelectAll}
          disabled={!total || loading}
        >
          全选未暂存
        </button>
        <button
          type="button"
          className="batch-tool"
          onClick={onClear}
          disabled={!count || loading}
        >
          清除选择
        </button>
      </div>
      <div className="batch-stage-row">
        <span className="batch-count" aria-live="polite">
          已选择 {count} 个
        </span>
        <button
          type="button"
          className="batch-stage"
          onClick={onStageSelected}
          disabled={!count || loading}
          title={stageTitle}
        >
          暂存所选 {count} 个
        </button>
      </div>
      {/* 禁用原因以可见文字呈现，不依赖 disabled 按钮自身无法触发的 title。 */}
      {!count && !loading && (
        <p className="batch-hint">先在上方勾选要暂存的文件。</p>
      )}
    </div>
  );
}

// 一条命令记录：展开态由组件自己的 state 管，详情只在展开时才挂进 DOM。
// 这里用 memo 守住「列表级重渲染」——账本上限 300 条，而 App 会因为自动刷新、
// 提示条、命令面板等无关状态频繁重渲染；记录对象身份由 reuseUnchangedRecords 保证稳定，
// 所以没变的那一条不会被重新渲染（展开一条也只影响它自己）。
export const LedgerEntry = memo(function LedgerEntry({ record }) {
  const [expanded, setExpanded] = useState(record.source === "user");
  const [copied, setCopied] = useState(false);
  const command = record.displayCommand || record.command || "等待执行结果";
  const failure = record.ok === false;
  const warning = !failure && Boolean(record.stderr);
  const duration = recordDurationLabel(record);
  async function copy() {
    await navigator.clipboard?.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }
  return (
    <article
      className={`ledger-entry ${failure ? "failure" : ""} ${record.source === "background" ? "background" : ""}`}
    >
      {/* 两行结构：第一行意图 + 等宽命令（单行省略，title 提供全文），第二行结果 · 退出码 · 耗时/时间 · 来源。 */}
      <button
        type="button"
        className="ledger-summary"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className={failure ? "bad" : warning ? "warn" : "good"}>
          {failure ? (
            <WarningCircle size={15} weight="fill" />
          ) : (
            <CheckCircle size={15} weight="fill" />
          )}
        </span>
        <span className="ledger-entry-main">
          <span className="ledger-entry-line">
            <span className="ledger-intent">{intentLabel(record)}</span>
            <code className="ledger-command" title={command}>
              {command}
            </code>
          </span>
          <span className="ledger-entry-meta">
            <span className={failure ? "bad" : warning ? "warn" : "good"}>
              {recordStatusLabel(record)}
            </span>
            <span className="ledger-sep" aria-hidden="true">
              ·
            </span>
            <span>退出码 {record.exitCode ?? "—"}</span>
            {duration && (
              <>
                <span className="ledger-sep" aria-hidden="true">
                  ·
                </span>
                <span>耗时 {duration}</span>
              </>
            )}
            <span className="ledger-sep" aria-hidden="true">
              ·
            </span>
            <time dateTime={record.startedAt || undefined}>
              {time(record.startedAt)}
            </time>
            <span className="ledger-sep" aria-hidden="true">
              ·
            </span>
            <span>{recordTypeLabel(record.source)}</span>
          </span>
        </span>
        <CaretDown size={14} className={expanded ? "open" : ""} />
      </button>
      {expanded && (
        <div className="ledger-details">
          <dl className="ledger-facts">
            <div>
              <dt>操作</dt>
              <dd>{intentLabel(record)}</dd>
            </div>
            <div>
              <dt>类型</dt>
              <dd>{recordTypeLabel(record.source)}</dd>
            </div>
            <div>
              <dt>工作目录</dt>
              <dd>
                <code>{record.cwd || "—"}</code>
              </dd>
            </div>
            <div>
              <dt>状态</dt>
              <dd className={failure ? "bad" : warning ? "warn" : "good"}>
                {recordStatusLabel(record)}
              </dd>
            </div>
          </dl>
          <div className="command-copy">
            <span>实际执行命令</span>
            <code>{command}</code>
            <button type="button" onClick={copy} aria-label="复制完整命令">
              <Copy size={13} />
              {copied ? "已复制" : "复制"}
            </button>
          </div>
          {(record.stdout || record.stderr) && (
            <div className="output-grid">
              {record.stdout && <Output title="命令结果" body={record.stdout} />}
              {record.stderr && (
                <Output
                  title="诊断信息"
                  body={record.stderr}
                  danger={failure}
                  warning={warning}
                />
              )}
            </div>
          )}
          <details className="tech-details">
            <summary>技术详情</summary>
            <div className="tech-row">
              <span>argv</span>
              <code>{JSON.stringify(record.argv || [])}</code>
            </div>
            <div className="tech-row">
              <span>退出代码</span>
              <b className={failure ? "bad" : "good"}>
                {record.exitCode ?? "—"}
              </b>
            </div>
            <div className="tech-row">
              <span>原始输出</span>
              <code>
                “命令结果”已把记录分隔符与控制字符转换为可读文本；命令记录中仍保留原始
                stdout，用于审计和复制真实命令。
              </code>
            </div>
          </details>
        </div>
      )}
    </article>
  );
});
// 刷新分组同样 memo：分组的 `records` 数组由 groupBackgroundRecords 的 useMemo 保持身份，
// 无关状态重渲染时整组（含组内记录）直接跳过。
export const RefreshGroup = memo(function RefreshGroup({ group }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <section className="ledger-refresh-group">
      <button
        type="button"
        className="ledger-refresh-summary"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <ArrowClockwise size={14} />
        <span>刷新工作区 · {group.records.length} 条读取</span>
        <CaretDown size={14} className={expanded ? "open" : ""} />
      </button>
      {expanded && (
        <div className="ledger-refresh-records">
          {group.records.map((record, index) => (
            <LedgerEntry
              key={record.id || `${group.id}-${index}`}
              record={record}
            />
          ))}
        </div>
      )}
    </section>
  );
});
// 工作区中间栏在「没有选中文件」时的空态。历史审查有自己的可交互提交行，
// 这里绝不能退化成一列点不动的提交记录（0.6.5 验收反馈 #20）。
export function WorkspaceEmptyState({ hasChanges = false }) {
  return (
    <div className="workspace-empty" role="status" aria-live="polite">
      <GitCommit size={28} />
      <p>{hasChanges ? "未选择要查看的文件" : "工作区没有未提交的改动"}</p>
      <span>从左侧文件列表选择文件查看差异；查看提交历史请切换到「历史审查」。</span>
    </div>
  );
}

export function PlannedContext({
  plan,
  onCancel,
  onConfirm,
  loading,
  tone = "normal",
  children,
  action,
}) {
  return (
    <section className="inspector-flow">
      <div className="inspector-heading">
        <span>计划操作</span>
        <h2>{plan.blocked ? "操作被阻断" : action}</h2>
      </div>
      {plan.blocked ? (
        <div className="inspector-message danger">
          <WarningCircle size={19} />
          <div>
            <strong>{plan.reason}</strong>
            <p>GitGlass 不会使用危险选项绕过此限制。</p>
          </div>
        </div>
      ) : (
        <>
          {riskLabel(tone) && <div className={`risk-label ${tone}`}>{riskLabel(tone)}</div>}
          {children}
          <div className="planned-command">
            <span>计划执行（尚未运行）</span>
            <code>{plan.displayCommand}</code>
          </div>
          <button
            type="button"
            className={`primary-action ${tone === "high" ? "danger-action" : tone === "caution" ? "caution-action" : ""}`}
            disabled={loading || plan.confirmDisabled}
            onClick={onConfirm}
          >
            {loading ? <CircleNotch size={17} className="spin" /> : null}
            {action}
          </button>
        </>
      )}
      <button type="button" className="text-action" onClick={onCancel}>
        返回
      </button>
    </section>
  );
}
export function BranchContext({ plan, onCancel, onConfirm, loading }) {
  return (
    <PlannedContext
      plan={plan}
      onCancel={onCancel}
      onConfirm={onConfirm}
      loading={loading}
      action={plan.create ? "确认创建分支" : "确认切换分支"}
    >
      <p className="inspector-copy">
        {plan.create ? "将创建并切换到" : "将切换到"} <code>{plan.name}</code>
        。工作区干净；此操作会更新 HEAD 和当前检出文件。
      </p>
    </PlannedContext>
  );
}
export function RemotePlanContext({ plan, onCancel, onConfirm, loading }) {
  const labels = { fetch: "确认获取远程更新", push: "确认推送", pull: "确认拉取" };
  const details =
    plan.kind === "push" ? (
      <>
        将把 <code>{plan.overview.state.branch}</code> 推送至{" "}
        <code>
          {plan.remote}/{plan.overview.upstream.branch}
        </code>
        ；不会使用 <code>--force</code>。
      </>
    ) : plan.kind === "pull" ? (
      <>将仅以快进方式同步；不会自动合并、变基、暂存或丢弃文件。</>
    ) : (
      <>
        将读取 <code>{plan.remote}</code> 的远程引用；不会修改工作区文件。
      </>
    );
  return (
    <PlannedContext
      plan={plan}
      onCancel={onCancel}
      onConfirm={onConfirm}
      loading={loading}
      action={labels[plan.kind]}
    >
      <p className="inspector-copy">
        <strong>这一步不会执行任何命令。</strong>
        确认后才会运行下方「计划执行」里的 Git 命令。
      </p>
      <p className="inspector-copy">{details}</p>
    </PlannedContext>
  );
}
export function SafetyContext({
  plan,
  acknowledgement,
  onAcknowledgement,
  onCancel,
  onConfirm,
  loading,
}) {
  const file = basename(plan.path);
  const discard = plan.kind === "discard";
  const action = discard
    ? `确认丢弃 ${file} 的改动`
    : plan.kind === "delete-merged-branch"
      ? `删除已合并分支 ${plan.branch}`
      : "创建救援分支";
  const tone = discard
    ? "high"
    : plan.kind === "delete-merged-branch"
      ? "caution"
      : "safe";
  const ready = !discard || acknowledgement === file;
  return (
    <PlannedContext
      plan={{ ...plan, confirmDisabled: !ready }}
      onCancel={onCancel}
      onConfirm={onConfirm}
      loading={loading}
      tone={tone}
      action={action}
    >
      {discard ? (
        <>
          <p className="inspector-copy">
            受影响文件：<code>{plan.path}</code>
          </p>
          <p className="inspector-copy">
            GitGlass 无法保证恢复未暂存内容；请先确认 Diff。
          </p>
          <pre className="risk-diff">{plan.diff}</pre>
          <label className="message-label" htmlFor="discard-file-name">
            输入文件名以继续
          </label>
          <input
            id="discard-file-name"
            name="discard-file-name"
            autoComplete="off"
            value={acknowledgement}
            onChange={(event) => onAcknowledgement(event.target.value)}
            placeholder={file}
          />
        </>
      ) : plan.kind === "delete-merged-branch" ? (
        <p className="inspector-copy">
          将删除已合并的本地分支 <code>{plan.branch}</code>。删除后仍可通过
          reflog 尝试恢复；建议先创建救援分支。
        </p>
      ) : (
        <>
          <p className="inspector-copy">
            救援分支只保存一个可回到的提交点，不会移动当前分支或改写历史。
          </p>
          <dl className="file-facts">
            <div>
              <dt>目标提交</dt>
              <dd>
                <code>{plan.hash}</code>
              </dd>
            </div>
            <div>
              <dt>救援分支</dt>
              <dd>
                <code>{plan.branch}</code>
              </dd>
            </div>
          </dl>
        </>
      )}
    </PlannedContext>
  );
}
export function FileInspector({ file, loading, onStage, onDiscard }) {
  const stageLabel = file.area === "staged" ? "取消暂存" : "暂存文件";
  return (
    <section className="inspector-flow">
      <div className="inspector-heading">
        <span>文件详情</span>
        <h2 title={file.path}>{file.path}</h2>
      </div>
      <dl className="file-facts">
        <div>
          <dt>状态</dt>
          <dd className={file.status}>{titleFor[file.status]}</dd>
        </div>
        <div>
          <dt>区域</dt>
          <dd>{file.area === "staged" ? "已暂存" : "未暂存"}</dd>
        </div>
      </dl>
      <p className="inspector-copy">
        已在中央工作区显示该文件的真实 Git Diff。
      </p>
      <button
        type="button"
        className="primary-action"
        disabled={loading}
        onClick={() => onStage(file)}
      >
        {file.area === "staged" ? <Minus size={16} /> : <Plus size={16} />}
        {stageLabel}
      </button>
      {file.area === "unstaged" && (
        <button
          type="button"
          className="danger-outline"
          disabled={loading}
          onClick={() => onDiscard(file.path)}
        >
          <Trash size={15} />
          丢弃此文件的未暂存改动
        </button>
      )}
    </section>
  );
}
// 没有打开仓库时，右栏不渲染一整套禁用的提交表单，只留一块引导：
// 说明这里将来会出现什么，并复用顶栏/空状态同一个目录选择入口（主按钮仍只有左栏那一个）。
export function NoRepositoryGuide({ loading, onOpen }) {
  return (
    <section className="inspector-flow repository-guide">
      <div className="inspector-heading">
        <span>开始使用</span>
        <h2>还没有打开仓库</h2>
      </div>
      <p className="inspector-copy">
        打开一个本地 Git 仓库后，这里会显示暂存状态、提交说明和下一条命令的预览。
      </p>
      <button
        type="button"
        className="secondary-button"
        onClick={onOpen}
        disabled={loading}
      >
        <FolderOpen size={15} />
        打开仓库
      </button>
    </section>
  );
}
export function CommitInspector({
  staged,
  unstaged,
  message,
  loading,
  onMessage,
  onOperate,
  preview,
  platform,
}) {
  const commitHint = !staged.length
    ? "先暂存至少一个文件，才能创建提交。"
    : !message.trim()
      ? "请填写提交说明后再创建提交。"
      : "";
  return (
    <section className="inspector-flow">
      <div className="inspector-heading">
        <span>工作区操作</span>
        <h2>创建提交</h2>
      </div>
      <label className="message-label" htmlFor="commit-message">
        提交说明
      </label>
      <textarea
        id="commit-message"
        name="commit-message"
        autoComplete="off"
        value={message}
        onChange={(event) => onMessage(event.target.value)}
        placeholder="说明此次改动…"
        maxLength={4096}
      />
      <div className="commit-actions">
        <button
          type="button"
          className="secondary-action"
          disabled={!unstaged.length || loading}
          onClick={() => onOperate("stageAll")}
        >
          暂存全部
        </button>
        <button
          type="button"
          className="secondary-action"
          disabled={!staged.length || loading}
          onClick={() => onOperate("unstageAll")}
        >
          取消全部暂存
        </button>
      </div>
      <button
        type="button"
        className="primary-action"
        disabled={!staged.length || !message.trim() || loading}
        onClick={() => onOperate("commit", { message })}
        title={`${shortcutLabel("Enter", platform)} 提交`}
        aria-keyshortcuts={isDarwin ? "Meta+Enter" : "Control+Enter"}
      >
        提交 {staged.length || ""}
      </button>
      <p className="inspector-hint">{commitHint || `${shortcutLabel("Enter", platform)} 提交`}</p>
      <div className="operation-preview">
        <span>下一条命令</span>
        <code>{preview}</code>
      </div>
    </section>
  );
}
export function RecoveryContext({ entries, reason, loading, onRescue, onClose }) {
  return (
    <section className="inspector-flow recovery-context">
      <div className="inspector-heading">
        <span>恢复中心</span>
        <h2>恢复记录中的救援分支</h2>
      </div>
      <p className="inspector-copy">
        救援分支只保存一个可回到的提交点，不会移动当前分支或改写历史。
      </p>
      {reason && (
        <div className="inspector-message danger">
          <WarningCircle size={18} />
          <span>{reason}</span>
        </div>
      )}
      <div className="reflog-list">
        {entries.map((entry) => (
          <button
            type="button"
            className="reflog-row"
            key={`${entry.hash}-${entry.selector}`}
            disabled={loading}
            onClick={() => onRescue(entry)}
          >
            <code>{entry.shortHash}</code>
            <span>{entry.occurredAt || entry.action}</span>
            <strong>{entry.subject || entry.action}</strong>
          </button>
        ))}
        {!entries.length && !reason && (
          <p className="inspector-copy">没有可用的恢复记录。</p>
        )}
      </div>
      <button type="button" className="text-action" onClick={onClose}>
        返回
      </button>
    </section>
  );
}
export function SidebarRemote({ remote, files, loading, onFetch, onPush, onPull }) {
  if (!remote) return null;
  if (!remote.remotes?.length)
    return (
      <section className="remote-summary">
        <div className="section-label">
          <span>远程仓库</span>
        </div>
        <p>{remote.reason}</p>
        <span>{remote.suggestion}</span>
      </section>
    );
  return (
    <section className="remote-summary">
      <div className="section-label">
        <span>远程</span>
        <button
          type="button"
          aria-label="获取远程更新（先查看计划）"
          title="获取远程更新（先查看计划，不会立即执行）"
          onClick={onFetch}
          disabled={loading}
        >
          <ArrowClockwise size={14} />
        </button>
      </div>
      <code title={remote.remote?.name}>{remote.remote?.name || "—"}</code>
      <span title={remote.remote?.url}>{remote.remote?.url}</span>
      {remote.upstream && (
        <>
          <div className="remote-status">
            <span>{remote.upstream.ref}</span>
            <b className={remote.ahead > 0 ? "ahead" : ""}>↑ {remote.ahead}</b>
            <b className={remote.behind > 0 ? "behind" : ""}>
              ↓ {remote.behind}
            </b>
          </div>
          <div className="remote-actions">
            <button
              type="button"
              disabled={loading || remote.ahead <= 0}
              onClick={onPush}
            >
              推送
            </button>
            <button
              type="button"
              disabled={loading || remote.behind <= 0 || files.length > 0}
              onClick={onPull}
            >
              拉取
            </button>
          </div>
        </>
      )}
    </section>
  );
}

export function HistorySearch({ value, onChange, onSubmit, inputRef, total, shortcut, loading }) {
  return (
    <div className="history-search">
      <MagnifyingGlass size={14} aria-hidden="true" />
      <input
        ref={inputRef}
        type="text"
        name="history-search"
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); onSubmit(); } }}
        placeholder={`搜索提交信息、作者名或短 SHA…（${shortcut} 聚焦）`}
        aria-label="搜索提交历史"
        aria-keyshortcuts={isDarwin ? "Meta+F" : "Control+F"}
      />
      {value && (
        <button
          type="button"
          className="icon-button"
          aria-label="清除搜索"
          title="清除搜索（Esc）"
          onClick={() => onChange("")}
        >
          <X size={14} />
        </button>
      )}
      <span className="search-count" aria-live="polite">
        {loading ? "正在查询…" : `共 ${total} 个提交`}
      </span>
    </div>
  );
}

export function HistoryFilters({ draft, branches, currentBranch, selectedFile, loading, dirty, onChange, onApply, onReset, onUseSelected }) {
  const canUseSelected = Boolean(selectedFile && selectedFile.status !== "added");
  return <section className="branch-list history-filters" aria-label="历史筛选条件">
    <div className="section-label"><span>历史范围与筛选</span></div>
    <label>本地分支
      <select name="history-branch" value={draft.branch} onChange={(event) => onChange("branch", event.target.value)} disabled={loading}>
        <option value="">当前分支{currentBranch ? `（${currentBranch}）` : ""}</option>
        {branches.filter((branch) => !branch.current).map((branch) => <option key={branch.name} value={branch.name}>{branch.name}</option>)}
      </select>
    </label>
    <label>作者
      <input name="history-author" autoComplete="off" value={draft.author} onChange={(event) => onChange("author", event.target.value)} placeholder="作者名或邮箱" disabled={loading} />
    </label>
    <label>文件路径
      <input name="history-file-path" autoComplete="off" value={draft.filePath} onChange={(event) => onChange("filePath", event.target.value)} placeholder="当前已跟踪文件" disabled={loading} />
    </label>
    <button type="button" className="text-action" disabled={!canUseSelected || loading} onClick={onUseSelected}>使用当前选中文件</button>
    {dirty && <p className="filter-dirty" role="status">筛选条件已修改，点击应用筛选后查询。</p>}
    <div className="filter-actions">
      <button type="button" className="secondary-button" disabled={loading} onClick={onApply}>应用筛选</button>
      <button type="button" className="secondary-action" disabled={loading} onClick={onReset}>重置</button>
    </div>
  </section>
}

export function CommitRow({ commit, selected, compareRole, onSelect, onCompare, busy = false }) {
  return (
    <div className={`history-row ${selected ? "selected" : ""}`}>
      <button
        type="button"
        className="commit-select"
        aria-label={`查看提交 ${commit.subject}`}
        title={commit.subject}
        onClick={onSelect}
        disabled={busy}
      >
        <span className="graph-line" aria-hidden="true">
          <i />
        </span>
        <span className="commit-main">
          <strong className="commit-title">{commit.subject}</strong>
          <span className="commit-meta">
            <span title={commit.author}>{commit.author || "—"}</span>
            <span aria-hidden="true">·</span>
            <span title={fullLocalTime(commit.authoredAt)}>
              {relativeTime(commit.authoredAt)}
            </span>
            <span aria-hidden="true">·</span>
            <code title={commit.hash}>{commit.shortHash}</code>
            {isHeadCommit(commit) && (
              <b className="head-badge" title="当前 HEAD 所在提交">
                HEAD
              </b>
            )}
            {compareRole === "base" && <b className="compare-badge base">基准</b>}
            {compareRole === "target" && <b className="compare-badge target">对比</b>}
          </span>
        </span>
      </button>
      {onCompare && (
        <button
          type="button"
          className="compare-pin"
          aria-label={`将提交 ${commit.shortHash} 加入双提交比较`}
          title="加入双提交比较"
          onClick={onCompare}
          disabled={busy}
        >
          比较
        </button>
      )}
    </div>
  );
}

export function HistoryDiff({ diff, emptyText }) {
  if (!diff || !diff.trim())
    return (
      <div className="history-empty">
        <p>{emptyText || "没有可显示的文本 Diff。"}</p>
      </div>
    );
  return (
    <DiffContent diff={diff} />
  );
}

export function HistoryResult({ result, onBack }) {
  if (result.ok === false)
    return (
      <div className="history-failure" role="alert">
        <WarningCircle size={22} weight="fill" aria-hidden="true" />
        <strong>
          {result.kind === "compare" ? "无法比较这两个提交" : "无法读取 Diff"}
        </strong>
        <p>{result.reason || "Git 命令执行失败。"}</p>
        {result.suggestion && <p>{result.suggestion}</p>}
        <p>失败详情已作为系统读取记录在命令账本中。</p>
        {onBack && (
          <button type="button" className="secondary-action" onClick={onBack}>
            返回提交列表
          </button>
        )}
      </div>
    );
  const emptyText =
    result.kind === "compare"
      ? "这两个提交之间没有可显示的文本差异。"
      : result.kind === "file"
        ? "此文件在该提交中没有可显示的文本 Diff。"
        : "此提交没有可显示的文本 Diff。";
  return <HistoryDiff diff={result.diff} emptyText={emptyText} />;
}

export function CopyButton({ value, label }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard?.writeText(value || "");
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      title={label}
      onClick={copy}
    >
      {copied ? (
        <CheckCircle size={14} weight="fill" aria-hidden="true" />
      ) : (
        <Copy size={14} aria-hidden="true" />
      )}
    </button>
  );
}

export function CommandPalette({ commands, platform, onClose, onExecute }) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef(null);
  const dialogRef = useRef(null);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return commands;
    return commands.filter((command) =>
      `${command.label} ${command.keywords || ""}`.toLowerCase().includes(normalized),
    );
  }, [commands, query]);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(filtered.length - 1, 0)));
  }, [filtered.length]);
  function execute(command) {
    if (!command?.available) return;
    onExecute(command);
  }
  function onKeyDown(event) {
    // The modal owns every key while open; no page-level shortcut may leak through.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!filtered.length) return;
      setActiveIndex((index) => (event.key === "ArrowDown" ? (index + 1) % filtered.length : (index - 1 + filtered.length) % filtered.length));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      execute(filtered[activeIndex]);
      return;
    }
    if (event.key === "Tab") {
      const focusable = [...(dialogRef.current?.querySelectorAll('input, button:not(:disabled)') || [])];
      if (!focusable.length) return;
      const current = focusable.indexOf(document.activeElement);
      const next = event.shiftKey ? (current <= 0 ? focusable.length - 1 : current - 1) : (current === focusable.length - 1 ? 0 : current + 1);
      event.preventDefault();
      focusable[next].focus();
    }
  }
  return (
    <div className="palette-backdrop" role="presentation">
      <section
        className="command-palette"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-palette-title"
        onKeyDown={onKeyDown}
      >
        <div className="palette-heading">
          <div>
            <span>快捷操作</span>
            <h2 id="command-palette-title">命令面板</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭命令面板" title="关闭（Esc）">
            <X size={16} />
          </button>
        </div>
        <div className="palette-search">
          <MagnifyingGlass size={17} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
            placeholder="搜索操作…"
            aria-label="搜索命令"
            name="command-search"
            autoComplete="off"
          />
          <kbd>{shortcutLabel("K", platform)}</kbd>
        </div>
        <div className="palette-list" role="listbox" aria-label="可用命令">
          {filtered.length ? filtered.map((command, index) => (
            <button
              type="button"
              role="option"
              key={command.id}
              className={`palette-command ${index === activeIndex ? "active" : ""}`}
              aria-selected={index === activeIndex}
              disabled={!command.available}
              onMouseMove={() => setActiveIndex(index)}
              onClick={() => execute(command)}
            >
              <span className="palette-command-main">
                <strong>{command.label}</strong>
                {!command.available && <small>{command.reason}</small>}
              </span>
              {command.shortcut && <kbd>{command.shortcut}</kbd>}
            </button>
          )) : <p className="palette-empty">没有匹配的操作。</p>}
        </div>
        {/* U+3000 keeps the full-width gap between the three shortcuts. */}
        <p className="palette-hint">↑↓ 选择{"\u3000"}Enter 执行{"\u3000"}Esc 关闭</p>
      </section>
    </div>
  );
}

/**
 * 底部命令账本：收起时给人话摘要（最近一条的意图 + 状态 + 时间），展开后是带筛选的
 * 记录列表。真实的 Git 命令与 argv 只在展开后的记录详情里。
 * @param {object} props
 * @param {boolean} props.open
 * @param {() => void} props.onToggle
 * @param {() => void} props.onOpen 收起态点摘要行时展开
 * @param {object | null} props.latestRecord
 * @param {"user" | "background" | "all"} props.filter
 * @param {(filter: "user" | "background" | "all") => void} props.onFilter
 * @param {{ user: number, background: number }} props.counts
 * @param {number} props.totalRecords
 * @param {object[]} props.groups
 * @param {string} props.shortcut
 */
// 账本整块 memo：`groups` / `counts` 在 main.jsx 里已经 useMemo，回调也改成稳定引用，
// 于是自动刷新、提示条、命令面板这类无关状态变化不会再重渲染整列记录。
export const CommandLedger = memo(function CommandLedger({
  open,
  onToggle,
  onOpen,
  latestRecord,
  filter,
  onFilter,
  counts,
  totalRecords,
  groups,
  shortcut,
}) {
  return (
    <section className="command-ledger" aria-label="命令账本">
      <div className="ledger-bar">
        <button
          type="button"
          className="ledger-title"
          onClick={onToggle}
          aria-expanded={open}
          aria-keyshortcuts={isDarwin ? "Meta+J" : "Control+J"}
          title={`${shortcut} 展开或收起命令账本`}
        >
          <TerminalWindow size={16} />
          <span>命令账本</span>
          <CaretDown size={14} className={open ? "open" : ""} />
        </button>
        {!open && (
          <button
            type="button"
            className="ledger-glance"
            onClick={onOpen}
            title={latestRecord ? glanceSummary(latestRecord) : undefined}
          >
            {latestRecord ? (
              <>
                <span
                  className={
                    latestRecord.ok === false
                      ? "bad"
                      : latestRecord.stderr
                        ? "warn"
                        : "good"
                  }
                >
                  {latestRecord.ok === false || latestRecord.stderr ? (
                    <WarningCircle size={14} weight="fill" />
                  ) : (
                    <CheckCircle size={14} weight="fill" />
                  )}
                </span>
                <span className="ledger-glance-text">
                  最近：{intentLabel(latestRecord)}
                </span>
                <span className="ledger-glance-status">
                  · {recordStatusLabel(latestRecord)}
                </span>
                <time>{time(latestRecord.startedAt)}</time>
              </>
            ) : (
              <span className="ledger-glance-text">尚无命令记录</span>
            )}
          </button>
        )}
        {open && (
          <div className="ledger-filter">
            <button
              type="button"
              className={filter === "user" ? "active" : ""}
              onClick={() => onFilter("user")}
            >
              用户操作 {counts.user}
            </button>
            <button
              type="button"
              className={filter === "background" ? "active" : ""}
              onClick={() => onFilter("background")}
            >
              系统读取 {counts.background}
            </button>
            <button
              type="button"
              className={filter === "all" ? "active" : ""}
              onClick={() => onFilter("all")}
            >
              全部 {totalRecords}
            </button>
          </div>
        )}
      </div>
      <div className="ledger-body">
        {open && (
          <>
            <p className="ledger-note">
              用户操作与系统读取均会记录实际执行的 Git 命令；系统读取仅用于同步界面状态，不修改仓库。
            </p>
            <div className="ledger-list">
              {groups.length ? (
                groups.map((group, index) =>
                  group.type === "refresh" ? (
                    <RefreshGroup key={group.id} group={group} />
                  ) : (
                    <LedgerEntry
                      key={group.record.id || index}
                      record={group.record}
                    />
                  ),
                )
              ) : (
                <div className="ledger-empty">
                  <TerminalWindow size={20} />
                  没有符合筛选条件的命令
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
});
