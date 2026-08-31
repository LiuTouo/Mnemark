import { describe, expect, it } from "vitest";
import { decideWorkspaceLayout, escapeLayer, tabAfterPreviewIntent } from "./workspace-state";

describe("workspace layout", () => {
  it("shows three columns when both side panes fit", () => {
    expect(decideWorkspaceLayout(1400, true, true, "drawer")).toMatchObject({
      mode: "wide",
      leftExtent: 368,
      rightExtent: 368,
      drawerVisible: true,
      previewVisible: true,
    });
  });

  it("uses a tabbed side pane when two panes do not fit", () => {
    expect(decideWorkspaceLayout(900, true, true, "drawer")).toMatchObject({
      mode: "compact",
      leftExtent: 0,
      rightExtent: 368,
      drawerVisible: true,
      previewVisible: false,
      activeTab: "drawer",
    });
  });

  it("uses an overlay on a narrow work area", () => {
    expect(decideWorkspaceLayout(700, true, false, "drawer")).toMatchObject({
      mode: "overlay",
      leftExtent: 0,
      rightExtent: 0,
      drawerVisible: true,
    });
  });

  it("keeps a single drawer on the left and preview on the right", () => {
    expect(decideWorkspaceLayout(900, true, false, "drawer").leftExtent).toBe(368);
    expect(decideWorkspaceLayout(900, false, true, "preview").rightExtent).toBe(368);
  });
});

describe("workspace interaction", () => {
  it("automatic preview does not steal an open drawer tab", () => {
    expect(tabAfterPreviewIntent("drawer", true)).toBe("drawer");
    expect(tabAfterPreviewIntent("drawer", false)).toBe("preview");
  });

  it("closes escape layers from inner to outer", () => {
    expect(escapeLayer(true, true, true)).toBe("modal-or-menu");
    expect(escapeLayer(false, true, true)).toBe("preview");
    expect(escapeLayer(false, false, true)).toBe("drawer");
    expect(escapeLayer(false, false, false)).toBe("panel");
  });
});
