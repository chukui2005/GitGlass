// 克隆仓库对话框：只呈现 props，不发 IPC。用原生 <dialog>（与更新对话框同一套
// 模态语义：焦点留在对话框内、Esc 由 onCancel 收起、点遮罩关闭），所以工作区的
// 快捷键不会在打开期间穿透到后台。
import { useEffect, useRef } from "react";
import { CloudArrowDown, FolderOpen, X } from "@phosphor-icons/react";

/**
 * @param {object} props
 * @param {{ source: string, parent: string, name: string }} props.draft
 * @param {{ ok: boolean, blocked: boolean, reason?: string, plan?: any, target?: string | null, existingEmpty?: boolean } | null} props.planned
 * @param {string} props.error
 * @param {boolean} props.running 克隆正在执行（不可关闭）
 * @param {boolean} props.loading 其他操作占用中
 * @param {(field: 'source' | 'parent' | 'name', value: string) => void} props.onField
 * @param {() => void} props.onChooseTarget
 * @param {() => void} props.onPrepare
 * @param {() => void} props.onConfirm
 * @param {() => void} props.onClose
 */
export function CloneRepositoryDialog({
  draft,
  planned,
  error,
  running,
  loading,
  onField,
  onChooseTarget,
  onPrepare,
  onConfirm,
  onClose,
}) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal?.();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);
  const busy = Boolean(running || loading);
  const close = () => {
    if (!running) onClose();
  };
  const ready = planned?.ok === true && Boolean(planned.plan);
  const canPrepare = Boolean(draft.source.trim() && draft.parent.trim()) && !busy;
  return (
    <dialog
      ref={ref}
      className="clone-dialog"
      aria-labelledby="clone-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === ref.current) close();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="clone-heading">
        <div>
          <span>仓库</span>
          <h2 id="clone-title">克隆仓库</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭克隆仓库"
          title="关闭（Esc）"
          disabled={running}
          onClick={close}
        >
          <X size={17} />
        </button>
      </div>
      <div className="clone-body">
        <div className="clone-field">
          <label htmlFor="clone-source">仓库地址</label>
          <input
            id="clone-source"
            name="clone-source"
            value={draft.source}
            onChange={(event) => onField("source", event.target.value)}
            placeholder="https://host/owner/repo.git 或 git@host:owner/repo.git"
            autoComplete="off"
            spellCheck={false}
            disabled={running}
            autoFocus
          />
        </div>
        <p className="clone-hint">
          支持 HTTPS 与 SSH 地址，也接受本地仓库路径。含内嵌用户名或令牌的地址会被直接拒绝；认证请使用本机 Git 凭据。
        </p>
        <div className="clone-field">
          <label htmlFor="clone-parent">目标位置</label>
          <span className="clone-target-row">
            <input
              id="clone-parent"
              name="clone-parent"
              value={draft.parent}
              onChange={(event) => onField("parent", event.target.value)}
              placeholder="选择一个本地文件夹"
              autoComplete="off"
              spellCheck={false}
              disabled={running}
            />
            <button type="button" className="secondary-action" onClick={onChooseTarget} disabled={busy}>
              <FolderOpen size={14} aria-hidden="true" />
              选择目录…
            </button>
          </span>
        </div>
        <div className="clone-field">
          <label htmlFor="clone-name">仓库文件夹名（可选）</label>
          <input
            id="clone-name"
            name="clone-name"
            value={draft.name}
            onChange={(event) => onField("name", event.target.value)}
            placeholder="留空则使用远程仓库名"
            autoComplete="off"
            spellCheck={false}
            disabled={running}
          />
        </div>
        {ready ? (
          <div className="clone-plan">
            <p className="clone-target-path">
              最终目录
              <code title={planned.target || ""}>{planned.target}</code>
            </p>
            {planned.existingEmpty && (
              <p className="clone-hint">该目录已存在但为空，Git 会直接在其中创建工作区。</p>
            )}
            <div className="planned-command">
              <span>计划执行（尚未运行）</span>
              <code>{planned.plan.displayCommand}</code>
            </div>
            <p className="clone-hint">
              工作目录：<code>{planned.plan.cwd}</code>
            </p>
          </div>
        ) : (
          <p className="clone-hint">先「预览克隆」核对最终目录与真实命令，再开始执行。</p>
        )}
        {error && (
          <p className="clone-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="clone-footer">
        <button type="button" className="secondary-action" onClick={close} disabled={running}>
          取消
        </button>
        {ready ? (
          <button type="button" className="primary-action" onClick={onConfirm} disabled={busy}>
            <CloudArrowDown size={15} aria-hidden="true" />
            {running ? "正在克隆…" : "开始克隆"}
          </button>
        ) : (
          <button type="button" className="primary-action" onClick={onPrepare} disabled={!canPrepare}>
            预览克隆
          </button>
        )}
      </div>
    </dialog>
  );
}
