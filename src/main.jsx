import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowClockwise,
  ArrowsLeftRight,
  CaretDown,
  CheckCircle,
  CircleNotch,
  Copy,
  File,
  FolderOpen,
  GitBranch,
  GitCommit,
  Lifebuoy,
  MagnifyingGlass,
  Minus,
  Plus,
  TerminalWindow,
  Trash,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import {
  countBySource,
  filterLedgerRecords,
  formatLedgerOutput,
  glanceSummary,
  groupBackgroundRecords,
  intentLabel,
  recordDurationLabel,
  recordStatusLabel,
  recordTypeLabel,
} from "./workbench-ledger.js";
import {
  binaryDiffPattern,
  changeKindLetter,
  changeOf,
  fullLocalTime,
  isHeadCommit,
  orderComparePair,
  relativeTime,
} from "./history-search.js";
import { BrandMark } from "./brand-mark.jsx";
import { RecentRepositoriesMenu } from "./recent-repositories-menu.jsx";
import { presentDiff } from "./diff-presentation.js";
import { executionNotice, GENERIC_GIT_FAILURE, operationFinishedNotice, operationInProgressNotice, operationNotice } from "./user-notices.js";
import { riskLabel } from "./plan-risk.js";
import { AUTO_DISMISS_MS, createNoticeTimer, syncNoticeTimer } from "./notice-lifecycle.js";
import { canStartRepositoryContextOperation, resolveRepositoryRefresh } from "./repository-refresh.js";
import { shouldRefreshOnChange } from "./auto-refresh.js";
import { isBlockingContextOpen, resolveShortcut, shortcutLabel } from "./shortcut-policy.js";
import { commandAvailability } from "./command-palette-model.js";
import { emptyHistoryFilters, resolveHistoryEscape, sameHistoryFilters } from "./history-filter-state.js";
import {
  PANEL_BOUNDS,
  PANEL_WIDTH_STORAGE_KEY,
  clampPanelWidth,
  constrainPanelWidths,
  defaultPanelWidths,
  keyboardPanelWidth,
  panelLimits,
  parsePanelWidths,
  serializePanelWidths,
} from "./panel-resize.js";
import "./styles.css";
import { useAppUpdates, UpdateButton, UpdateDialog } from "./app-updates.jsx";

const isDarwin = /Macintosh/.test(navigator.userAgent);
const iconFor = { added: "+", modified: "M", deleted: "−", renamed: "R" };
const titleFor = {
  added: "新增",
  modified: "修改",
  deleted: "删除",
  renamed: "重命名",
};
const time = (value) =>
  value
    ? new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(new Date(value))
    : "—";
const basename = (value) =>
  value?.split(/[\\/]/).filter(Boolean).at(-1) || "未打开仓库";
const branchName = (branch) =>
  typeof branch === "string" ? branch : branch.name;
const rescueName = (entry) =>
  `rescue/${
    String(entry.occurredAt || "reflog")
      .replace(/[^0-9A-Za-z]+/g, "-")
      .replace(/^-+|-+$/g, "") || "reflog"
  }-${entry.shortHash}`;
// 批量暂存选择集合的稳定键：区域 + 路径，与 Diff 选中状态完全解耦。
const stageSelectionKey = (path) => `unstaged:${path}`;

function readPanelWidths() {
  try {
    return parsePanelWidths(localStorage.getItem(PANEL_WIDTH_STORAGE_KEY));
  } catch {
    return defaultPanelWidths();
  }
}

