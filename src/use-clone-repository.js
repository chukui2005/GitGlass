import { useCallback, useRef, useState } from "react";

/**
 * 克隆流程的领域状态（`src/main.jsx` 只负责把它的结果接到工作区）。
 *
 * 两次 IPC 之间只保留「用户核对过的那一份输入」：地址、目标位置或文件夹名一改，
 * `planned` 立即作废，必须重新预览。这样「确认」永远执行界面上展示过的那条命令，
 * 而不是输入框里刚敲进去、还没核对的内容。
 *
 * @typedef {object} CloneDraft
 * @property {string} source 仓库地址（HTTPS / SSH / 本地路径）。
 * @property {string} parent 目标位置（父目录，来自系统目录选择器）。
 * @property {string} name 仓库文件夹名；留空表示由主进程按地址推导。
 *
 * @typedef {object} ClonePlan
 * @property {boolean} ok
 * @property {boolean} blocked
 * @property {string} [reason]
 * @property {any} [plan] 主进程生成的计划（非账本记录）
 * @property {string | null} [target] 最终目录
 * @property {boolean} [existingEmpty]
 *
 * @typedef {object} CloneHookOptions
 * @property {any} gitglass preload 暴露的桥；测试里换成假桥。
 * @property {boolean} loading 工作区是否正在执行其他操作。
 * @property {(value: boolean) => void} setLoading
 * @property {(notice: { type: string, text: string } | null) => void} setNotice
 * @property {(result: any) => Promise<{ ok: boolean, message?: string }>} onOpened
 *   克隆成功后复用「打开仓库」的统一收尾；返回的 ok 决定成功提示。
 */

const EMPTY_DRAFT = Object.freeze({ source: "", parent: "", name: "" });
const GENERIC_CLONE_FAILURE = "克隆没有完成，请查看命令账本中的真实命令与错误输出。";

/** @param {CloneHookOptions} options */
export function useCloneRepository({ gitglass, loading, setLoading, setNotice, onOpened }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  /** @type {[ClonePlan & { input?: CloneDraft } | null, Function]} */
  const [planned, setPlanned] = useState(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  // 执行期间关闭对话框会让用户失去唯一的进度提示，所以按钮和 Esc 在运行中一律无效。
  const runningRef = useRef(false);

  const start = useCallback(() => {
    if (loading || runningRef.current) return;
    setDraft(EMPTY_DRAFT);
    setPlanned(null);
    setError("");
    setOpen(true);
  }, [loading]);

  const close = useCallback(() => {
    if (runningRef.current) return;
    setOpen(false);
    setPlanned(null);
    setError("");
    // 地址可能包含内网主机名：关闭即清空，下次打开是干净的输入。
    setDraft(EMPTY_DRAFT);
  }, []);

  const updateField = useCallback((field, value) => {
    setDraft((previous) => {
      if (previous[/** @type {keyof CloneDraft} */ (field)] === value) return previous;
      return { ...previous, [field]: value };
    });
    setPlanned(null);
    setError("");
  }, []);

  const chooseTarget = useCallback(async () => {
    if (loading || runningRef.current) return;
    try {
      const choice = await gitglass.chooseCloneTarget();
      if (choice?.canceled || !choice?.path) return;
      updateField("parent", choice.path);
    } catch {
      setError("无法打开目录选择器，请稍后重试。");
    }
  }, [gitglass, loading, updateField]);

  const prepare = useCallback(async () => {
    if (loading || runningRef.current) return;
    if (!draft.source.trim() || !draft.parent.trim()) {
      setError("请填写仓库地址并选择目标位置。");
      return;
    }
    const input = { ...draft };
    setLoading(true);
    try {
      const result = await gitglass.prepareClone(input);
      if (!result?.ok) {
        setPlanned(null);
        setError(result?.reason || GENERIC_CLONE_FAILURE);
        return;
      }
      setError("");
      setPlanned({ ...result, input });
    } catch {
      setPlanned(null);
      setError(GENERIC_CLONE_FAILURE);
    } finally {
      setLoading(false);
    }
  }, [draft, gitglass, loading, setLoading]);

  const confirm = useCallback(async () => {
    if (!planned?.ok || !planned.input || !planned.plan || runningRef.current) return;
    const input = planned.input;
    runningRef.current = true;
    setRunning(true);
    setLoading(true);
    try {
      const result = await gitglass.executeClone({ ...input, operationId: planned.plan.operationId });
      if (!result?.ok) {
        setError(result?.reason || result?.message || GENERIC_CLONE_FAILURE);
        return;
      }
      const opened = await onOpened(result);
      if (!opened?.ok) {
        setError(opened?.message || "已克隆完成，但无法打开该仓库。");
        return;
      }
      setNotice({ type: "success", text: `已克隆并打开仓库：${result.path || planned.target}` });
      setOpen(false);
      setPlanned(null);
      setDraft(EMPTY_DRAFT);
    } catch {
      setError(GENERIC_CLONE_FAILURE);
    } finally {
      runningRef.current = false;
      setRunning(false);
      setLoading(false);
    }
  }, [gitglass, onOpened, planned, setLoading, setNotice]);

  return { open, draft, planned, error, running, start, close, updateField, chooseTarget, prepare, confirm };
}
