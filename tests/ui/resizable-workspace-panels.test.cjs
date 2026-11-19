const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "main.jsx"), "utf8");
// 0.6.5 拆完 main.jsx 之后：分隔条的标记在 workbench-ui.jsx，拖拽/持久化实现在
// use-panel-resize.js。断言跟着代码走，仍然盯同一批行为。
const panels = fs.readFileSync(path.join(__dirname, "..", "..", "src", "workbench-ui.jsx"), "utf8");
const panelHook = fs.readFileSync(path.join(__dirname, "..", "..", "src", "use-panel-resize.js"), "utf8");
const model = fs.readFileSync(path.join(__dirname, "..", "..", "src", "panel-resize.js"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "..", "..", "src", "styles.css"), "utf8");
const { declarations } = require(path.join(__dirname, "..", "support", "css-inspect.cjs"));

function runProbe(name) {
  const root = path.join(__dirname, "..", "..");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "gitglass-splitter-probe-"));
  try {
    return execFileSync(require("electron"), [path.join(__dirname, "..", "support", name)], {
      cwd: root, encoding: "utf8", timeout: 90_000, windowsHide: true,
      env: { ...process.env, GITGLASS_PANEL_SPLITTER_DIRECTORY: temporary },
    });
  } finally {
    // The child has exited, so Chromium no longer holds the profile files open.
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

describe("Resizable workbench panels", () => {
  it("renders 1px splitter lines with a 9px content-side hit area and drags, resets, persists and clamps for real", () => {
    const root = path.join(__dirname, "..", "..");
    // Always render current source, rather than a stale ignored local dist/.
    execFileSync(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "build"], { cwd: root, env: { ...process.env, NODE_ENV: "production" }, windowsHide: true, timeout: 90_000 });
    const output = runProbe("panel-splitter-ui.cjs");
    expect(output).toContain("[PANEL-SPLITTER] ");
  }, 120_000);

  it("exposes pointer, double-click and keyboard accessible separators for both side panels", () => {
    expect(panels).toContain('role="separator"');
    expect(panels).toContain('aria-orientation="vertical"');
    expect(panels).toContain("aria-valuemin={limits.min}");
    expect(panels).toContain("aria-valuemax={limits.max}");
    expect(panels).toContain("aria-valuenow={value}");
    expect(panels).toContain('onPointerDown={(event) => onPointerDown(side, event)}');
    expect(panels).toContain("onDoubleClick={() => onDoubleClick(side)}");
    expect(panels).toContain('onKeyDown={(event) => onKeyDown(side, event)}');
    // 两个工作区（历史 / 工作区）各渲染一对分隔条。
    expect(source).toContain('side="left"');
    expect(source).toContain('side="right"');
    // 拖拽使用 pointer capture、rAF 节流和全屏 overlay，失焦也能收尾。
    expect(panelHook).toContain("setPointerCapture?.(pointerId)");
    expect(panelHook).toContain("requestAnimationFrame(apply)");
    expect(panelHook).toContain("panel-resize-overlay");
    expect(panelHook).toContain('window.addEventListener("blur", finish, { once: true })');
  });

  it("keeps the dimensions bounded, remembers them and clamps them when the window narrows", () => {
    expect(model).toContain('export const PANEL_WIDTH_STORAGE_KEY = "gitglass.panel-widths"');
    expect(model).toContain("export const PANEL_MAIN_MINIMUM = 440");
    expect(model).toContain("min: 190, max: 420, default: 224");
    expect(model).toContain("min: 240, max: 420, default: 296");
    expect(model).toContain("export const PANEL_KEYBOARD_STEP = 8");
    expect(panelHook).toContain("localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, serializePanelWidths(panelWidths))");
    expect(panelHook).toContain('window.addEventListener("resize", scheduleConstrain)');
    expect(panelHook).toContain("constrainPanelWidths(current, workspaceWidth)");
    // 挂载后先夹紧一次，并用 ResizeObserver 覆盖工作区自身的尺寸变化。
    expect(panelHook).toContain("new ResizeObserver(scheduleConstrain)");
    expect(panelHook).toContain("constrainPanels()");
    expect(panelHook).toContain("requestAnimationFrame(constrainPanels)");
  });

  it("draws a 1px hairline with a neutral 2px highlight and no gray bar or glow", () => {
    expect(styles).toContain("grid-template-columns:minmax(190px,var(--left-panel-width,224px)) 1px minmax(0,1fr) 1px minmax(240px,var(--right-panel-width,296px))");
    expect(styles).toContain(".panel-splitter{position:relative;z-index:3;min-height:0;background:var(--line);cursor:col-resize;touch-action:none;outline:none}");
    // 命中区只向主内容一侧扩展 8px（共 9px），不覆盖侧栏自己的滚动条。
    expect(styles).toContain('.panel-splitter::before{position:absolute;content:"";cursor:col-resize}');
    expect(styles).toContain(".panel-splitter-left::before{inset:0 -8px 0 0}");
    expect(styles).toContain(".panel-splitter-right::before{inset:0 0 0 -8px}");
    expect(styles).toContain('.panel-splitter::after{position:absolute;top:0;bottom:0;left:50%;width:2px;margin-left:-1px;background:transparent;opacity:0;content:"";pointer-events:none;transition:background-color .12s,opacity .12s}');
    // 高亮用 dbx 中性 token：hover / 键盘聚焦为 var(--ring)，拖拽中为实色 var(--text)。
    expect(styles).toContain(".panel-splitter:hover::after,.panel-splitter:focus-visible::after{background:var(--ring);opacity:1}");
    expect(styles).toContain(".is-resizing-panels .panel-splitter::after{background:var(--text);opacity:1}");
    expect(styles).not.toContain(".panel-splitter:hover::after,.panel-splitter:focus-visible::after{background:var(--blue)");
    // 旧实现里的灰条与蓝色发光必须消失。
    expect(styles).not.toContain("rgba(47,111,237,.1)");
    expect(styles).not.toContain("box-shadow:inset 1px 0 #9cbcf8");
    expect(styles).toContain(".panel-resize-overlay{position:fixed;inset:0;z-index:2147483647;cursor:col-resize;user-select:none;touch-action:none}");
  });

  it("uses flexible columns and truncates long paths instead of creating horizontal overflow", () => {
    expect(styles).toContain(".status-panel{overflow-x:hidden}");
    expect(styles).toContain(".remote-summary>span{display:block;overflow:visible;white-space:normal;overflow-wrap:anywhere}");
    expect(styles).toContain(".inspector-heading h2{min-width:0;overflow:visible;overflow-wrap:anywhere;text-overflow:clip;white-space:normal}");
  });

  it("prioritizes legible file and branch names in the workspace sidebar", () => {
    // 按选择器读取生效声明，而不是锁定某一条规则的写法：
    // 13px 主字号 + 26px 列表行 + 10px 分组留白（dbx 密度）。
    const rows = declarations(styles, ".status-panel .file-select,.status-panel .branch-row");
    expect(rows).toMatchObject({ "font-size": "13px", height: "26px", padding: "0 6px" });
    expect(declarations(styles, ".status-panel .section-label")).toMatchObject({
      "font-size": "12px",
      color: "var(--text)",
    });
    expect(declarations(styles, ".status-panel .branch-list,.status-panel .remote-summary")).toMatchObject({
      "margin-top": "10px",
      "padding-top": "10px",
    });
  });
});
