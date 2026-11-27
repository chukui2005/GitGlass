import { groupReferences, headReference, refCommitShort, refKindLabel, refTargetDescription } from "./history-refs.js";
import { summarizeHistoryGraph } from "./history-graph.js";

const GRAPH_WIDTH = 96;
const GRAPH_HEIGHT = 38;
const NODE_Y = GRAPH_HEIGHT / 2;
// 12px between lanes is still compact inside a 38px row, but wide enough that
// a merge/fork shows as a real diagonal instead of a near-vertical wiggle.
const LANE_STEP = 12;
const LANE_ORIGIN = 14;

function laneX(lane) {
  return LANE_ORIGIN + Math.max(0, lane) * LANE_STEP;
}

/**
 * One SVG row. The graph is intentionally a supplement to the text row, not a
 * second interaction surface: the enclosing commit button owns focus, and the
 * SVG is hidden from assistive technology.
 */
export function CommitGraph({ row, selected = false }) {
  if (!row) return null;
  const boundary = row.boundaryParents?.length > 0;
  return (
    <svg
      className="commit-graph"
      width={GRAPH_WIDTH}
      height={GRAPH_HEIGHT}
      viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
      aria-hidden="true"
      focusable="false"
      data-lane={row.lane}
      data-boundary={boundary ? "true" : "false"}
    >
      {row.segments.map((segment) => (
        <path
          key={`segment-${segment.lane}`}
          className={`graph-segment graph-lane-${segment.lane % 7}`}
          d={`M ${laneX(segment.lane)} ${GRAPH_HEIGHT * segment.from} L ${laneX(segment.lane)} ${GRAPH_HEIGHT * segment.to}`}
        />
      ))}
      {row.parentEdges.filter((edge) => !edge.omitted).map((edge, index) => {
        const x = laneX(edge.fromLane);
        const targetX = laneX(edge.toLane);
        const path = edge.fromLane === edge.toLane
          ? `M ${x} ${NODE_Y} L ${x} ${GRAPH_HEIGHT}`
          : `M ${x} ${NODE_Y} C ${x} ${NODE_Y + 7} ${targetX} ${NODE_Y + 7} ${targetX} ${GRAPH_HEIGHT}`;
        return (
          <FragmentPath
            key={`${edge.parent}-${index}`}
            edge={edge}
            path={path}
            targetX={targetX}
          />
        );
      })}
      <circle
        className={`graph-node graph-lane-${row.lane % 7} ${selected ? "selected" : ""}`}
        cx={laneX(row.lane)}
        cy={NODE_Y}
        r={3.4}
      />
    </svg>
  );
}

function FragmentPath({ edge, path, targetX }) {
  return (
    <>
      <path
        className={`graph-edge graph-lane-${edge.toLane % 7} ${edge.boundary ? "boundary" : ""}`}
        d={path}
        data-parent={edge.parent}
        data-boundary={edge.boundary ? "true" : "false"}
      />
      {edge.boundary && (
        <circle
          className={`graph-boundary graph-lane-${edge.toLane % 7}`}
          cx={targetX}
          cy={GRAPH_HEIGHT - 2}
          r={2}
        />
      )}
    </>
  );
}

export function HistoryGraphNotice({ graph, available = true, fileFiltered = false, loading = false }) {
  if (fileFiltered) {
    return (
      <div className="history-graph-notice list-only" role="note">
        <span>文件筛选仅显示列表</span>
      </div>
    );
  }
  if (!available || !graph?.rows?.length) {
    return loading ? <div className="history-graph-notice" role="status">正在读取提交关系…</div> : null;
  }
  const { atLimit, truncated, boundaryEdges, omittedEdges, overflow } = summarizeHistoryGraph(graph);
  if (!atLimit && !truncated && !boundaryEdges && !overflow && !omittedEdges) return null;
  return (
    <div className="history-graph-notice" role="note" aria-label="提交图范围说明">
      {(truncated || atLimit) && <span>{truncated ? "历史读取已截断" : "仅显示部分提交"}</span>}
      {boundaryEdges > 0 && <span className="graph-boundary-badge" title="虚线指向列表外的父提交">页外父提交 {boundaryEdges}</span>}
      {omittedEdges > 0 && <span className="graph-boundary-badge">省略 {omittedEdges} 条连接</span>}
      {overflow && !omittedEdges && <span>部分连线共用泳道</span>}
    </div>
  );
}

