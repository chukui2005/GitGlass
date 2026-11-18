const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "main.jsx"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "..", "..", "src", "styles.css"), "utf8");
const { declarations } = require(path.join(__dirname, "..", "support", "css-inspect.cjs"));

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
