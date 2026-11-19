import { useEffect, useRef, useState } from "react";
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

// 左右两栏的宽度：持久化、窗口变窄时夹紧、拖拽与键盘调整。
// 纯计算在 panel-resize.js，这里只接 React（state / ref / 监听）。

/** 从 localStorage 读回上次的宽度；读不到或损坏时用默认值。 */
function readPanelWidths() {
  try {
    return parsePanelWidths(localStorage.getItem(PANEL_WIDTH_STORAGE_KEY));
  } catch {
    return defaultPanelWidths();
  }
}

/**
 * `usePanelResize` 的返回值。
 * @typedef {object} PanelResize
 * @property {{ left: number, right: number }} panelWidths
 * @property {import('react').RefObject<HTMLDivElement | null>} workspaceRef 工作区容器（量可用宽度用）
 * @property {(side: "left" | "right") => { min: number, max: number }} getPanelLimits
 * @property {(side: "left" | "right", event: import('react').PointerEvent) => void} startPanelResize
 * @property {(side: "left" | "right") => void} resetPanelWidth
 * @property {(side: "left" | "right", event: import('react').KeyboardEvent) => void} resizePanelWithKeyboard
 */

/**
 * 工作区两侧面板的宽度状态与交互。
 * @returns {PanelResize}
 */
export function usePanelResize() {
  const [panelWidths, setPanelWidths] = useState(readPanelWidths);
  const workspaceRef = useRef(null);
  const panelResize = useRef(null);
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

  return {
    panelWidths,
    workspaceRef,
    getPanelLimits,
    startPanelResize,
    resetPanelWidth,
    resizePanelWithKeyboard,
  };
}
