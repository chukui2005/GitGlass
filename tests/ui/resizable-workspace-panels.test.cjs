const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "main.jsx"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "..", "..", "src", "styles.css"), "utf8");

describe("Resizable workbench panels", () => {
  it("provides pointer and keyboard accessible separators for both side panels", () => {
    expect(source).toContain('role="separator"');
    expect(source).toContain('aria-orientation="vertical"');
    expect(source).toContain('onPointerDown={(event) => onPointerDown(side, event)}');
    expect(source).toContain('onKeyDown={(event) => onKeyDown(side, event)}');
    expect(source).toContain('side="left"');
    expect(source).toContain('side="right"');
  });

  it("keeps the dimensions bounded and remembers them between sessions", () => {
    expect(source).toContain('panelWidthStorageKey');
    expect(source).toContain('localStorage.setItem(panelWidthStorageKey');
    expect(source).toContain('window.addEventListener("resize", constrainPanels)');
    expect(source).toContain('workspaceMainMinimum = 360');
  });

  it("uses flexible columns and truncates long paths instead of creating horizontal overflow", () => {
    expect(styles).toContain('grid-template-columns:minmax(190px,var(--left-panel-width,224px)) 8px minmax(0,1fr) 8px minmax(240px,var(--right-panel-width,296px))');
    expect(styles).toContain('.status-panel{overflow-x:hidden}');
    expect(styles).toContain('.remote-summary>span{display:block;overflow:visible;white-space:normal;overflow-wrap:anywhere}');
    expect(styles).toContain('.inspector-heading h2{min-width:0;overflow:visible;overflow-wrap:anywhere;text-overflow:clip;white-space:normal}');
  });

  it("prioritizes legible file and branch names in the workspace sidebar", () => {
    expect(styles).toContain('.status-panel .file-select,.status-panel .branch-row{font-size:13px}');
    expect(styles).toContain('.status-panel .section-label{font-size:12px}');
    expect(styles).toContain('.status-panel .file-select{padding:8px 6px}');
    expect(styles).toContain('.status-panel .branch-list,.status-panel .remote-summary{margin-top:20px;padding-top:16px}');
  });
});