function refButtonLabel(ref) {
  return `定位${refKindLabel(ref)} ${refTargetDescription(ref)} 到提交 ${refCommitShort(ref) || "（不可用）"}`;
}

function RefRow({ ref, activeHash, onSelect }) {
  if (!ref.commit) {
    return (
      <div className="ref-row unresolved" title={`${ref.fullName || ref.shortName}\n${ref.status || "无法解析到提交"}`}>
        <span className="ref-kind">{refKindLabel(ref)}</span>
        <code className="ref-name">{refTargetDescription(ref)}</code>
        <span className="ref-status">{ref.status || "无法解析到提交"}</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      className={`ref-row ${activeHash === ref.commit ? "active" : ""}`}
      title={`${ref.fullName || ref.shortName}\n提交 ${ref.commit}`}
      aria-label={refButtonLabel(ref)}
      data-ref-kind={ref.kind}
      data-ref-name={ref.fullName || ref.shortName}
      data-ref-commit={ref.commit}
      onClick={() => onSelect?.(ref)}
    >
      <span className="ref-kind">
        {refKindLabel(ref)}
        {ref.annotated && <i>附注</i>}
      </span>
      <code className="ref-name">{refTargetDescription(ref)}</code>
      <span className="ref-commit" title={ref.commit}>{refCommitShort(ref)}</span>
    </button>
  );
}

/**
 * Keyboard model: all usable references are buttons, and Up/Down/Home/End move
 * focus between them without leaving the sidebar. Unresolved tags are rendered
 * as non-interactive rows with a readable reason.
 */
export function HistoryRefs({ head, refs = [], reason = "", loading = false, truncated = false, notice = "", activeHash = "", onSelect }) {
  const groups = groupReferences(refs);
  const headRef = headReference(head);

  function moveFocus(event) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll("button.ref-row:not(:disabled)")];
    if (!buttons.length) return;
    const current = buttons.indexOf(document.activeElement);
    let next = current;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else if (event.key === "ArrowDown") next = current < 0 ? 0 : Math.min(buttons.length - 1, current + 1);
    else if (event.key === "ArrowUp") next = current <= 0 ? 0 : current - 1;
    event.preventDefault();
    buttons[next]?.focus();
  }

  return (
    <section className="reference-panel" aria-label="Git 引用" onKeyDown={moveFocus}>
      <div className="section-label">
        <span>引用</span>
        {loading && <b role="status">读取中</b>}
      </div>
      {headRef && (
        <div className="reference-head">
          <span className="reference-group-title">当前 HEAD</span>
          {headRef.commit ? (
            <button
              type="button"
              className={`ref-row head ${activeHash === headRef.commit ? "active" : ""}`}
              title={`${headRef.fullName}\n提交 ${headRef.commit}`}
              aria-label={`定位当前 HEAD ${headRef.shortName} 到提交 ${refCommitShort(headRef)}`}
              data-ref-kind="head"
              data-ref-name={headRef.fullName}
              onClick={() => onSelect?.(headRef)}
            >
              <span className="ref-kind">HEAD</span>
              <code className="ref-name">{headRef.shortName}</code>
              <span className="ref-commit">{refCommitShort(headRef)}</span>
            </button>
          ) : (
            <p className="ref-unborn" role="status">{headRef.shortName} · {headRef.status}</p>
          )}
        </div>
      )}
      {reason && <p className="reference-error" role="alert">{reason}</p>}
      {truncated && (
        <p className="reference-truncated" role="status">
          仅显示部分引用
        </p>
      )}
      {notice && <p className="ref-feedback" role="status" aria-live="polite">{notice}</p>}
      {!refs.length && !reason && !loading && (
        <p className="reference-empty">当前仓库没有可显示的分支或标签。</p>
      )}
      {groups.map((group) => (
        <div className="reference-group" key={group.kind}>
          <div className="reference-group-title">{group.label}</div>
          {group.refs.map((ref) => (
            <RefRow
              key={ref.fullName}
              ref={ref}
              activeHash={activeHash}
              onSelect={onSelect}
            />
          ))}
        </div>
      ))}
    </section>
  );
}
