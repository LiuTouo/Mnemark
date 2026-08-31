export type WorkspaceMode = "center" | "wide" | "compact" | "overlay";
export type WorkspaceTab = "drawer" | "preview";

export interface WorkspaceLayout {
  mode: WorkspaceMode;
  leftExtent: number;
  rightExtent: number;
  drawerVisible: boolean;
  previewVisible: boolean;
  activeTab: WorkspaceTab | null;
}

export const WORKSPACE_CENTER_WIDTH = 480;
export const WORKSPACE_PANE_WIDTH = 360;
export const WORKSPACE_GAP = 8;
export const WORKSPACE_GUTTERS = 60;

const ONE_PANE_WIDTH = WORKSPACE_CENTER_WIDTH + WORKSPACE_PANE_WIDTH + WORKSPACE_GAP;
const TWO_PANE_WIDTH = WORKSPACE_CENTER_WIDTH + (WORKSPACE_PANE_WIDTH + WORKSPACE_GAP) * 2;

export function decideWorkspaceLayout(
  availableCssWidth: number,
  drawerOpen: boolean,
  previewOpen: boolean,
  preferredTab: WorkspaceTab,
): WorkspaceLayout {
  if (!drawerOpen && !previewOpen) {
    return {
      mode: "center",
      leftExtent: 0,
      rightExtent: 0,
      drawerVisible: false,
      previewVisible: false,
      activeTab: null,
    };
  }

  if (drawerOpen && previewOpen && availableCssWidth >= TWO_PANE_WIDTH) {
    return {
      mode: "wide",
      leftExtent: WORKSPACE_PANE_WIDTH + WORKSPACE_GAP,
      rightExtent: WORKSPACE_PANE_WIDTH + WORKSPACE_GAP,
      drawerVisible: true,
      previewVisible: true,
      activeTab: null,
    };
  }

  if (drawerOpen !== previewOpen && availableCssWidth >= ONE_PANE_WIDTH) {
    return {
      mode: "wide",
      leftExtent: drawerOpen ? WORKSPACE_PANE_WIDTH + WORKSPACE_GAP : 0,
      rightExtent: previewOpen ? WORKSPACE_PANE_WIDTH + WORKSPACE_GAP : 0,
      drawerVisible: drawerOpen,
      previewVisible: previewOpen,
      activeTab: null,
    };
  }

  const activeTab: WorkspaceTab = drawerOpen && preferredTab === "drawer"
    ? "drawer"
    : previewOpen
      ? "preview"
      : "drawer";
  const drawerVisible = activeTab === "drawer" && drawerOpen;
  const previewVisible = activeTab === "preview" && previewOpen;

  if (availableCssWidth >= ONE_PANE_WIDTH) {
    return {
      mode: "compact",
      leftExtent: 0,
      rightExtent: WORKSPACE_PANE_WIDTH + WORKSPACE_GAP,
      drawerVisible,
      previewVisible,
      activeTab,
    };
  }

  return {
    mode: "overlay",
    leftExtent: 0,
    rightExtent: 0,
    drawerVisible,
    previewVisible,
    activeTab,
  };
}

/** Automatic preview must not steal the compact drawer tab. */
export function tabAfterPreviewIntent(current: WorkspaceTab, drawerOpen: boolean): WorkspaceTab {
  return drawerOpen ? current : "preview";
}

export type EscapeLayer = "modal-or-menu" | "preview" | "drawer" | "panel";

export function escapeLayer(
  transientOpen: boolean,
  previewOpen: boolean,
  drawerOpen: boolean,
): EscapeLayer {
  if (transientOpen) return "modal-or-menu";
  if (previewOpen) return "preview";
  if (drawerOpen) return "drawer";
  return "panel";
}
