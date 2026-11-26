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
  // 预览读取的序号：迟到的 prepare 响应（用户已改字段、关掉对话框或换了仓库）必须丢弃，
  // 否则界面会冒出一份对不上输入框的计划，甚至被「开始克隆」确认执行。
  const prepareSequence = useRef(0);
  const pendingPrepares = useRef(new Set());
  const openRef = useRef(false);
  const draftRef = useRef(EMPTY_DRAFT);

  const writeDraft = useCallback((next) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  const start = useCallback(() => {
    if (loading || runningRef.current) return;
    // 新一次打开是新会话：在飞的旧预览从此失效。
    prepareSequence.current += 1;
    openRef.current = true;
    writeDraft(EMPTY_DRAFT);
    setPlanned(null);
    setError("");
    setOpen(true);
  }, [loading, writeDraft]);

  const close = useCallback(() => {
    if (runningRef.current) return;
    prepareSequence.current += 1;
    openRef.current = false;
    setOpen(false);
    setPlanned(null);
    setError("");
    // 地址可能包含内网主机名：关闭即清空，下次打开是干净的输入。
    writeDraft(EMPTY_DRAFT);
    // 只有当次预览还挂着 loading；对话框关掉后它不再有机会自己清掉。
    pendingPrepares.current.clear();
    setLoading(false);
  }, [setLoading, writeDraft]);

  const updateField = useCallback((field, value) => {
    if (draftRef.current[/** @type {keyof CloneDraft} */ (field)] === value) return;
    const next = { ...draftRef.current, [field]: value };
    // 输入一变，任何在飞或已完成的预览都不再对应当前输入。
    prepareSequence.current += 1;
    writeDraft(next);
    setPlanned(null);
    setError("");
  }, [writeDraft]);

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
    if (runningRef.current) return;
    if (!draftRef.current.source.trim() || !draftRef.current.parent.trim()) {
      setError("请填写仓库地址并选择目标位置。");
      return;
    }
    const sequence = ++prepareSequence.current;
    const input = { ...draftRef.current };
    // 每个在飞的预览用自己的标识占位：迟到的响应只能清掉自己那一次，不会把后来
    // 那次的 loading 提前关掉。
    const token = Symbol('clone-prepare');
    pendingPrepares.current.add(token);
    setLoading(true);
    try {
      const result = await gitglass.prepareClone(input);
      // 迟到的响应：期间改过任一字段、关过对话框，或已经开了新会话。
      if (sequence !== prepareSequence.current || !openRef.current) return;
      if (!result?.ok) {
        setPlanned(null);
        setError(result?.reason || GENERIC_CLONE_FAILURE);
        return;
      }
      setError("");
      setPlanned({ ...result, input });
    } catch {
      if (sequence !== prepareSequence.current || !openRef.current) return;
      setPlanned(null);
      setError(GENERIC_CLONE_FAILURE);
    } finally {
      pendingPrepares.current.delete(token);
      if (pendingPrepares.current.size === 0) setLoading(false);
    }
  }, [gitglass, setLoading]);

  const confirm = useCallback(async () => {
    if (!planned?.ok || !planned.input || !planned.plan || runningRef.current) return;
    const input = planned.input;
    // 双保险：即使某条路径漏了失效处理，计划与当前输入不一致时也不执行。
    const current = draftRef.current;
    if (current.source !== input.source || current.parent !== input.parent || current.name !== input.name) {
      setPlanned(null);
      setError("地址或目标位置已修改，请重新预览克隆。");
      return;
    }
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
      openRef.current = false;
      setOpen(false);
      setPlanned(null);
      writeDraft(EMPTY_DRAFT);
    } catch {
      setError(GENERIC_CLONE_FAILURE);
    } finally {
      runningRef.current = false;
      setRunning(false);
      setLoading(false);
    }
  }, [gitglass, onOpened, planned, setLoading, setNotice, writeDraft]);

  return { open, draft, planned, error, running, start, close, updateField, chooseTarget, prepare, confirm };
}