function PanelSplitter({ side, value, limits, onPointerDown, onDoubleClick, onKeyDown }) {
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

function DiffLine({ row }) {
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

function DiffContent({ diff }) {
  return (
    <div className="diff-content">
      {presentDiff(diff).map((row, index) => <DiffLine key={index} row={row} />)}
    </div>
  );
}
function Output({ title, body, danger, warning }) {
  const [copied, setCopied] = useState(false);
  // 展示层格式化：控制字符转成可读文本，复制的内容与看到的内容一致。
  const text = formatLedgerOutput(body);
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
}
function FileRow({
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
function FileSection({
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
function BatchStageToolbar({ total, count, loading, onSelectAll, onClear, onStageSelected }) {
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

function LedgerEntry({ record }) {
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
}
function RefreshGroup({ group }) {
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
}
function CommitGraph({ commits }) {
  return (
    <div className="commit-graph">
      {commits.length ? (
        commits.map((commit, index) => (
          <div className="graph-row" key={commit.hash || index}>
            <span className="graph-line">
              <i />
            </span>
            <code>{commit.shortHash || commit.hash?.slice(0, 7)}</code>
            <strong>{commit.subject || commit.message}</strong>
            <span>{commit.author}</span>
          </div>
        ))
      ) : (
        <div className="graph-empty">
          <GitCommit size={28} />
          <p>提交历史将在这里显示</p>
          <span>打开仓库后读取最近的真实提交记录。</span>
        </div>
      )}
    </div>
  );
}

function PlannedContext({
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
function BranchContext({ plan, onCancel, onConfirm, loading }) {
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
function RemotePlanContext({ plan, onCancel, onConfirm, loading }) {
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
function SafetyContext({
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
function FileInspector({ file, loading, onStage, onDiscard }) {
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
function CommitInspector({
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
function RecoveryContext({ entries, reason, loading, onRescue, onClose }) {
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
function SidebarRemote({ remote, files, loading, onFetch, onPush, onPull }) {
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

function HistorySearch({ value, onChange, onSubmit, inputRef, total, shortcut, loading }) {
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

function HistoryFilters({ draft, branches, currentBranch, selectedFile, loading, dirty, onChange, onApply, onReset, onUseSelected }) {
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

function CommitRow({ commit, selected, compareRole, onSelect, onCompare, busy = false }) {
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

function HistoryDiff({ diff, emptyText }) {
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

function HistoryResult({ result, onBack }) {
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

function CopyButton({ value, label }) {
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

function CommandPalette({ commands, platform, onClose, onExecute }) {
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

function App() {
  const updates = useAppUpdates();
  const [historyMode, setHistoryMode] = useState(false);
  const [historySelected, setHistorySelected] = useState(null);
  const [historyDetail, setHistoryDetail] = useState(null);
  const [historyResult, setHistoryResult] = useState(null);
  const [historyCompare, setHistoryCompare] = useState({ base: null, target: null });
  const [historyFile, setHistoryFile] = useState(null);
  const [historyDraft, setHistoryDraft] = useState(emptyHistoryFilters);
  const [historyApplied, setHistoryApplied] = useState(null);
  const [commitsReason, setCommitsReason] = useState("");
  const [repo, setRepo] = useState(null);
  // 最近打开仓库：[{ path, name, exists }]，由主进程在每次读取时重算 exists。
  const [recentRepositories, setRecentRepositories] = useState([]);
  const [state, setState] = useState({ branch: "", files: [], ok: true });
  const [selected, setSelected] = useState(null);
  // 批量暂存勾选集合：Set<stageSelectionKey>，独立于右侧 Diff 选中状态；
  // 一律通过创建新的 Set 进行不可变更新。
  const [stageSelection, setStageSelection] = useState(() => new Set());
  const [diff, setDiff] = useState("");
  const [diffMessage, setDiffMessage] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState(null);
  // 悬停或聚焦在横幅内（含 × / 钉住按钮）时暂停自动收起，离开后重新计时。
  // 拆成两个标志，避免"鼠标离开但焦点还在横幅里"被误判成可以继续计时。
  const [noticeHovered, setNoticeHovered] = useState(false);
  const [noticeFocused, setNoticeFocused] = useState(false);
  const [branchPlan, setBranchPlan] = useState(null);
  const [remotePlan, setRemotePlan] = useState(null);
  const [safetyPlan, setSafetyPlan] = useState(null);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [reflogEntries, setReflogEntries] = useState([]);
  const [reflogReason, setReflogReason] = useState("");
  const [acknowledgement, setAcknowledgement] = useState("");
  const [remote, setRemote] = useState(null);
  const [branches, setBranches] = useState([]);
  const [commits, setCommits] = useState([]);
  const [records, setRecords] = useState([]);
  const [ledgerFilter, setLedgerFilter] = useState("user");
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [focusedOperationId, setFocusedOperationId] = useState(null);
  const [newBranch, setNewBranch] = useState("");
  const [panelWidths, setPanelWidths] = useState(readPanelWidths);
  const workspaceRef = useRef(null);
  const panelResize = useRef(null);
  const refreshSequence = useRef(0);
  // 自动刷新（窗口重新聚焦 / 主进程看到 .git 变化）用的最新闭包与订阅状态：
  // 订阅只建立一次，所以 refreshAll 必须通过 ref 取用，不能闭包住首帧的仓库。
  const refreshAllRef = useRef(null);
  const automaticRefresh = useRef({
    loading: false,
    hasRepository: false,
    refreshing: false,
    lastRefreshAt: Date.now(),
  });
  // Last merge/rebase/cherry-pick/revert state we already told the user about,
  // so a background refresh does not repeat the same banner every cycle.
  const operationNoticeRef = useRef(null);
  // 瞬时通知（成功/失败）的自动收起计时器。只创建一次，onExpire 里再把通知置空；
  // 「仓库处于合并/变基中」的状态横幅永远不进入这个计时器（见 notice-lifecycle.js）。
  const noticeTimerRef = useRef(null);
  if (!noticeTimerRef.current) {
    noticeTimerRef.current = createNoticeTimer({
      onExpire: () => setNotice((current) => (current && !current.pinned ? null : current)),
    });
  }
  const refreshCycles = useRef(new Map());
  const historySearchRef = useRef(null);
  const historyQuerySequence = useRef(0);
  const paletteTriggerRef = useRef(null);
  const paletteReturnFocusRef = useRef(null);
  const detailCache = useRef(new Map());
  const getPanelLimits = (side, widths = panelWidths) =>
    panelLimits(side, widths, workspaceRef.current?.clientWidth || window.innerWidth);
  const setPanelWidth = (side, requestedWidth) => {
    setPanelWidths((current) => {
      const width = clampPanelWidth(side, requestedWidth, getPanelLimits(side, current));
      return current[side] === width ? current : { ...current, [side]: width };
    });
  };
  const resetPanelWidth = (side) => setPanelWidth(side, PANEL_BOUNDS[side].default);
  // 拖拽期间：捕获指针 + 铺一层全屏 overlay（避免 hover 抖动）+ rAF 节流，
  // pointerup / pointercancel / 窗口失焦都会收尾，绝不留下半截拖拽状态。
  const startPanelResize = (side, event) => {
    if (event.button !== 0 || panelResize.current) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    handle.setPointerCapture?.(pointerId);
    const startX = event.clientX;
    const startWidth = panelWidths[side];
    const overlay = document.createElement("div");
    overlay.className = "panel-resize-overlay";
    overlay.setAttribute("aria-hidden", "true");
    document.body.append(overlay);
    document.body.classList.add("is-resizing-panels");
    let pendingX = startX;
    let frame = null;

    const apply = () => {
      frame = null;
      const movement = pendingX - startX;
      setPanelWidth(side, startWidth + (side === "left" ? movement : -movement));
    };
    const onPointerMove = (moveEvent) => {
      pendingX = moveEvent.clientX;
      if (frame !== null) return;
      frame = requestAnimationFrame(apply);
    };
    const finish = () => {
      if (!panelResize.current) return;
      panelResize.current = null;
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      apply();
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
      overlay.remove();
      document.body.classList.remove("is-resizing-panels");
    };

    panelResize.current = { side, finish };
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish, { once: true });
  };
  const resizePanelWithKeyboard = (side, event) => {
    const next = keyboardPanelWidth(side, panelWidths[side], event.key, getPanelLimits(side));
    if (next === null) return;
    event.preventDefault();
    setPanelWidth(side, next);
  };
  useEffect(() => {
    try {
      localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, serializePanelWidths(panelWidths));
    } catch {
      // 存储不可用时继续使用当前会话的宽度。
    }
  }, [panelWidths]);
  // 窗口/工作区变窄时把两侧宽度夹回可行范围。挂载后先同步夹紧一次，
  // 再用 rAF 节流监听 window resize 与工作区自身的尺寸变化（冷启动时
  // clientWidth 可能还没稳定，rAF 会再补一次）。
  useEffect(() => {
    let frame = null;
    const constrainPanels = () => {
      frame = null;
      const workspaceWidth = workspaceRef.current?.clientWidth || window.innerWidth;
      setPanelWidths((current) => {
        const next = constrainPanelWidths(current, workspaceWidth);
        return next.left === current.left && next.right === current.right ? current : next;
      });
    };
    const scheduleConstrain = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(constrainPanels);
    };
    const workspace = workspaceRef.current;
    const observer = typeof ResizeObserver === "function" && workspace ? new ResizeObserver(scheduleConstrain) : null;
    observer?.observe(workspace);
    window.addEventListener("resize", scheduleConstrain);
    constrainPanels();
    frame = requestAnimationFrame(constrainPanels);
    return () => {
      window.removeEventListener("resize", scheduleConstrain);
      observer?.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);
  // 组件卸载（或仓库上下文切换导致工作区重建）时收尾仍在进行的拖拽。
  useEffect(() => () => panelResize.current?.finish?.(), []);
  const staged = useMemo(
    () => state.files.filter((file) => file.area === "staged"),
    [state.files],
  );
  const unstaged = useMemo(
    () => state.files.filter((file) => file.area === "unstaged"),
    [state.files],
  );
  // 勾选集合只包含仍存在于未暂存区的文件（刷新 / 暂存成功 / 切换仓库后自动对齐）。
  const checkedForStaging = useMemo(
    () =>
      unstaged.filter((file) =>
        stageSelection.has(stageSelectionKey(file.path)),
      ),
    [unstaged, stageSelection],
  );
  const checkedCount = checkedForStaging.length;
  const ledgerCounts = useMemo(() => countBySource(records), [records]);
  const visibleRecords = useMemo(
    () => filterLedgerRecords(records, ledgerFilter, focusedOperationId),
    [records, ledgerFilter, focusedOperationId],
  );
  const ledgerGroups = useMemo(
    () => groupBackgroundRecords(visibleRecords),
    [visibleRecords],
  );
  const latestRecord = records[0];
  const preview = !repo
    ? "git status --porcelain=v1 -z --untracked-files=all"
    : staged.length && message.trim()
      ? `git commit -m ${JSON.stringify(message.trim())}`
      : selected
        ? selected.area === "staged"
          ? `git restore --staged -- ${selected.path}`
          : `git add -- ${selected.path}`
        : unstaged.length
          ? "git add -A"
          : "git status --porcelain=v1 -z --untracked-files=all";
  useEffect(() => {
    (async () => {
      const resume = await window.gitglass.getUpdateResume();
      if (resume) {
        setMessage(resume.commitMessage);
        setHistoryMode(resume.historyMode);
      }
      await refreshAll();
      if (resume) await window.gitglass.consumeUpdateResume();
    })().catch(() => setNotice({ type: "error", text: "无法恢复工作区，请重新打开仓库。" }));
  }, []);
  useEffect(() => {
    loadRecentRepositories();
  }, []);
  // 自动刷新订阅只建立一次：每次渲染把最新的 refreshAll 与仓库 / loading 状态
  // 放进 ref，事件回调永远用到最新一份，不重新订阅。
  useEffect(() => {
    refreshAllRef.current = refreshAll;
    automaticRefresh.current.loading = loading;
    automaticRefresh.current.hasRepository = Boolean(repo);
  });
  // 窗口重新获得焦点、或主进程在 .git 上看到变化（终端里 commit / 切换分支）
  // 时静默刷新一次：不弹通知、不打开账本。loading、静默刷新进行中一律丢弃；
  // 刷新结束后 1 秒内的事件也丢弃，但与 index 无关的 HEAD / refs 变化可以穿过
  // 静默窗（见 src/auto-refresh.js），这样"终端里连续 add + commit"不会漏掉。
  useEffect(() => {
    const triggerAutomaticRefresh = async (reason = "") => {
      const guard = automaticRefresh.current;
      if (
        !shouldRefreshOnChange({
          loading: guard.loading,
          refreshing: guard.refreshing,
          hasRepository: guard.hasRepository,
          lastRefreshAt: guard.lastRefreshAt,
          reason,
        })
      )
        return;
      guard.refreshing = true;
      try {
        await refreshAllRef.current?.();
      } catch {
        // 静默刷新失败不打扰用户：下一次事件或窗口聚焦会再试一次。
      } finally {
        guard.refreshing = false;
        guard.lastRefreshAt = Date.now();
      }
    };
    const onRepositoryChanged = (payload) => {
      triggerAutomaticRefresh(payload?.reason || "");
    };
    // 聚焦事件必须显式传空串，否则 FocusEvent 会被当成 reason 传进策略函数。
    const onWindowFocus = () => {
      triggerAutomaticRefresh("");
    };
    const unsubscribe = window.gitglass.onRepositoryChanged?.(onRepositoryChanged);
    window.addEventListener("focus", onWindowFocus);
    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
      window.removeEventListener("focus", onWindowFocus);
    };
  }, []);
  const historyFiltersDirty = !sameHistoryFilters(historyDraft, historyApplied || emptyHistoryFilters);
  // 刷新、暂存成功、切换仓库后：把勾选集合与当前未暂存列表重新对齐，
  // 移除已不存在于未暂存区的幽灵选择。
  useEffect(() => {
    setStageSelection((previous) => {
      if (!previous.size) return previous;
      const valid = new Set(
        unstaged.map((file) => stageSelectionKey(file.path)),
      );
      let changed = false;
      const next = new Set();
      for (const key of previous) {
        if (valid.has(key)) next.add(key);
        else changed = true;
      }
      return changed ? next : previous;
    });
  }, [unstaged]);
  function toggleStageSelection(file) {
    setStageSelection((previous) => {
      const key = stageSelectionKey(file.path);
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function selectAllUnstaged() {
    setStageSelection(
      new Set(unstaged.map((file) => stageSelectionKey(file.path))),
    );
  }
  function clearStageSelection() {
    setStageSelection(new Set());
  }
  async function applyState(next, preference, cycle) {
    setState(next);
    const nextFile = preference || next.files[0] || null;
    setSelected(nextFile);
    if (nextFile) await loadDiff(nextFile, cycle);
    else {
      setDiff("");
      setDiffMessage("");
    }
  }
  async function refreshLedger(cycle) {
    const next = await window.gitglass.getLedger();
    setRecords(
      next.map((record) => {
        if (
          record.source === "background" &&
          cycle &&
          !refreshCycles.current.has(record.id)
        )
          refreshCycles.current.set(record.id, cycle);
        const refreshCycleId = refreshCycles.current.get(record.id);
        return refreshCycleId ? { ...record, refreshCycleId } : record;
      }),
    );
  }
  function clearStaleRepositoryState(failure) {
    setRepo(null);
    setState(failure.state);
    setSelected(null);
    setDiff("");
    setDiffMessage("");
    setStageSelection(new Set());
    setBranches([]);
    setCommits([]);
    setCommitsReason("");
    setHistoryDraft(emptyHistoryFilters);
    setHistoryApplied(null);
    setRemote(null);
    setHistoryMode(false);
    setHistorySelected(null);
    setHistoryDetail(null);
    setHistoryResult(null);
    setHistoryFile(null);
    setHistoryCompare({ base: null, target: null });
    detailCache.current.clear();
  }
  async function runRefresh(preference, options) {
    const sequence = ++refreshSequence.current;
    const cycle = `refresh-${Date.now()}-${sequence}`;
    const next = await window.gitglass.getState();
    // A newer refresh started while this one was in flight: its result would be
    // stale, so drop it instead of letting an older snapshot win.
    if (sequence !== refreshSequence.current) return { ok: false, stale: true };
    const resolved = resolveRepositoryRefresh(repo, next, options);
    if (!resolved.ok) {
      clearStaleRepositoryState(resolved);
      if (resolved.notify) {
        setLedgerOpen(true);
        setLedgerFilter("background");
        setNotice({ type: "error", text: resolved.message });
      }
      await refreshLedger(cycle);
      return resolved;
    }
    setRepo(next.path || repo);
    await applyState(next, preference, cycle);
    if (sequence !== refreshSequence.current) return { ok: false, stale: true };
    const querySequence = ++historyQuerySequence.current;
    const [branchResult, commitResult, remoteResult] = await Promise.all([
      window.gitglass.getBranches(),
      historyApplied ? window.gitglass.queryHistory(historyApplied) : window.gitglass.getCommits(),
      window.gitglass.getRemoteOverview(),
    ]);
    setBranches(branchResult.branches || []);
    if (querySequence === historyQuerySequence.current) applyHistoryQueryResult(commitResult);
    setRemote(remoteResult);
    await refreshLedger(cycle);
    return resolved;
  }
  // 所有刷新（启动、手动、切换仓库、操作成功后、自动刷新）都经这里：结束时
  // 记录时间戳，作为自动刷新 1 秒静默窗的起点。
  async function refreshAll(preference, options) {
    try {
      return await runRefresh(preference, options);
    } finally {
      automaticRefresh.current.lastRefreshAt = Date.now();
    }
  }
  async function refreshFromUser() {
    if (!canStartRepositoryContextOperation(loading)) return;
    setLoading(true);
    try {
      await refreshAll();
    } finally {
      setLoading(false);
    }
  }
  function applyHistoryQueryResult(result) {
    const nextCommits = result.commits || [];
    const hashes = new Set(nextCommits.map((commit) => commit.hash));
    setCommits(nextCommits);
    setCommitsReason(result.reason || "");
    if (historySelected && !hashes.has(historySelected.hash)) {
      setHistorySelected(null); setHistoryDetail(null); setHistoryResult(null); setHistoryFile(null);
    }
    setHistoryCompare((previous) => ({
      base: previous.base && hashes.has(previous.base.hash) ? previous.base : null,
      target: previous.target && hashes.has(previous.target.hash) ? previous.target : null,
    }));
    detailCache.current.clear();
  }
  async function applyHistoryFilters(next = historyDraft, reset = false) {
    if (loading || !repo) return;
    const filters = reset ? emptyHistoryFilters : { ...next };
    setLoading(true);
    const sequence = ++historyQuerySequence.current;
    try {
      const result = reset ? await window.gitglass.getCommits() : await window.gitglass.queryHistory(filters);
      if (sequence !== historyQuerySequence.current) return;
      setHistoryApplied(reset ? null : filters);
      setHistoryDraft(filters);
      applyHistoryQueryResult(result);
      await refreshLedger();
    } finally {
      if (sequence === historyQuerySequence.current) setLoading(false);
    }
  }
  async function loadDiff(file, cycle) {
    setSelected(file);
    setDiff("");
    setDiffMessage("正在读取文件差异…");
    const result = await window.gitglass.getDiff(file);
    if (!result.ok) {
      setDiffMessage("无法读取此文件的差异。请刷新工作区后重试；诊断信息已保留在命令账本。");
    } else if (binaryDiffPattern.test(result.stdout || "")) {
      setDiffMessage("这是二进制文件，Git 无法显示文本差异。请在命令账本查看诊断信息。");
    } else if (result.outputTruncated) {
      setDiff(result.stdout || "");
      setDiffMessage("Diff 已截断，可在命令账本复制真实命令后在终端查看完整输出。");
    } else if (!result.stdout) {
      setDiffMessage("没有可显示的文本差异。文件状态可能已变化，请刷新工作区后重试。");
    } else {
      setDiff(result.stdout);
      setDiffMessage("");
    }
    await refreshLedger(cycle);
  }
  async function selectHistoryCommit(commit) {
    // 选择同一提交时不重复请求：已选中且详情已显示则直接返回；
    // 提交详情按 SHA 缓存，再次查看不再执行 Git 命令。
    if (!commit) return;
    if (historySelected?.hash === commit.hash && historyDetail) {
      setHistoryFile(null);
      setHistoryResult(null);
      return;
    }
    setHistorySelected(commit);
    setHistoryFile(null);
    setHistoryResult(null);
    const cached = detailCache.current.get(commit.hash);
    if (cached) {
      setHistoryDetail(cached);
      return;
    }
    setLoading(true);
    setHistoryDetail(null);
    const result = await window.gitglass.getCommitDetail(commit.hash);
    detailCache.current.set(commit.hash, result);
    setHistoryDetail(result);
    await refreshLedger();
    setLoading(false);
  }

  function viewParentCommit(parentHash) {
    if (!parentHash) return;
    const known = commits.find((entry) => entry.hash === parentHash);
    selectHistoryCommit(
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
    if (!historySelected) return;
    setLoading(true);
    const result = await window.gitglass.getCommitDiff(historySelected.hash);
    setHistoryResult({ ...result, kind: "commit" });
    await refreshLedger();
    setLoading(false);
  }

  async function openCommitFileDiff(file) {
    if (!historySelected || !file) return;
    setLoading(true);
    const result = await window.gitglass.getFileHistoryDiff(
      historySelected.hash,
      file.path,
    );
    setHistoryResult({
      ...result,
      kind: "file",
      path: file.path,
      shortHash: historySelected.shortHash,
    });
    await refreshLedger();
    setLoading(false);
  }

  async function openFileEntryDiff(commit) {
    if (!historyFile || !commit) return;
    setLoading(true);
    const result = await window.gitglass.getFileHistoryDiff(
      commit.hash,
      historyFile.path,
    );
    setHistoryResult({
      ...result,
      kind: "file",
      path: historyFile.path,
      shortHash: commit.shortHash,
    });
    await refreshLedger();
    setLoading(false);
  }

  async function openFileHistory(path) {
    setLoading(true);
    const result = await window.gitglass.getFileHistory(path);
    setHistoryFile(result);
    setHistoryResult(null);
    await refreshLedger();
    setLoading(false);
  }

  function pinCompare(commit) {
    setHistoryCompare((value) => {
      if (!value.base) return { base: commit, target: null };
      if (value.base.hash === commit.hash) return { base: null, target: null };
      if (value.target?.hash === commit.hash) return { ...value, target: null };
      if (value.target) return { base: commit, target: null };
      // 默认基准为较早提交、对比为较晚提交；用户随后仍可交换。
      return orderComparePair(value.base, commit);
    });
  }

  function swapCompare() {
    setHistoryCompare((value) => ({ base: value.target, target: value.base }));
  }

  async function readCompare() {
    const { base, target } = historyCompare;
    if (!base || !target) return;
    setLoading(true);
    const result = await window.gitglass.compareCommits(base.hash, target.hash);
    setHistoryResult({
      ...result,
      kind: "compare",
      baseShort: base.shortHash,
      targetShort: target.shortHash,
    });
    await refreshLedger();
    setLoading(false);
  }
  async function loadRecentRepositories() {
    try {
      const list = await window.gitglass.getRecentRepositories();
      setRecentRepositories(Array.isArray(list) ? list : []);
    } catch {
      // 最近仓库列表不可用时保持当前内容，不影响主工作区。
    }
  }
  async function forgetRecentRepository(candidate, options = {}) {
    try {
      const list = await window.gitglass.forgetRecentRepository(candidate);
      setRecentRepositories(Array.isArray(list) ? list : []);
      if (!options.silent) {
        setNotice({ type: "success", text: `已从最近仓库移除：${candidate}` });
      }
    } catch {
      if (!options.silent) {
        setNotice({ type: "error", text: "无法从最近仓库移除该路径。" });
      }
    }
  }
  // 打开仓库成功后的统一收尾：选目录与最近仓库切换都必须走这里，
  // 避免出现第二份「清历史/清勾选」逻辑。
  async function applyOpenedRepository(result) {
    const opened = resolveRepositoryRefresh(repo, result.state, { notifyOnFailure: true });
    if (!opened.ok) {
      clearStaleRepositoryState(opened);
      setLedgerOpen(true);
      setLedgerFilter("background");
      setNotice({ type: "error", text: opened.message });
      await refreshLedger();
      await loadRecentRepositories();
      return { ok: false, message: opened.message };
    }
    setRepo(result.path);
    // 切换仓库后清空历史审阅状态，避免旧仓库的选中提交与缓存混入。
    detailCache.current.clear();
    setHistorySelected(null);
    setHistoryDetail(null);
    setHistoryResult(null);
    setHistoryFile(null);
    setHistoryCompare({ base: null, target: null });
    setHistoryDraft(emptyHistoryFilters);
    setHistoryApplied(null);
    // 切换仓库后清空批量暂存选择，避免旧仓库的勾选混入新仓库。
    setStageSelection(new Set());
    const refreshed = await refreshAll(undefined, { notifyOnFailure: true });
    if (refreshed.ok) setNotice({ type: "success", text: `已打开仓库：${result.path}` });
    await loadRecentRepositories();
    return refreshed;
  }
  async function chooseRepo() {
    if (!canStartRepositoryContextOperation(loading)) return;
    setLoading(true);
    try {
      const result = await window.gitglass.chooseRepository();
      if (result.canceled) return;
      if (!result.ok) {
        setLedgerOpen(true);
        setLedgerFilter("background");
        setNotice({ type: "error", text: result.message || GENERIC_GIT_FAILURE });
        await refreshLedger();
        return;
      }
      await applyOpenedRepository(result);
    } catch {
      setLedgerOpen(true);
      setLedgerFilter("background");
      setNotice({ type: "error", text: GENERIC_GIT_FAILURE });
      await refreshLedger();
    } finally {
      setLoading(false);
    }
  }
  async function openRecentRepository(item) {
    if (!item?.path || !canStartRepositoryContextOperation(loading)) return;
    setLoading(true);
    try {
      const result = await window.gitglass.openRepository(item.path);
      if (!result?.ok) {
        setLedgerOpen(true);
        setLedgerFilter("background");
        setNotice({ type: "error", text: result?.message || GENERIC_GIT_FAILURE });
        await refreshLedger();
        // 路径已在磁盘上消失：给出中文原因并把它从最近列表移除，而不是静默失败。
        if (result?.missing || item.exists === false) {
          await forgetRecentRepository(item.path, { silent: true });
        }
        return;
      }
      await applyOpenedRepository(result);
    } catch {
      setLedgerOpen(true);
      setLedgerFilter("background");
      setNotice({ type: "error", text: GENERIC_GIT_FAILURE });
      await refreshLedger();
    } finally {
      setLoading(false);
    }
  }
  async function operate(action, payload = {}) {
    if (!repo || loading) return;
    setLoading(true);
    setLedgerOpen(true);
    setLedgerFilter("user");
    setFocusedOperationId(null);
    const result = await window.gitglass.operate(action, payload);
    setFocusedOperationId(result.execution?.operationId || null);
    setNotice(operationNotice(action, result));
    if (result.commit) setMessage("");
    await refreshAll();
    setLoading(false);
  }
  async function requestSwitch(branch, create = false) {
    if (loading) return;
    const name = create ? branch.trim() : branchName(branch);
    if (!name || (!create && (name === state.branch || branch.current))) return;
    const prepared = await window.gitglass.prepareBranch(name, create);
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
    setLedgerOpen(true);
    const result = await window.gitglass.executeBranch(
      branchPlan.name,
      branchPlan.create,
      branchPlan.operationId,
    );
    setFocusedOperationId(
      result.execution?.operationId || branchPlan.operationId,
    );
    setNotice(executionNotice(`已${branchPlan.create ? "创建并切换到" : "切换到"} ${branchPlan.name}。`, result.execution));
    if (result.execution?.ok) setBranchPlan(null);
    await refreshAll();
    setLoading(false);
  }
  async function requestRemote(kind) {
    if (!repo || loading) return;
    setLoading(true);
    const prepared = await window.gitglass.prepareRemote(kind);
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
    setLedgerOpen(true);
    const result = await window.gitglass.executeRemote(
      remotePlan.kind,
      remotePlan.operationId,
    );
    setFocusedOperationId(
      result.execution?.operationId || remotePlan.operationId,
    );
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
  async function requestDiscard(path) {
    setLoading(true);
    setAcknowledgement("");
    const prepared = await window.gitglass.prepareDiscard(path);
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
  async function requestDeleteMergedBranch(branch) {
    if (loading) return;
    setLoading(true);
    const prepared = await window.gitglass.prepareDeleteMergedBranch(branch);
    await refreshLedger();
    setSafetyPlan(
      prepared.plan
        ? {
            ...prepared,
            kind: "delete-merged-branch",
            branch,
            operationId: prepared.plan.operationId,
            displayCommand: prepared.plan.displayCommand,
          }
        : { ...prepared, kind: "delete-merged-branch", branch, blocked: true },
    );
    setLoading(false);
  }
  async function openRecovery() {
    setLoading(true);
    const result = await window.gitglass.getReflog();
    setReflogEntries(result.entries || []);
    setReflogReason(result.reason || "");
    setRecoveryOpen(true);
    await refreshLedger();
    setLoading(false);
  }
  async function requestRescue(entry) {
    setLoading(true);
    const branch = rescueName(entry);
    const prepared = await window.gitglass.prepareRescueBranch(
      entry.hash,
      branch,
    );
    await refreshLedger();
    setRecoveryOpen(false);
    setSafetyPlan(
      prepared.plan
        ? {
            ...prepared,
            kind: "rescue-branch",
            branch,
            hash: entry.hash,
            operationId: prepared.plan.operationId,
            displayCommand: prepared.plan.displayCommand,
          }
        : {
            ...prepared,
            kind: "rescue-branch",
            branch,
            hash: entry.hash,
            blocked: true,
          },
    );
    setLoading(false);
  }
  async function confirmSafety() {
    if (!safetyPlan?.plan) return;
    setLoading(true);
    setLedgerOpen(true);
    setLedgerFilter("user");
    let result;
    if (safetyPlan.kind === "discard")
      result = await window.gitglass.executeDiscard(
        safetyPlan.path,
        safetyPlan.operationId,
      );
    else if (safetyPlan.kind === "delete-merged-branch")
      result = await window.gitglass.executeDeleteMergedBranch(
        safetyPlan.branch,
        safetyPlan.operationId,
      );
    else
      result = await window.gitglass.executeRescueBranch(
        safetyPlan.hash,
        safetyPlan.branch,
        safetyPlan.operationId,
      );
    setFocusedOperationId(
      result.execution?.operationId || safetyPlan.operationId,
    );
    const safetySuccess = safetyPlan.kind === "discard"
      ? "已丢弃该文件的未暂存改动。"
      : safetyPlan.kind === "delete-merged-branch"
        ? `已删除分支 ${safetyPlan.branch}。`
        : `已创建救援分支 ${safetyPlan.branch}。`;
    setNotice(executionNotice(safetySuccess, result.execution));
    if (result.execution?.ok) setSafetyPlan(null);
    await refreshAll();
    setLoading(false);
  }
  const shortcutPlatform = navigator.userAgent;
  const commandShortcut = shortcutLabel("K", shortcutPlatform);
  const historySearchShortcut = shortcutLabel("F", shortcutPlatform);
  const ledgerShortcut = shortcutLabel("J", shortcutPlatform);
  const modalOpen = isBlockingContextOpen({
    paletteOpen,
    safetyPlan,
    branchPlan,
    remotePlan,
    recoveryOpen,
  });
  const blockingContextOpen = modalOpen || updates.open;
  // A merge/rebase in progress is state, not a transient message: keep it
  // visible until the user resolves it, even if a notice is dismissed.
  const operationBanner = state?.operation ? operationInProgressNotice(state.operation) : null;
  const workspaceBanner = operationBanner || notice;
  const noticeWaiting = noticeHovered || noticeFocused;
  // 瞬时通知出现（或被新内容替换）就开始计时；文案变化会重新计满整段时间。
  // 依赖只放 notice 对象和 state.operation 原始值：operationBanner 每次渲染都是
  // 新对象，放进依赖会让计时器被无限重启，6 秒永远走不完。
  useEffect(() => {
    syncNoticeTimer(noticeTimerRef.current, { notice, operationBanner });
  }, [notice, state?.operation]);
  // 悬停/聚焦暂停；离开后重新计满整段时间，所以不会"鼠标一离开就消失"。
  useEffect(() => {
    if (noticeWaiting) noticeTimerRef.current.pause();
    else noticeTimerRef.current.resume();
  }, [noticeWaiting, notice, state?.operation]);
  // 横幅被 × 或自动收起时不会有 mouseleave，暂停标志必须在新通知出现时归零，
  // 否则下一条通知会一出现就处于暂停状态，再也不自动收起。
  useEffect(() => {
    setNoticeHovered(false);
    setNoticeFocused(false);
  }, [notice]);
  useEffect(() => () => noticeTimerRef.current.cancel(), []);
  // Announce the end of a merge/rebase once, after the banner disappears.
  useEffect(() => {
    const operation = state?.operation ?? null;
    if (operation) {
      operationNoticeRef.current = operation;
      return;
    }
    if (operationNoticeRef.current) {
      operationNoticeRef.current = null;
      setNotice(operationFinishedNotice());
    }
  }, [state?.operation]);
  function openCommandPalette(trigger = document.activeElement) {
    paletteReturnFocusRef.current = trigger instanceof HTMLElement ? trigger : paletteTriggerRef.current;
    setPaletteOpen(true);
  }
  function closeCommandPalette() {
    setPaletteOpen(false);
    requestAnimationFrame(() => paletteReturnFocusRef.current?.focus?.());
  }
  function escapeCurrentContext() {
    if (safetyPlan) { setSafetyPlan(null); return; }
    if (branchPlan) { setBranchPlan(null); return; }
    if (remotePlan) { setRemotePlan(null); return; }
    if (recoveryOpen) { setRecoveryOpen(false); return; }
    if (historyResult || historyFile) { setHistoryResult(null); setHistoryFile(null); return; }
    if (historyMode) {
      const next = resolveHistoryEscape(historyDraft, historyApplied);
      if (next.kind === "discard-draft") setHistoryDraft(next.filters);
      else if (next.kind === "reset-applied") applyHistoryFilters(undefined, true);
      else setHistoryMode(false);
    }
  }
  useEffect(() => {
    const onKeyDown = (event) => {
      const action = resolveShortcut(event, {
        paletteOpen,
        blockingContextOpen,
        historyMode,
        loading,
        hasStaged: staged.length > 0,
        hasMessage: Boolean(message.trim()),
      });
      if (!action) return;
      event.preventDefault();
      if (action === "open-palette") openCommandPalette(document.activeElement);
      else if (action === "close-palette") closeCommandPalette();
      else if (action === "focus-history-search") {
        historySearchRef.current?.focus();
        historySearchRef.current?.select();
      } else if (action === "toggle-ledger") setLedgerOpen((value) => !value);
      else if (action === "commit") operate("commit", { message });
      else if (action === "escape") escapeCurrentContext();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [paletteOpen, blockingContextOpen, historyMode, loading, staged.length, message, safetyPlan, branchPlan, remotePlan, recoveryOpen, historyResult, historyFile, historyDraft, historyApplied]);
  const paletteCommands = useMemo(() => {
    const availability = commandAvailability({
      hasRepository: Boolean(repo),
      loading,
      historyMode,
      selectedArea: selected?.area,
    });
    return [
      { id: "open-repository", label: "打开仓库", shortcut: commandShortcut, keywords: "打开 文件夹 仓库", ...availability.openRepository, run: chooseRepo },
      { id: "refresh", label: "刷新工作区", keywords: "刷新 状态", ...availability.refresh, run: refreshFromUser },
      { id: "workspace", label: "前往工作区", keywords: "工作区 文件", ...availability.workspace, run: () => setHistoryMode(false) },
      { id: "history", label: "前往历史审查", keywords: "历史 提交", ...availability.history, run: () => setHistoryMode(true) },
      { id: "ledger", label: ledgerOpen ? "收起命令账本" : "展开命令账本", shortcut: ledgerShortcut, keywords: "账本 命令", ...availability.ledger, run: () => setLedgerOpen((value) => !value) },
      { id: "history-search", label: "聚焦历史搜索", shortcut: historySearchShortcut, keywords: "历史 搜索", ...availability.historySearch, run: () => { historySearchRef.current?.focus(); historySearchRef.current?.select(); } },
      { id: "stage-selected", label: "暂存当前选中文件", keywords: "暂存 文件", ...availability.stageSelected, run: () => selected?.area === "unstaged" && operate("stage", { path: selected.path }) },
    ];
  }, [repo, loading, historyMode, ledgerOpen, selected, commandShortcut, ledgerShortcut, historySearchShortcut]);
  function executePaletteCommand(command) {
    if (!command.available) return;
    closeCommandPalette();
    command.run();
  }
  const inspector = safetyPlan ? (
    <SafetyContext
      plan={safetyPlan}
      acknowledgement={acknowledgement}
      onAcknowledgement={setAcknowledgement}
      loading={loading}
      onConfirm={confirmSafety}
      onCancel={() => setSafetyPlan(null)}
    />
  ) : branchPlan ? (
    <BranchContext
      plan={branchPlan}
      loading={loading}
      onConfirm={confirmBranch}
      onCancel={() => setBranchPlan(null)}
    />
  ) : remotePlan ? (
    <RemotePlanContext
      plan={remotePlan}
      loading={loading}
      onConfirm={confirmRemote}
      onCancel={() => setRemotePlan(null)}
    />
  ) : recoveryOpen ? (
    <RecoveryContext
      entries={reflogEntries}
      reason={reflogReason}
      loading={loading}
      onRescue={requestRescue}
      onClose={() => setRecoveryOpen(false)}
    />
  ) : selected ? (
    <FileInspector
      file={selected}
      loading={loading}
      onStage={(file) =>
        operate(file.area === "staged" ? "unstage" : "stage", {
          path: file.path,
        })
      }
      onDiscard={requestDiscard}
    />
  ) : (
    <CommitInspector
      staged={staged}
      unstaged={unstaged}
      message={message}
      loading={loading}
      onMessage={setMessage}
      onOperate={operate}
      preview={preview}
      platform={shortcutPlatform}
    />
  );
  const detailSubject = historyDetail?.subject || historySelected?.subject || "";
  const detailAuthor = historyDetail?.authorName || historySelected?.author || "";
  const detailEmail = historyDetail?.authorEmail || "";
  const detailTime = historyDetail?.authoredAt || historySelected?.authoredAt || "";
  const historyTitle = historyFile
    ? "文件历史"
    : historyResult?.kind === "compare"
      ? "提交比较"
      : historyResult?.kind === "file"
        ? "文件 Diff"
        : historyResult
          ? "提交 Diff"
          : "提交历史";
  const historySubtitle = historyFile
    ? historyFile.path
    : historyResult?.kind === "compare"
      ? `基准 ${historyResult.baseShort} → 对比 ${historyResult.targetShort}`
      : historyResult?.kind === "file"
        ? `${historyResult.path} @ ${historyResult.shortHash}`
        : historyResult
          ? historySelected?.subject || ""
          : historySelected?.subject || "选择提交以查看审阅详情";
  const historyNotice = loading
    ? "正在读取历史…"
    : historyResult?.truncated
      ? "Diff 已截断，可在命令账本复制真实命令后在终端查看完整输出。"
      : historyResult?.kind === "compare" && historyResult.ok
        ? `比较方向「基准 → 对比」：${historyResult.baseShort} → ${historyResult.targetShort}`
        : historyResult?.binary && historyResult.ok
          ? "结果中包含二进制文件，Git 无法为它们生成文本 Diff。"
          : "";
  return (
    <main
      className={`app-shell ${ledgerOpen ? "ledger-open" : "ledger-closed"} ${isDarwin ? "platform-darwin" : ""} ${workspaceBanner ? "has-banner" : ""}`}
    >
      <a className="skip-link" href="#workspace-main">
        跳至主工作区
      </a>
      <header className="topbar">
        <div className="brand">
          <BrandMark size={20} />
          <h1>GitGlass</h1>
          <span className="topbar-divider" />
          <strong title={repo || ""}>{basename(repo)}</strong>
        </div>
        <div className="top-state">
          <span>
            <GitBranch size={14} />
            <code>{state.branch || "—"}</code>
          </span>
          <span className={state.files.length ? "dirty" : "clean"}>
            {repo
              ? state.files.length
                ? `${state.files.length} 个改动`
                : "工作区干净"
              : "等待仓库"}
          </span>
          {remote?.upstream && (
            <span className="sync-counts">
              <b className={remote.ahead > 0 ? "ahead" : ""}>
                ↑ {remote.ahead}
              </b>
              <b className={remote.behind > 0 ? "behind" : ""}>
                ↓ {remote.behind}
              </b>
            </span>
          )}
        </div>
        <div className="top-actions">
          <UpdateButton updates={updates} disabled={modalOpen} />
          <button
            type="button"
            className="toolbar-button"
            ref={paletteTriggerRef}
            onClick={(event) => openCommandPalette(event.currentTarget)}
            aria-label="命令面板"
            title={`命令面板（${commandShortcut}）`}
            aria-haspopup="dialog"
            aria-keyshortcuts={isDarwin ? "Meta+K" : "Control+K"}
            disabled={loading || blockingContextOpen}
          >
            <MagnifyingGlass size={15} />
            <span className="top-action-label">命令</span>
          </button>
          <button type="button" className="toolbar-button" onClick={() => setHistoryMode(false)} aria-label="工作区" title="工作区" aria-pressed={!historyMode}>
            <File size={15} aria-hidden="true" />
            <span className="top-action-label">工作区</span>
          </button>
          <button type="button" className="toolbar-button" onClick={() => setHistoryMode(true)} aria-label="历史审查" title="历史审查" aria-pressed={historyMode}>
            <GitCommit size={15} aria-hidden="true" />
            <span className="top-action-label">历史审查</span>
          </button>
          <button
            type="button"
            className="toolbar-button"
            aria-label="恢复"
            title="恢复"
            disabled={!repo || loading}
            onClick={openRecovery}
          >
            <Lifebuoy size={15} />
            <span className="top-action-label">恢复</span>
          </button>
          <span className="topbar-divider" aria-hidden="true" />
          <button type="button" className="secondary-button" onClick={chooseRepo} aria-label="打开仓库" title="打开仓库" disabled={loading}>
            <FolderOpen size={15} />
            <span className="top-action-label">打开仓库</span>
          </button>
          <RecentRepositoriesMenu
            repositories={recentRepositories}
            currentPath={repo}
            disabled={loading}
            onOpen={openRecentRepository}
            onForget={forgetRecentRepository}
          />
          <button
            type="button"
            className="secondary-button"
            aria-label="获取远程更新（先查看计划）"
            title="获取远程更新（先查看计划，不会立即执行）"
            disabled={!repo || loading || !remote?.remotes?.length}
            onClick={() => requestRemote("fetch")}
          >
            <ArrowClockwise size={15} />
            <span className="top-action-label">获取…</span>
          </button>
        </div>
      </header>
      {workspaceBanner && (
        <div
          className={`app-notice ${workspaceBanner.type}`}
          role="status"
          aria-live="polite"
          onMouseEnter={() => setNoticeHovered(true)}
          onMouseLeave={() => setNoticeHovered(false)}
          onFocus={() => setNoticeFocused(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setNoticeFocused(false);
          }}
        >
          {workspaceBanner.type === "success" ? (
            <CheckCircle size={15} weight="fill" />
          ) : (
            <WarningCircle size={15} weight="fill" />
          )}
          <span>{workspaceBanner.text}</span>
          {!operationBanner && (
            <>
              <button
                type="button"
                className="app-notice-pin"
                aria-pressed={Boolean(notice?.pinned)}
                title={notice?.pinned ? "取消钉住：恢复自动收起" : `钉住提示：不再自动收起（默认 ${AUTO_DISMISS_MS / 1000} 秒后收起）`}
                onClick={() => setNotice((current) => (current ? { ...current, pinned: !current.pinned } : current))}
              >
                {notice?.pinned ? "已钉住" : "钉住"}
              </button>
              <button type="button" className="app-notice-dismiss" onClick={() => setNotice(null)} aria-label="关闭提示">×</button>
            </>
          )}
        </div>
      )}
      {historyMode ? <div ref={workspaceRef} id="workspace-main" className="workspace history-workspace" style={{ "--left-panel-width": `${panelWidths.left}px`, "--right-panel-width": `${panelWidths.right}px` }} tabIndex="-1">
        <aside className="status-panel">
          <div className="panel-heading"><h2>历史审查</h2></div>
          <p className="inspector-copy">默认读取最近 80 条；应用筛选后最多返回 200 条。所有查询都作为系统读取记录在命令账本中。</p>
          <HistoryFilters
            draft={historyDraft}
            branches={branches}
            currentBranch={state.branch}
            selectedFile={selected}
            loading={loading}
            dirty={historyFiltersDirty}
            onChange={(field, value) => setHistoryDraft((draft) => ({ ...draft, [field]: value }))}
            onApply={() => applyHistoryFilters()}
            onReset={() => applyHistoryFilters(undefined, true)}
            onUseSelected={() => selected && setHistoryDraft((draft) => ({ ...draft, filePath: selected.path }))}
          />
          <section className="branch-list compare-panel">
            <div className="section-label"><span>双提交比较</span></div>
            <p className="selection-line">
              基准 {historyCompare.base ? (
                <>
                  <code>{historyCompare.base.shortHash}</code>
                  <span className="selection-subject" title={historyCompare.base.subject}>{historyCompare.base.subject}</span>
                </>
              ) : "未选择"}
            </p>
            <p className="selection-line">
              对比 {historyCompare.target ? (
                <>
                  <code>{historyCompare.target.shortHash}</code>
                  <span className="selection-subject" title={historyCompare.target.subject}>{historyCompare.target.subject}</span>
                </>
              ) : "未选择"}
            </p>
            {historyCompare.base && historyCompare.target && (
              <>
                <p className="compare-direction">
                  比较方向：<code>{historyCompare.base.shortHash}</code> → <code>{historyCompare.target.shortHash}</code>（基准 → 对比）
                </p>
                <div className="compare-actions">
                  <button
                    type="button"
                    className="secondary-action"
                    aria-label="交换基准提交与对比提交"
                    title="交换基准提交与对比提交"
                    onClick={swapCompare}
                  >
                    <ArrowsLeftRight size={14} aria-hidden="true" />
                    交换
                  </button>
                  <button type="button" className="secondary-action" onClick={readCompare} disabled={loading}>
                    读取比较
                  </button>
                </div>
              </>
            )}
            {(historyCompare.base || historyCompare.target) && (
              <button
                type="button"
                className="text-action"
                aria-label="清除比较选择"
                title="清除比较选择"
                onClick={() => setHistoryCompare({ base: null, target: null })}
              >
                清除比较选择
              </button>
            )}
          </section>
        </aside>
        <PanelSplitter side="left" value={panelWidths.left} limits={getPanelLimits("left")} onPointerDown={startPanelResize} onDoubleClick={resetPanelWidth} onKeyDown={resizePanelWithKeyboard} />
        <section className="main-panel">
          <div className="main-toolbar">
            <div>
              <h2>{historyTitle}</h2>
              <span title={historySubtitle}>{historySubtitle}</span>
            </div>
            {historyResult?.record && (
              <button
                type="button"
                className="icon-button"
                aria-label="复制真实 Git 命令"
                title="复制真实 Git 命令"
                onClick={() => navigator.clipboard?.writeText(historyResult.record?.displayCommand || "")}
              >
                <Copy size={15} aria-hidden="true" />
              </button>
            )}
            {historyResult && (
              <button
                type="button"
                className="secondary-action"
                aria-label="返回提交列表"
                title="返回提交列表"
                onClick={() => { setHistoryResult(null); setHistoryFile(null); }}
              >
                返回列表
              </button>
            )}
          </div>
          <div className="main-content"><div className="history-notice" role="status" aria-live="polite">{historyNotice}</div>
            <div className="history-view">
              {historyResult ? (
                <HistoryResult result={historyResult} onBack={() => { setHistoryResult(null); setHistoryFile(null); }} />
              ) : (
                <div className="history-browser">
                  {!historyFile && (
                    <>
                      <HistorySearch
                        value={historyDraft.keyword}
                        onChange={(keyword) => setHistoryDraft((draft) => ({ ...draft, keyword }))}
                        onSubmit={() => applyHistoryFilters()}
                        inputRef={historySearchRef}
                        total={commits.length}
                        shortcut={historySearchShortcut}
                        loading={loading}
                      />
                      {historyApplied && <p className="history-filter-summary" aria-live="polite">已应用：{historyApplied.keyword && <code>关键词：{historyApplied.keyword}</code>}{historyApplied.author && <code>作者：{historyApplied.author}</code>}{historyApplied.branch && <code>分支：{historyApplied.branch}</code>}{historyApplied.filePath && <code>文件：{historyApplied.filePath}</code>}</p>}
                    </>
                  )}
                  <div className="commit-list">
                    {!repo ? (
                      <div className="history-empty"><p>打开仓库后可查看提交历史。</p></div>
                    ) : loading && !commits.length && !historyFile ? (
                      <div className="history-empty"><p>正在读取提交历史…</p></div>
                    ) : historyFile ? (
                      (historyFile.entries || []).length ? (
                        historyFile.entries.map((entry) => (
                          <CommitRow
                            key={entry.hash}
                            commit={entry}
                            selected={false}
                            onSelect={() => openFileEntryDiff(entry)}
                            busy={loading}
                          />
                        ))
                      ) : (
                        <div className="history-empty">
                          <p>此文件没有可读取的历史提交。</p>
                          {historyFile.reason && <span>{historyFile.reason}</span>}
                        </div>
                      )
                    ) : !commits.length && historyApplied ? (
                      <div className="history-empty">
                        <MagnifyingGlass size={22} aria-hidden="true" />
                        <p>当前筛选条件下没有匹配的提交。</p>
                        <span>可以调整条件后再次应用，或重置筛选查看最近提交。</span>
                        <button type="button" className="secondary-action" onClick={() => applyHistoryFilters(undefined, true)} disabled={loading}>
                          重置筛选
                        </button>
                      </div>
                    ) : commitsReason ? (
                      <div className="history-empty"><p>{commitsReason}</p></div>
                    ) : (
                      commits.map((commit) => (
                        <CommitRow
                          key={commit.hash}
                          commit={commit}
                          selected={historySelected?.hash === commit.hash}
                          compareRole={
                            historyCompare.base?.hash === commit.hash
                              ? "base"
                              : historyCompare.target?.hash === commit.hash
                                ? "target"
                                : null
                          }
                          onSelect={() => selectHistoryCommit(commit)}
                          onCompare={() => pinCompare(commit)}
                          busy={loading}
                        />
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
        <PanelSplitter side="right" value={panelWidths.right} limits={getPanelLimits("right")} onPointerDown={startPanelResize} onDoubleClick={resetPanelWidth} onKeyDown={resizePanelWithKeyboard} />
        <aside className="context-panel">
          {historyFile ? (
            <div className="inspector-flow">
              <div className="inspector-heading"><span>文件历史</span><h2 title={historyFile.path}>{historyFile.path}</h2></div>
              <p className="inspector-copy">点击左侧列表中的提交，可查看该文件在对应提交中的真实 Diff。</p>
              <button type="button" className="text-action" onClick={() => { setHistoryFile(null); setHistoryResult(null); }}>
                返回提交详情
              </button>
            </div>
          ) : historySelected ? (
            <div className="inspector-flow">
              <div className="inspector-heading"><span>提交详情</span><h2 title={detailSubject}>{detailSubject}</h2></div>
              <dl className="file-facts">
                <div>
                  <dt>完整 SHA</dt>
                  <dd>
                    <code title={historySelected.hash}>{historySelected.hash}</code>
                    <CopyButton value={historySelected.hash} label="复制完整 SHA" />
                  </dd>
                </div>
                <div>
                  <dt>父提交</dt>
                  <dd className="parent-list">
                    {historySelected.parents?.length ? (
                      historySelected.parents.map((parent) => (
                        <button
                          type="button"
                          className="parent-link"
                          key={parent}
                          title={`查看父提交 ${parent}`}
                          aria-label={`查看父提交 ${parent}`}
                          onClick={() => viewParentCommit(parent)}
                        >
                          <code>{parent.slice(0, 7)}</code>
                        </button>
                      ))
                    ) : (
                      <span className="initial-commit">初始提交（没有父提交）</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>作者</dt>
                  <dd title={detailAuthor}>{detailAuthor || "—"}</dd>
                </div>
                <div>
                  <dt>邮箱</dt>
                  <dd title={detailEmail}>{detailEmail || "—"}</dd>
                </div>
                <div>
                  <dt>时间</dt>
                  <dd className="commit-time">
                    <span>{relativeTime(detailTime)}</span>
                    <span className="full-time" title={fullLocalTime(detailTime)}>{fullLocalTime(detailTime)}</span>
                  </dd>
                </div>
              </dl>
              <div className="commit-stats" aria-label="变更统计">
                <span className="stat-chip">变更文件 {historyDetail?.filesChanged ?? 0}</span>
                <span className="stat-chip added">新增 +{historyDetail?.insertions ?? 0}</span>
                <span className="stat-chip deleted">删除 −{historyDetail?.deletions ?? 0}</span>
              </div>
              <div className="commit-message-block">
                <span className="section-label">完整提交说明</span>
                <pre className="commit-message">{historyDetail?.message || detailSubject}</pre>
              </div>
              <button type="button" className="secondary-button" onClick={readHistoryDiff} disabled={loading}>
                查看完整 Diff
              </button>
              <section className="history-files">
                <h3>改动文件</h3>
                {historyDetail?.changedFiles?.length ? (
                  historyDetail.changedFiles.map((file) => {
                    const kind = changeOf(file.status);
                    return (
                      <div className="history-file-row" key={`${file.status}-${file.path}`}>
                        <button
                          type="button"
                          className="history-file"
                          title={`查看 ${file.path} 在此提交中的 Diff`}
                          onClick={() => openCommitFileDiff(file)}
                          disabled={loading}
                        >
                          <span className={`file-kind-tag ${kind}`}>
                            {changeKindLetter[kind]} {titleFor[kind]}
                          </span>
                          <code>{file.path}</code>
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`查看 ${file.path} 的文件历史`}
                          title={`查看 ${file.path} 的文件历史`}
                          onClick={() => openFileHistory(file.path)}
                          disabled={loading}
                        >
                          <GitCommit size={14} aria-hidden="true" />
                        </button>
                      </div>
                    );
                  })
                ) : (
                  <p className="inspector-copy">{loading ? "正在读取改动文件…" : "没有读取到改动文件。"}</p>
                )}
              </section>
            </div>
          ) : (
            <div className="inspector-flow">
              <h2>选择一个提交</h2>
              <p className="inspector-copy">这是只读审阅，不会切换分支或改写工作区。选中提交后可查看详情、文件 Diff，并可将两个提交加入比较。</p>
            </div>
          )}
        </aside>
      </div> : <div ref={workspaceRef} id="workspace-main" className="workspace" style={{ "--left-panel-width": `${panelWidths.left}px`, "--right-panel-width": `${panelWidths.right}px` }} tabIndex="-1">
        <aside className="status-panel">
          <div className="panel-heading">
            <h2>工作区</h2>
            {repo && (
              <button
                type="button"
                className="icon-button"
                onClick={refreshFromUser}
                aria-label="刷新状态"
                title="刷新状态"
                disabled={loading}
              >
                <ArrowClockwise size={15} />
              </button>
            )}
          </div>
          {repo ? (
            <>
              <FileSection
                title="未暂存改动"
                files={unstaged}
                emptyText={state.files.length ? "没有未暂存的改动。" : "工作区干净，没有待暂存的改动。"}
                selected={selected}
                onSelect={loadDiff}
                onStage={(file) => operate("stage", { path: file.path })}
                toolbar={
                  <BatchStageToolbar
                    total={unstaged.length}
                    count={checkedCount}
                    loading={loading}
                    onSelectAll={selectAllUnstaged}
                    onClear={clearStageSelection}
                    onStageSelected={() =>
                      operate("stageSelected", {
                        paths: checkedForStaging.map((file) => file.path),
                      })
                    }
                  />
                }
                checkable
                isChecked={(file) =>
                  stageSelection.has(stageSelectionKey(file.path))
                }
                onToggleCheck={toggleStageSelection}
                busy={loading}
              />
              <FileSection
                title="已暂存改动"
                files={staged}
                emptyText="没有已暂存的改动。"
                selected={selected}
                onSelect={loadDiff}
                onStage={(file) => operate("unstage", { path: file.path })}
              />
              {!state.files.length && (
                <div className="clean-state">
                  <CheckCircle size={17} weight="fill" />
                  工作区干净，没有待暂存的改动。
                </div>
              )}
              <section className="branch-list">
                <div className="section-label">
                  <span>本地分支</span>
                  <b>{branches.length}</b>
                </div>
                {branches.map((branch) => {
                  const current =
                    branchName(branch) === state.branch || branch.current;
                  return (
                    <div className="branch-item" key={branchName(branch)}>
                      <button
                        type="button"
                        className={`branch-row ${current ? "current" : ""}`}
                        onClick={() => requestSwitch(branch)}
                        disabled={loading}
                      >
                        <GitBranch size={14} />
                        <code>{branchName(branch)}</code>
                        {current && <span>当前</span>}
                      </button>
                      {!current && (
                        <button
                          type="button"
                          className="branch-delete"
                          aria-label={`删除已合并分支 ${branchName(branch)}`}
                          title="删除已合并分支"
                          onClick={() =>
                            requestDeleteMergedBranch(branchName(branch))
                          }
                          disabled={loading}
                        >
                          <Trash size={14} />
                        </button>
                      )}
                    </div>
                  );
                })}
                <div className="branch-create">
                  <input
                    name="branch-name"
                    autoComplete="off"
                    value={newBranch}
                    onChange={(event) => setNewBranch(event.target.value)}
                    placeholder="新分支名称"
                    aria-label="新分支名称"
                  />
                  <button
                    type="button"
                    className="secondary-action"
                    disabled={!newBranch.trim() || loading}
                    onClick={() => requestSwitch(newBranch, true)}
                  >
                    创建
                  </button>
                </div>
              </section>
              <SidebarRemote
                remote={remote}
                files={state.files}
                loading={loading}
                onFetch={() => requestRemote("fetch")}
                onPush={() => requestRemote("push")}
                onPull={() => requestRemote("pull")}
              />
            </>
          ) : (
            <div className="empty-repo">
              <FolderOpen size={24} />
              <p>打开本地 Git 仓库</p>
              <span>查看改动、历史与真实命令记录。</span>
              <button
                type="button"
                className="primary-button"
                onClick={chooseRepo}
                disabled={loading}
              >
                打开仓库
              </button>
            </div>
          )}
        </aside>
        <PanelSplitter side="left" value={panelWidths.left} limits={getPanelLimits("left")} onPointerDown={startPanelResize} onDoubleClick={resetPanelWidth} onKeyDown={resizePanelWithKeyboard} />
        <section className="main-panel">
          <div className="main-toolbar">
            <div>
              <h2>{selected ? "文件差异" : "提交历史"}</h2>
              <span title={selected?.path || (commits.length ? `最近 ${commits.length} 个提交` : "选择仓库后读取提交记录")}>
                {selected?.path ||
                  (commits.length
                    ? `最近 ${commits.length} 个提交`
                    : "选择仓库后读取提交记录")}
              </span>
            </div>
            {selected && (
              <span className={`file-kind ${selected.status}`}>
                {titleFor[selected.status]}
              </span>
            )}
          </div>
          {selected ? (
            <div className="diff-view">
              <div className="diff-meta">
                <span
                  className={
                    selected.area === "staged" ? "staged-diff-label" : ""
                  }
                >
                  {selected.area === "staged" ? "已暂存差异" : "工作区差异"}
                </span>
                <code>{selected.path}</code>
              </div>
              {diffMessage ? (
                <div className="diff-empty" role="status" aria-live="polite">
                  <p>{diffMessage}</p>
                </div>
              ) : (
                <DiffContent diff={diff} />
              )}
            </div>
          ) : (
            <CommitGraph commits={commits} />
          )}
        </section>
        <PanelSplitter side="right" value={panelWidths.right} limits={getPanelLimits("right")} onPointerDown={startPanelResize} onDoubleClick={resetPanelWidth} onKeyDown={resizePanelWithKeyboard} />
        <aside className="context-panel">{inspector}</aside>
      </div>}
      <section className="command-ledger" aria-label="命令账本">
        <div className="ledger-bar">
          <button
            type="button"
            className="ledger-title"
            onClick={() => setLedgerOpen(!ledgerOpen)}
            aria-expanded={ledgerOpen}
            aria-keyshortcuts={isDarwin ? "Meta+J" : "Control+J"}
            title={`${ledgerShortcut} 展开或收起命令账本`}
          >
            <TerminalWindow size={16} />
            <span>命令账本</span>
            <CaretDown size={14} className={ledgerOpen ? "open" : ""} />
          </button>
          {!ledgerOpen && (
            <button
              type="button"
              className="ledger-glance"
              onClick={() => setLedgerOpen(true)}
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
          {ledgerOpen && (
            <div className="ledger-filter">
              <button
                type="button"
                className={ledgerFilter === "user" ? "active" : ""}
                onClick={() => {
                  setLedgerFilter("user");
                  setFocusedOperationId(null);
                }}
              >
                用户操作 {ledgerCounts.user}
              </button>
              <button
                type="button"
                className={ledgerFilter === "background" ? "active" : ""}
                onClick={() => {
                  setLedgerFilter("background");
                  setFocusedOperationId(null);
                }}
              >
                系统读取 {ledgerCounts.background}
              </button>
              <button
                type="button"
                className={ledgerFilter === "all" ? "active" : ""}
                onClick={() => {
                  setLedgerFilter("all");
                  setFocusedOperationId(null);
                }}
              >
                全部 {records.length}
              </button>
            </div>
          )}
        </div>
        <div className="ledger-body">
          {ledgerOpen && (
            <>
              <p className="ledger-note">
                用户操作与系统读取均会记录实际执行的 Git 命令；系统读取仅用于同步界面状态，不修改仓库。
              </p>
              <div className="ledger-list">
                {ledgerGroups.length ? (
                  ledgerGroups.map((group, index) =>
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
      {updates.open && (
        <UpdateDialog
          updates={updates}
          blockedReason={loading ? "Git 操作尚未完成，请完成后再更新。" : modalOpen ? "请先完成或关闭当前操作。" : ""}
          onInstall={() => updates.install({ commitMessage: message, historyMode })}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          commands={paletteCommands}
          platform={shortcutPlatform}
          onClose={closeCommandPalette}
          onExecute={executePaletteCommand}
        />
      )}
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
