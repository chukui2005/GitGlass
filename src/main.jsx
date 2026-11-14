import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowClockwise,
  ArrowsLeftRight,
  CaretDown,
  CheckCircle,
  CircleNotch,
  Copy,
  DownloadSimple,
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
  UploadSimple,
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
  recordStatusLabel,
  recordTypeLabel,
} from "./workbench-ledger.js";
import {
  binaryDiffPattern,
  changeKindLetter,
  changeOf,
  filterCommits,
  fullLocalTime,
  isHeadCommit,
  orderComparePair,
  relativeTime,
} from "./history-search.js";
import { BrandMark } from "./brand-mark.jsx";
import { executionNotice, GENERIC_GIT_FAILURE, operationNotice } from "./user-notices.js";
import { canStartRepositoryContextOperation, resolveRepositoryRefresh } from "./repository-refresh.js";
import { resolveShortcut, shortcutLabel } from "./shortcut-policy.js";
import { commandAvailability } from "./command-palette-model.js";
import "./styles.css";

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

function DiffLine({ line }) {
  const kind =
    line.startsWith("+") && !line.startsWith("+++")
      ? "plus"
      : line.startsWith("-") && !line.startsWith("---")
        ? "minus"
        : line.startsWith("@@")
          ? "hunk"
          : "";
  return (
    <div className={`diff-line ${kind}`}>
      <span>{kind === "plus" ? "+" : kind === "minus" ? "−" : " "}</span>
      <code>{line}</code>
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
  async function copy() {
    await navigator.clipboard?.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }
  return (
    <article
      className={`ledger-entry ${failure ? "failure" : ""} ${record.source === "background" ? "background" : ""}`}
    >
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
        <span className="ledger-intent">{intentLabel(record)}</span>
        {!expanded && <code>{command}</code>}
        <time>{time(record.startedAt)}</time>
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
          <div className={`risk-label ${tone}`}>
            {tone === "high"
              ? "高风险：不可直接撤销"
              : tone === "caution"
                ? "谨慎：删除已合并本地分支"
                : "安全：创建救援分支"}
          </div>
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
        <h2>{file.path}</h2>
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
          aria-label="获取远程状态"
          onClick={onFetch}
          disabled={loading}
        >
          <ArrowClockwise size={14} />
        </button>
      </div>
      <code>{remote.remote?.name || "—"}</code>
      <span>{remote.remote?.url}</span>
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

function HistorySearch({ value, onChange, inputRef, filtered, matchCount, total, shortcut }) {
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
        {filtered ? `匹配 ${matchCount} / ${total}` : `共 ${total} 个提交`}
      </span>
    </div>
  );
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
    <div className="diff-content">
      {diff.split("\n").map((line, index) =>
        binaryDiffPattern.test(line.trim()) ? (
          <div className="diff-binary" key={index}>
            二进制文件差异：Git 无法生成文本内容；完整命令结果已记录在命令账本。
          </div>
        ) : (
          <DiffLine key={index} line={line} />
        ),
      )}
    </div>
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
        <p className="palette-hint">↑↓ 选择　Enter 执行　Esc 关闭</p>
      </section>
    </div>
  );
}

function App() {
  const [historyMode, setHistoryMode] = useState(false);
  const [historySelected, setHistorySelected] = useState(null);
  const [historyDetail, setHistoryDetail] = useState(null);
  const [historyResult, setHistoryResult] = useState(null);
  const [historyCompare, setHistoryCompare] = useState({ base: null, target: null });
  const [historyFile, setHistoryFile] = useState(null);
  const [historySearch, setHistorySearch] = useState("");
  const [commitsReason, setCommitsReason] = useState("");
  const [repo, setRepo] = useState(null);
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
  const refreshSequence = useRef(0);
  const refreshCycles = useRef(new Map());
  const historySearchRef = useRef(null);
  const paletteTriggerRef = useRef(null);
  const paletteReturnFocusRef = useRef(null);
  const detailCache = useRef(new Map());
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
    refreshAll();
  }, []);
  // 历史搜索为纯前端过滤：输入不会触发额外 Git 命令。
  const historyFilter = useMemo(
    () => filterCommits(commits, historySearch),
    [commits, historySearch],
  );
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
    setRemote(null);
    setHistoryMode(false);
    setHistorySelected(null);
    setHistoryDetail(null);
    setHistoryResult(null);
    setHistoryFile(null);
    setHistoryCompare({ base: null, target: null });
    detailCache.current.clear();
  }
  async function refreshAll(preference, options) {
    const cycle = `refresh-${Date.now()}-${++refreshSequence.current}`;
    const next = await window.gitglass.getState();
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
    const [branchResult, commitResult, remoteResult] = await Promise.all([
      window.gitglass.getBranches(),
      window.gitglass.getCommits(),
      window.gitglass.getRemoteOverview(),
    ]);
    setBranches(branchResult.branches || []);
    setCommits(commitResult.commits || []);
    setCommitsReason(commitResult.reason || "");
    setRemote(remoteResult);
    await refreshLedger(cycle);
    return resolved;
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
  async function loadDiff(file, cycle) {
    setSelected(file);
    setDiff("");
    setDiffMessage("正在读取文件差异…");
    const result = await window.gitglass.getDiff(file);
    if (!result.ok) {
      setDiffMessage("无法读取此文件的差异。请刷新工作区后重试；诊断信息已保留在命令账本。");
    } else if (binaryDiffPattern.test(result.stdout || "")) {
      setDiffMessage("这是二进制文件，Git 无法显示文本差异。请在命令账本查看诊断信息。");
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
      const opened = resolveRepositoryRefresh(repo, result.state, { notifyOnFailure: true });
      if (!opened.ok) {
        clearStaleRepositoryState(opened);
        setLedgerOpen(true);
        setLedgerFilter("background");
        setNotice({ type: "error", text: opened.message });
        await refreshLedger();
        return;
      }
      setRepo(result.path);
      // 切换仓库后清空历史审阅状态，避免旧仓库的选中提交与缓存混入。
      detailCache.current.clear();
      setHistorySelected(null);
      setHistoryDetail(null);
      setHistoryResult(null);
      setHistoryFile(null);
      setHistoryCompare({ base: null, target: null });
      setHistorySearch("");
      // 切换仓库后清空批量暂存选择，避免旧仓库的勾选混入新仓库。
      setStageSelection(new Set());
      const refreshed = await refreshAll(undefined, { notifyOnFailure: true });
      if (refreshed.ok) setNotice({ type: "success", text: `已打开仓库：${result.path}` });
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
      if (historySearch) setHistorySearch("");
      else setHistoryMode(false);
    }
  }
  useEffect(() => {
    const onKeyDown = (event) => {
      const action = resolveShortcut(event, {
        paletteOpen,
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
  }, [paletteOpen, historyMode, loading, staged.length, message, safetyPlan, branchPlan, remotePlan, recoveryOpen, historyResult, historyFile, historySearch]);
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
      className={`app-shell ${ledgerOpen ? "ledger-open" : "ledger-closed"} ${isDarwin ? "platform-darwin" : ""}`}
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
          <button
            type="button"
            className="top-action"
            ref={paletteTriggerRef}
            onClick={(event) => openCommandPalette(event.currentTarget)}
            title={`命令面板（${commandShortcut}）`}
            aria-haspopup="dialog"
            aria-keyshortcuts={isDarwin ? "Meta+K" : "Control+K"}
          >
            <MagnifyingGlass size={15} />
            命令
          </button>
          <button type="button" className="top-action" onClick={() => setHistoryMode(false)} aria-pressed={!historyMode}>工作区</button>
          <button type="button" className="top-action" onClick={() => setHistoryMode(true)} aria-pressed={historyMode}>历史审查</button>
          <button
            type="button"
            className="top-action"
            disabled={!repo || loading}
            onClick={openRecovery}
          >
            <Lifebuoy size={15} />
            恢复
          </button>
          <button type="button" className="top-action" onClick={chooseRepo} disabled={loading}>
            <FolderOpen size={15} />
            打开仓库
          </button>
          <button
            type="button"
            className="sync-action"
            disabled={!repo || loading || !remote?.remotes?.length}
            onClick={() => requestRemote("fetch")}
          >
            <ArrowClockwise size={15} />
            同步
          </button>
        </div>
      </header>
      {historyMode ? <div id="workspace-main" className="workspace history-workspace" tabIndex="-1">
        <aside className="status-panel">
          <div className="panel-heading"><h2>历史审查</h2></div>
          <p className="inspector-copy">最多读取 80 个提交；所有查询都作为系统读取记录在命令账本中。</p>
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
        <section className="main-panel">
          <div className="main-toolbar">
            <div>
              <h2>{historyTitle}</h2>
              <span>{historySubtitle}</span>
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
                    <HistorySearch
                      value={historySearch}
                      onChange={setHistorySearch}
                      inputRef={historySearchRef}
                      filtered={historyFilter.filtered}
                      matchCount={historyFilter.matches.length}
                      total={commits.length}
                      shortcut={historySearchShortcut}
                    />
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
                    ) : historyFilter.filtered && !historyFilter.matches.length ? (
                      <div className="history-empty">
                        <MagnifyingGlass size={22} aria-hidden="true" />
                        <p>没有匹配的提交</p>
                        <span>未找到与「{historySearch.trim()}」匹配的提交信息、作者名或短 SHA。</span>
                        <button type="button" className="secondary-action" onClick={() => setHistorySearch("")}>
                          清除搜索
                        </button>
                      </div>
                    ) : commitsReason ? (
                      <div className="history-empty"><p>{commitsReason}</p></div>
                    ) : (
                      historyFilter.matches.map((commit) => (
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
              <button type="button" className="primary-action" onClick={readHistoryDiff} disabled={loading}>
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
      </div> : <div id="workspace-main" className="workspace" tabIndex="-1">
        <aside className="status-panel">
          <div className="panel-heading">
            <h2>工作区</h2>
            {repo && (
              <button
                type="button"
                className="icon-button"
                onClick={refreshFromUser}
                aria-label="刷新状态"
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
                        <GitBranch size={13} />
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
                          <Trash size={13} />
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
            </div>
          )}
        </aside>
        <section className="main-panel">
          <div className="main-toolbar">
            <div>
              <h2>{selected ? "文件差异" : "提交历史"}</h2>
              <span>
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
                <div className="diff-content">
                  {diff.split("\n").map((line, index) => (
                    <DiffLine key={index} line={line} />
                  ))}
                </div>
              )}
            </div>
          ) : (
            <CommitGraph commits={commits} />
          )}
        </section>
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
              {notice && (
                <div
                  className={`notice ${notice.type}`}
                  role="status"
                  aria-live="polite"
                >
                  {notice.type === "success" ? (
                    <CheckCircle size={16} weight="fill" />
                  ) : (
                    <WarningCircle size={16} weight="fill" />
                  )}
                  {notice.text}
                </div>
              )}
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
