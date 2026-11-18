// Pure panel-width model for the workspace splitters. Keeping the arithmetic
// here lets the interaction code stay thin and the bounds stay testable without
// Electron.

export const PANEL_WIDTH_STORAGE_KEY = "gitglass.panel-widths";
export const PANEL_KEYBOARD_STEP = 8;
// The two 1px splitter lines also consume horizontal space in the workspace grid.
export const PANEL_SPLITTER_WIDTH = 1;
export const PANEL_MAIN_MINIMUM = 440;
export const PANEL_BOUNDS = {
  left: { min: 190, max: 420, default: 224 },
  right: { min: 240, max: 420, default: 296 },
};

const SIDES = ["left", "right"];
const otherSide = (side) => (side === "left" ? "right" : "left");

export function defaultPanelWidths() {
  return { left: PANEL_BOUNDS.left.default, right: PANEL_BOUNDS.right.default };
}

function staticLimits(side) {
  return { min: PANEL_BOUNDS[side].min, max: PANEL_BOUNDS[side].max };
}

export function clampPanelWidth(side, requested, limits = staticLimits(side)) {
  if (!Number.isFinite(requested)) return PANEL_BOUNDS[side].default;
  return Math.round(Math.max(limits.min, Math.min(limits.max, requested)));
}

/**
 * The maximum width of one side panel shrinks as the window narrows: the other
 * panel, the 440px main column and both 1px splitter lines must always fit.
 */
export function panelLimits(side, widths, workspaceWidth) {
  const layoutMaximum = workspaceWidth - widths[otherSide(side)] - PANEL_MAIN_MINIMUM - PANEL_SPLITTER_WIDTH * 2;
  return {
    min: PANEL_BOUNDS[side].min,
    max: Math.max(PANEL_BOUNDS[side].min, Math.min(PANEL_BOUNDS[side].max, Math.round(layoutMaximum))),
  };
}

export function constrainPanelWidths(widths, workspaceWidth) {
  const source = widths && typeof widths === "object" ? widths : {};
  const leftWidth = Number.isFinite(source.left) ? source.left : PANEL_BOUNDS.left.default;
  const rightWidth = Number.isFinite(source.right) ? source.right : PANEL_BOUNDS.right.default;
  const left = clampPanelWidth("left", leftWidth, panelLimits("left", { left: leftWidth, right: rightWidth }, workspaceWidth));
  const right = clampPanelWidth("right", rightWidth, panelLimits("right", { left, right: rightWidth }, workspaceWidth));
  return { left, right };
}

/**
 * Parses the persisted JSON. Missing, damaged or out-of-range values fall back
 * to the defaults instead of throwing, because a broken preference must never
 * stop the workspace from rendering.
 */
export function parsePanelWidths(raw) {
  const widths = defaultPanelWidths();
  let saved;
  try {
    saved = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return widths;
  }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return widths;
  for (const side of SIDES) {
    if (Number.isFinite(saved[side])) widths[side] = clampPanelWidth(side, saved[side]);
  }
  return widths;
}

export function serializePanelWidths(widths) {
  const safe = widths && typeof widths === "object" ? widths : {};
  return JSON.stringify({
    left: clampPanelWidth("left", safe.left),
    right: clampPanelWidth("right", safe.right),
  });
}

/**
 * Returns the width for a keyboard gesture, or null when the key is unrelated.
 * Arrow keys move the splitter itself: right grows the left panel and shrinks
 * the right one.
 */
export function keyboardPanelWidth(side, current, key, limits = staticLimits(side)) {
  if (key === "Home") return limits.min;
  if (key === "End") return limits.max;
  if (key === "Enter") return clampPanelWidth(side, PANEL_BOUNDS[side].default, limits);
  if (key === "ArrowLeft" || key === "ArrowRight") {
    const direction = key === "ArrowRight" ? 1 : -1;
    const delta = side === "left" ? direction : -direction;
    return clampPanelWidth(side, current + delta * PANEL_KEYBOARD_STEP, limits);
  }
  return null;
}
