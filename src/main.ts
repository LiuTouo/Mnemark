import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import {
  applyI18n,
  t,
  localizeBackendError,
  localizeDrawerError,
  localizeLocatedClipError,
} from "./i18n";
import { configBootstrap } from "./config";
import { decidePreviewSync, PreviewController } from "./preview-state";
import { ShortcutMatcher, FAVORITES_DEFAULT_CODES } from "./shortcut";
import { ChooserGate, computeMenuPlacement } from "./menu";
import { isFavoriteItem, clipLocator } from "./drag";
import { classifyClip, filterItems } from "./dataset";
import type { FilterKind } from "./dataset";
import { MultiSelectState } from "./multi-select";
import { decideWorkspaceLayout, escapeLayer, tabAfterPreviewIntent } from "./workspace-state";
import type { WorkspaceTab } from "./workspace-state";
import { mountDrawerRenderer } from "./favorites";
import type { PanelDrawerRenderer } from "./favorites";
import { drawerViewProjection } from "./drawer-view-tauri";
import { DrawerViewCoordinator } from "./drawer-view-coordinator";
import { DrawerMutationWorkflow } from "./drawer-mutations";
import type { DrawerView } from "./drawer-view";
import type { DrawerDragCancelReason, DrawerDragSession } from "./drawer-drag";
import { mountPreview } from "./preview";
import { moveOne } from "./reorder";
import { LocatedClipFacade } from "./located-clip";
import { HistoryModule } from "./history-module";
import type { Clip, ClipboardUpdate, ClipLocator, FavoriteItem } from "./types";

type DisplayItem = Clip | FavoriteItem;

let panelDrawer: PanelDrawerRenderer;
let workspaceTab: WorkspaceTab = "drawer";
let workspaceLayoutRevision = 0;
// The search-filtered view of the active dataset, in display order. Keyboard
// selection indexes into this — never into the raw arrays directly.
let visibleClips: DisplayItem[] = [];
let selectedIndex = -1;
let vimMode = false;
let previewEnabled = true;
let rememberHistoryFilter = false;
let activeFilter: FilterKind = "all";
let openMenuClipId: string | null = null;
let noteTarget: ClipLocator | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
const previewState = new PreviewController();
let shortcutMatcher = new ShortcutMatcher(FAVORITES_DEFAULT_CODES);
const chooserGate = new ChooserGate();
let lastMenuPos = { anchorTop: 0, anchorBottom: 0, right: 0 };
const multiSelect = new MultiSelectState();
let batchChooserOpen = false;
const history = new HistoryModule({
  read: () => invoke<Clip[]>("get_clips"),
  remove: async (id) => { await invoke("delete_clip", { id }); },
  restore: async (id) => { await invoke("undo_delete", { id }); },
  removeBatch: async (ids) => { await invoke("delete_clips", { ids: [...ids] }); },
  restoreBatch: async (ids) => { await invoke("undo_delete_batch", { ids: [...ids] }); },
  setPinned: async (id, pinned) => { await invoke("set_pinned", { id, pinned }); },
});
const drawerViewCoordinator = new DrawerViewCoordinator(drawerViewProjection, {
  presentError: (error) => showToast(localizeDrawerError(String(error))),
  presentStale: () => showToast(t("drawerRefreshFailed")),
  reportDiagnostic: (context, error) => console.error(`[Mnemark] ${context}`, error),
});
// Both the row-menu and drag paths hand their Drawer mutation intents to this
// one workflow; each owns only the presentation of the returned outcome.
const drawerMutations = new DrawerMutationWorkflow({
  invoke: (command, args) => invoke(command, args),
  refreshAfterMutation: (context) => drawerViewCoordinator.refreshAfterMutation(context),
  retryAfterFailure: (context) => drawerViewCoordinator.retryAfterFailure(context),
});
const locatedClip = new LocatedClipFacade({
  invoke: (command, args) => invoke(command, args),
  publishHistoryNote: (id, note) => {
    history.publishNote(id, note);
  },
  refreshDrawer: () => drawerViewCoordinator.refreshAfterMutation("Drawer note refresh failed"),
  presentCopyOutcome: (outcome) => {
    showToast(t(outcome === "missing-files-text-fallback" ? "filesMissingFallback" : "copied"));
  },
  isPreviewActive: (locator) => previewState.currentId === locator.id,
  reportDiagnostic: (context, error) => console.error(`[Mnemark] ${context}:`, error),
});

const searchInput = document.getElementById("search-input") as HTMLInputElement;
const filterBar = document.getElementById("filter-bar")!;
const clipList = document.getElementById("clip-list")!;
const emptyState = document.getElementById("empty-state")!;
const emptyTitle = document.getElementById("empty-title")!;
const emptyHint = document.getElementById("empty-hint")!;
const toast = document.getElementById("toast")!;
const actionMenu = document.getElementById("clip-action-menu")!;
const addMenu = document.getElementById("add-to-collection-menu")!;
const favoritesToggle = document.getElementById("favorites-toggle") as HTMLButtonElement;
const selectionToggle = document.getElementById("selection-toggle") as HTMLButtonElement;
const selectionToolbar = document.getElementById("selection-toolbar")!;
const selectionAll = document.getElementById("selection-all") as HTMLButtonElement;
const selectionCount = document.getElementById("selection-count")!;
const selectionAdd = document.getElementById("selection-add") as HTMLButtonElement;
const selectionDestructive = document.getElementById("selection-destructive") as HTMLButtonElement;
const selectionCancel = document.getElementById("selection-cancel") as HTMLButtonElement;
const noteModal = document.getElementById("note-modal")!;
const noteInput = document.getElementById("note-input") as HTMLTextAreaElement;
const noteCancel = document.getElementById("note-cancel") as HTMLButtonElement;
const noteSave = document.getElementById("note-save") as HTMLButtonElement;
const workspace = document.getElementById("workspace")!;
const drawerPane = document.getElementById("workspace-drawer")!;
const previewPane = document.getElementById("workspace-preview")!;
const workspaceTabs = document.getElementById("workspace-tabs")!;
const drawerTab = document.getElementById("workspace-tab-drawer") as HTMLButtonElement;
const previewTab = document.getElementById("workspace-tab-preview") as HTMLButtonElement;

// Bind the primary drawer action synchronously while the deferred script is
// evaluated. The panel can become clickable before async init finishes, so
// registering this after its first awaits loses the user's first click.
favoritesToggle.addEventListener("click", () => {
  void toggleSidebar();
});

// === Init ===
async function refreshConfig() {
  try {
    const config = await configBootstrap.loadAndApply();
    vimMode = !!config.vim_mode;
    previewEnabled = config.preview_enabled !== false;
    rememberHistoryFilter = !!config.remember_history_filter;
    shortcutMatcher = new ShortcutMatcher(config.favorites_toggle_shortcut?.codes ?? FAVORITES_DEFAULT_CODES);
  } catch (err) {
    console.error("Failed to load config:", err);
  }
}

function currentDrawerView(): DrawerView | null {
  return drawerViewCoordinator.currentView;
}

function selectedCollectionId(): string | null {
  return currentDrawerView()?.selectedCollection ?? null;
}

function drawerSnapshots(): readonly FavoriteItem[] {
  return currentDrawerView()?.activeSnapshots ?? [];
}

function drawerIsOpen(): boolean {
  return currentDrawerView()?.open ?? false;
}

function activeDataset(): readonly DisplayItem[] {
  return selectedCollectionId() === null ? history.view : drawerSnapshots();
}

function favoriteItemReorderEnabled(): boolean {
  return selectedCollectionId() !== null
    && searchInput.value.length === 0
    && activeFilter === "all"
    && !multiSelect.active;
}

function updateFavoritesToggleA11y() {
  const open = drawerIsOpen();
  favoritesToggle.classList.toggle("active", open);
  favoritesToggle.setAttribute("aria-pressed", String(open));
  favoritesToggle.setAttribute("aria-label", t(open ? "sidebarClose" : "sidebarOpen"));
  favoritesToggle.title = t(open ? "sidebarClose" : "sidebarOpen");
  void applyWorkspaceLayout();
}

async function applyWorkspaceLayout(): Promise<void> {
  const revision = ++workspaceLayoutRevision;
  const monitor = await currentMonitor().catch(() => null);
  const availableCssWidth = monitor
    ? monitor.workArea.size.width / (window.devicePixelRatio || 1)
    : window.screen.availWidth;
  const layout = decideWorkspaceLayout(
    availableCssWidth,
    drawerIsOpen(),
    previewState.isOpen,
    workspaceTab,
  );
  if (revision !== workspaceLayoutRevision) return;

  workspace.dataset.mode = layout.mode;
  workspace.style.setProperty("--history-left", `${layout.leftExtent}px`);
  workspace.style.setProperty("--side-left", `${layout.leftExtent + 428}px`);
  drawerPane.classList.toggle("hidden", !layout.drawerVisible);
  previewPane.classList.toggle("hidden", !layout.previewVisible);
  workspaceTabs.classList.toggle("hidden", layout.mode !== "compact" && layout.mode !== "overlay");
  drawerTab.setAttribute("aria-selected", String(layout.activeTab === "drawer"));
  previewTab.setAttribute("aria-selected", String(layout.activeTab === "preview"));
  drawerTab.disabled = !drawerIsOpen();
  previewTab.disabled = !previewState.isOpen;

  await invoke("set_main_workspace_layout", {
    leftExtent: layout.leftExtent,
    rightExtent: layout.rightExtent,
  }).catch((err) => console.error("Failed to resize workspace:", err));
}

function renderPanelDrawerView(next: DrawerView, previous: DrawerView | null): void {
  if (previous?.selectedCollection !== next.selectedCollection) {
    multiSelect.exit();
    selectedIndex = 0;
  }
  if (next.open && previous?.open !== true) workspaceTab = "drawer";
  favoritesToggle.disabled = false;
  updateFavoritesToggleA11y();
  render();
}

async function init() {
  await refreshConfig();
  applyI18n();

  await history.load();
  selectedIndex = 0;
  render();

  try {
    await drawerViewProjection.startup();
  } catch (error) {
    console.error("Failed to load initial Drawer view:", error);
    showToast(t("drawerLoadFailed"));
  }

  await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    if (!focused) return;
    resyncPreviewState();
    void drawerViewProjection.retryIfStale().catch((error) => {
      console.error("Failed to retry stale Drawer view:", error);
    });
    refreshConfig().then(() => {
      applyI18n();
      updateFavoritesToggleA11y();
      multiSelect.exit();
      searchInput.value = "";
      selectedIndex = 0;
      openMenuClipId = null;
      hideActionMenu();
      if (!rememberHistoryFilter) {
        activeFilter = "all";
      }
      render();
      const view = currentDrawerView();
      if (view) {
        try {
          panelDrawer.render(view);
        } catch (error) {
          console.error("Failed to relocalize Drawer navigation:", error);
        }
      }
      clipList.scrollTop = 0;
    });
  });

  await listen<ClipboardUpdate>("clipboard-update", (event) => {
    history.applyCapture(event.payload);
    render();
  });

  await listen<void>("main-panel-reset", () => {
    closeNoteModal();
    exitMultiSelect(false);
    hideActionMenu();
    panelDrawer.closeOverlays();
  });

  selectionToggle.addEventListener("click", () => {
    if (multiSelect.active) exitMultiSelect();
    else enterMultiSelect();
  });
  selectionAll.addEventListener("click", () => {
    multiSelect.toggleAllVisible(visibleClips.map((item) => item.id));
    render();
  });
  selectionAdd.addEventListener("click", openBatchAddChooser);
  selectionDestructive.addEventListener("click", () => void runBatchDestructiveAction());
  selectionCancel.addEventListener("click", () => exitMultiSelect());
  drawerTab.addEventListener("click", () => {
    workspaceTab = "drawer";
    void applyWorkspaceLayout();
  });
  previewTab.addEventListener("click", () => {
    workspaceTab = "preview";
    void applyWorkspaceLayout();
  });

  document.addEventListener("keydown", onFavoritesShortcutKeydown, true);
  document.addEventListener("keyup", onFavoritesShortcutKeyup, true);
}

async function toggleSidebar() {
  await drawerViewCoordinator.toggle();
}

function onFavoritesShortcutKeydown(e: KeyboardEvent) {
  if (shortcutMatcher.keydown(e.code, e.repeat)) {
    e.preventDefault();
    e.stopPropagation();
    if (currentDrawerView() === null) return;
    void toggleSidebar();
  }
}

function onFavoritesShortcutKeyup(e: KeyboardEvent) {
  shortcutMatcher.keyup(e.code);
}

// === Link classification ===
// (isLink/classifyClip/matchesFilter live in dataset.ts; classifyClip drives
//  both filter matching and icon selection below.)

// === Filter bar ===
function setFilter(filter: FilterKind) {
  if (filter === activeFilter) return;
  multiSelect.exit();
  activeFilter = filter;
  selectedIndex = 0;
  render();
}

function updateFilterBar() {
  filterBar.querySelectorAll(".filter-btn").forEach((btn) => {
    const el = btn as HTMLButtonElement;
    const filter = el.dataset.filter;
    const isActive = filter === activeFilter;
    el.classList.toggle("active", isActive);
    el.setAttribute("aria-pressed", String(isActive));
  });
  filterBar.setAttribute("aria-label", t("filterBarLabel"));
}

// === SVG icon helpers ===
const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(name: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS(SVG_NS, name);
  for (const key in attrs) {
    el.setAttribute(key, attrs[key]);
  }
  return el;
}

function iconRoot(size: number, fill: string, stroke: string): SVGElement {
  const attrs: Record<string, string> = {
    width: String(size),
    height: String(size),
    viewBox: "0 0 24 24",
    fill,
    stroke,
    "aria-hidden": "true",
    focusable: "false",
  };
  if (stroke !== "none") attrs["stroke-width"] = "2";
  return svgEl("svg", attrs);
}

function copyIcon(size: number): SVGElement {
  const svg = iconRoot(size, "none", "currentColor");
  svg.append(
    svgEl("rect", { x: "9", y: "9", width: "13", height: "13", rx: "2" }),
    svgEl("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" }),
  );
  return svg;
}

/** Text glyph matching the filter bar's 文字 icon. */
function textIcon(): SVGElement {
  const svg = iconRoot(16, "none", "currentColor");
  svg.append(
    svgEl("polyline", { points: "4 7 4 4 20 4 20 7" }),
    svgEl("line", { x1: "9", y1: "20", x2: "15", y2: "20" }),
    svgEl("line", { x1: "12", y1: "4", x2: "12", y2: "20" }),
  );
  return svg;
}

/** Image glyph matching the filter bar's 圖片 icon (no-thumbnail fallback). */
function imageIcon(): SVGElement {
  const svg = iconRoot(16, "none", "currentColor");
  svg.append(
    svgEl("rect", { x: "3", y: "3", width: "18", height: "18", rx: "2", ry: "2" }),
    svgEl("circle", { cx: "8.5", cy: "8.5", r: "1.5" }),
    svgEl("polyline", { points: "21 15 16 10 5 21" }),
  );
  return svg;
}

function fileIcon(): SVGElement {
  const svg = iconRoot(16, "none", "currentColor");
  svg.append(
    svgEl("path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" }),
    svgEl("polyline", { points: "14 2 14 8 20 8" }),
  );
  return svg;
}

function linkIcon(): SVGElement {
  const svg = iconRoot(16, "none", "currentColor");
  svg.append(
    svgEl("path", { d: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" }),
    svgEl("path", { d: "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" }),
  );
  return svg;
}

function pinIcon(pinned: boolean): SVGElement {
  const svg = iconRoot(15, pinned ? "currentColor" : "none", "currentColor");
  svg.append(
    svgEl("path", { d: "M12 2v8M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" }),
    svgEl("path", { d: "M4 6h16" }),
    svgEl("path", { d: "M10 10v8a2 2 0 0 0 2 2 2 2 0 0 0 2-2v-8" }),
  );
  return svg;
}

function moreIcon(): SVGElement {
  const svg = iconRoot(15, "currentColor", "none");
  svg.append(
    svgEl("circle", { cx: "5", cy: "12", r: "2" }),
    svgEl("circle", { cx: "12", cy: "12", r: "2" }),
    svgEl("circle", { cx: "19", cy: "12", r: "2" }),
  );
  return svg;
}

function dragGripIcon(size = 14): SVGElement {
  const svg = iconRoot(size, "currentColor", "none");
  for (const [cx, cy] of [[9, 6], [15, 6], [9, 12], [15, 12], [9, 18], [15, 18]] as const) {
    svg.append(svgEl("circle", { cx: String(cx), cy: String(cy), r: "1.5" }));
  }
  return svg;
}

// === Multi-select ===
function enterMultiSelect(): void {
  hideActionMenu();
  multiSelect.enter();
  render();
}

function exitMultiSelect(renderNow = true): void {
  multiSelect.exit();
  hideAddChooser();
  if (renderNow) render();
}

function selectedBatchItems(): DisplayItem[] {
  const ids = multiSelect.idsInOrder(activeDataset().map((item) => item.id));
  const selected = new Set(ids);
  return activeDataset().filter((item) => selected.has(item.id));
}

function updateSelectionToolbar(): void {
  selectionToolbar.classList.toggle("hidden", !multiSelect.active);
  selectionToolbar.setAttribute("aria-label", t("selectionToolbarLabel"));
  selectionToggle.classList.toggle("active", multiSelect.active);
  selectionToggle.setAttribute("aria-pressed", String(multiSelect.active));
  selectionToggle.setAttribute("aria-label", t(multiSelect.active ? "selectionExit" : "selectionEnter"));
  selectionToggle.title = t(multiSelect.active ? "selectionExit" : "selectionEnter");
  if (!multiSelect.active) return;

  const visibleIds = visibleClips.map((item) => item.id);
  const allVisibleSelected = multiSelect.allVisibleSelected(visibleIds);
  selectionAll.textContent = t(allVisibleSelected ? "clearVisibleSelection" : "selectAllVisible");
  selectionAll.disabled = visibleIds.length === 0;
  selectionCount.textContent = t("selectedCount", { n: String(multiSelect.size) });
  const collectionId = selectedCollectionId();
  selectionAdd.textContent = t(collectionId === null ? "addToCollection" : "addToOtherCollection");
  selectionDestructive.textContent = t(collectionId === null ? "deleteTitle" : "removeFromCollection");
  const nothingSelected = multiSelect.size === 0;
  selectionAdd.disabled = nothingSelected || currentDrawerView() === null;
  selectionDestructive.disabled = nothingSelected;
}

// === Render ===
function render() {
  const query = searchInput.value.toLowerCase();
  const source = activeDataset();
  const filtered = filterItems(source, query, activeFilter);
  visibleClips = filtered;
  multiSelect.prune(source.map((item) => item.id));

  if (visibleClips.length === 0) {
    selectedIndex = -1;
  } else {
    if (selectedIndex < 0) selectedIndex = 0;
    if (selectedIndex >= visibleClips.length) selectedIndex = visibleClips.length - 1;
  }

  openMenuClipId = null;
  hideActionMenu();

  const scrollTop = clipList.scrollTop;
  panelDrawer.cancel("source-removed");
  clipList.replaceChildren();

  const searching = query.length > 0;
  const filtering = activeFilter !== "all";
  const showEmpty = visibleClips.length === 0;
  const totalEmpty = source.length === 0;

  emptyState.classList.toggle("hidden", !showEmpty);
  if (showEmpty) {
    if (totalEmpty) {
      const collectionId = selectedCollectionId();
      emptyTitle.textContent = collectionId === null ? t("emptyTitle") : t("favoritesEmptyTitle");
      emptyHint.classList.toggle("hidden", collectionId !== null);
      if (collectionId !== null) {
        emptyHint.textContent = t("favoritesEmptyHint");
        emptyHint.classList.remove("hidden");
      }
    } else if (searching || filtering) {
      emptyTitle.textContent =
        searching && filtering ? t("noResults") : filtering && !searching ? t("categoryEmpty") : t("noResults");
      emptyHint.classList.add("hidden");
    }
  }

  updateFilterBar();
  updateSelectionToolbar();

  let hasPinned = false;
  let hasUnpinned = false;

  filtered.forEach((item, index) => {
    const isFav = isFavoriteItem(item);
    const pinned = !isFav && item.pinned;
    if (pinned && !hasPinned) {
      hasPinned = true;
    }
    if (!pinned && !hasUnpinned && hasPinned) {
      const divider = document.createElement("div");
      divider.className = "pinned-divider";
      divider.textContent = t("pinnedDivider");
      clipList.appendChild(divider);
      hasUnpinned = true;
    }

    const el = document.createElement("div");
    el.className = `clip-item${item.truncated ? " truncated" : ""}${index === selectedIndex ? " selected" : ""}${multiSelect.active ? " multi-select-mode" : ""}${multiSelect.has(item.id) ? " batch-selected" : ""}`;
    el.dataset.index = String(index);
    el.dataset.clipId = item.id;
    el.dataset.isFavorite = isFav ? "1" : "0";
    el.setAttribute("aria-selected", String(multiSelect.has(item.id)));

    if (multiSelect.active) {
      const checkbox = document.createElement("button");
      checkbox.type = "button";
      checkbox.className = "selection-checkbox";
      checkbox.setAttribute("role", "checkbox");
      checkbox.setAttribute("aria-checked", String(multiSelect.has(item.id)));
      checkbox.setAttribute("aria-label", t("selectItem"));
      checkbox.addEventListener("click", (e) => {
        e.stopPropagation();
        multiSelect.toggle(item.id);
        render();
      });
      el.appendChild(checkbox);
    }

    el.addEventListener("click", () => {
      if (multiSelect.active) {
        multiSelect.toggle(item.id);
        render();
      } else {
        pasteActive(item);
      }
    });

    el.addEventListener("pointerenter", () => {
      if (previewEnabled) showPreviewFor(item);
    });

    const dragHandle = document.createElement("button");
    dragHandle.type = "button";
    dragHandle.className = "clip-drag-handle";
    const dragLabel = isFav && favoriteItemReorderEnabled()
      ? t("dragToReorderOrDrawer")
      : t("dragToDrawer");
    dragHandle.setAttribute("aria-label", dragLabel);
    dragHandle.title = dragLabel;
    dragHandle.appendChild(dragGripIcon());
    el.appendChild(dragHandle);
    attachRowDrag(el, dragHandle, item);

    const iconDiv = document.createElement("div");
    const category = classifyClip(item);
    if (category === "image" && item.thumbnail_base64) {
      iconDiv.className = "thumbnail-container";
      const img = document.createElement("img");
      img.src = item.thumbnail_base64;
      img.alt = "Image";
      iconDiv.appendChild(img);
    } else {
      iconDiv.className = "clip-icon text-icon";
      iconDiv.appendChild(
        category === "files"
          ? fileIcon()
          : category === "links"
            ? linkIcon()
            : category === "image"
              ? imageIcon()
              : textIcon(),
      );
    }
    el.appendChild(iconDiv);

    const contentDiv = document.createElement("div");
    contentDiv.className = "clip-content";

    const title = document.createElement("div");
    title.className = "clip-title";
    let titleText = item.preview || "(empty)";
    if (item.kind === "Image") {
      titleText = t("imageClip");
    } else if (item.kind === "Text") {
      titleText = titleText.replace(/\n/g, " ");
    }
    title.textContent = titleText;
    contentDiv.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "clip-meta";
    const source = document.createElement("span");
    source.className = "source";
    source.textContent = !item.source_exe || item.source_exe === "Unknown" ? t("unknownSource") : item.source_exe;
    meta.appendChild(source);

    const size = document.createElement("span");
    size.textContent = item.kind === "Image" ? `${(item.byte_size / 1024 / 1024).toFixed(1)}MB` : `${item.byte_size} B`;
    meta.appendChild(size);

    contentDiv.appendChild(meta);
    el.appendChild(contentDiv);

    const time = document.createElement("span");
    time.className = "clip-time";
    time.textContent = formatTime(isFav ? item.added_at ?? item.captured_at : item.captured_at);
    el.appendChild(time);

    const actions = document.createElement("div");
    actions.className = "clip-actions";

    if (!isFav) {
      const pinBtn = document.createElement("button");
      pinBtn.className = `clip-action-btn pin-btn${item.pinned ? " pinned" : ""}`;
      pinBtn.appendChild(pinIcon(item.pinned));
      pinBtn.title = item.pinned ? t("unpinTitle") : t("pinTitle");
      pinBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        togglePin(item as Clip);
      });
      actions.appendChild(pinBtn);
    }

    const copyBtn = document.createElement("button");
    copyBtn.className = "clip-action-btn";
    copyBtn.appendChild(copyIcon(15));
    copyBtn.title = t("copyOnlyTitle");
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      copyActive(item);
    });
    actions.appendChild(copyBtn);

    const moreBtn = document.createElement("button");
    moreBtn.className = "clip-action-btn more-btn";
    moreBtn.appendChild(moreIcon());
    moreBtn.title = t("moreTitle");
    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleActionMenu(item.id, moreBtn);
    });
    actions.appendChild(moreBtn);

    el.appendChild(actions);
    clipList.appendChild(el);
  });

  clipList.scrollTop = scrollTop;
  if (selectedIndex >= 0) {
    const selected = clipList.querySelector(".clip-item.selected");
    selected?.scrollIntoView({ block: "nearest" });
  }
  syncPreviewToSelection();
}

// === Action Menu ===
// Place an absolutely-positioned menu so it stays inside the panel: prefer
// below the anchor, flip above when that side has more room, and constrain the
// height (vertical scroll) when it is taller than either side. `anchor` is in
// viewport coordinates; `right` is the anchor-right distance from the panel's
// right edge.
function placeMenu(
  menu: HTMLElement,
  anchor: { top: number; bottom: number },
  panelRect: DOMRect,
  right: number,
): void {
  menu.classList.remove("hidden");
  // Reset any previous constraint so the measurement is the natural size.
  menu.style.maxHeight = "";
  menu.style.maxWidth = "";
  const p = computeMenuPlacement(
    { top: anchor.top - panelRect.top, bottom: anchor.bottom - panelRect.top },
    { width: panelRect.width, height: panelRect.height },
    menu.offsetWidth,
    menu.offsetHeight,
    right,
  );
  menu.style.top = `${p.top}px`;
  menu.style.right = `${p.right}px`;
  menu.style.maxHeight = p.maxHeight === null ? "" : `${p.maxHeight}px`;
  menu.style.maxWidth = p.maxWidth === null ? "" : `${p.maxWidth}px`;
}

function toggleActionMenu(clipId: string, anchor: HTMLElement) {
  if (openMenuClipId === clipId) {
    hideActionMenu();
    return;
  }
  openMenuClipId = clipId;
  // Opening a fresh More menu dismisses any lingering add-to-collection chooser
  // so the two never overlap.
  hideAddChooser();
  const item = activeDataset().find((c) => c.id === clipId);
  if (!item) return;
  renderActionMenu(item);
  const rect = anchor.getBoundingClientRect();
  const panelRect = document.getElementById("panel")!.getBoundingClientRect();
  const right = panelRect.right - rect.right;
  placeMenu(actionMenu, rect, panelRect, right);
  lastMenuPos = { anchorTop: rect.top, anchorBottom: rect.bottom, right };
}

function renderActionMenu(item: DisplayItem) {
  actionMenu.replaceChildren();
  const isFav = isFavoriteItem(item);

  actionMenu.appendChild(menuItem(t("noteAction"), () => {
    openNoteModal(item);
  }));

  if (isFav) {
    const snapshots = drawerSnapshots();
    const itemIndex = snapshots.findIndex((favorite) => favorite.id === item.id);
    const reorderEnabled = favoriteItemReorderEnabled();
    const moveUp = menuItem(t("moveUp"), () => void moveFavoriteItem(item.id, -1));
    moveUp.disabled = !reorderEnabled || itemIndex <= 0;
    actionMenu.appendChild(moveUp);
    const moveDown = menuItem(t("moveDown"), () => void moveFavoriteItem(item.id, 1));
    moveDown.disabled = !reorderEnabled || itemIndex < 0 || itemIndex >= snapshots.length - 1;
    actionMenu.appendChild(moveDown);
    actionMenu.appendChild(menuItem(t("removeFromCollection"), () => {
      const fav = item as FavoriteItem;
      const collectionId = selectedCollectionId();
      if (!collectionId) return;
      void drawerMutations.removeFromCollection({ collectionId, itemId: fav.id })
        .then((outcome) => {
          if (outcome.status === "succeeded") showToast(t("removedFromFavorites"));
          else if (outcome.status === "failed") showToast(localizeDrawerError(String(outcome.error)));
        });
    }, true));
    actionMenu.appendChild(menuItem(t("addToOtherCollection"), () => {
      hideActionMenu();
      openAddChooser(item);
    }));
  } else {
    const addToCollection = menuItem(t("addToCollection"), () => {
      hideActionMenu();
      openAddChooser(item);
    });
    addToCollection.disabled = currentDrawerView() === null;
    actionMenu.appendChild(addToCollection);
    actionMenu.appendChild(menuItem(t("deleteTitle"), () => {
      deleteClip(item as Clip);
    }, true));
  }
}

function menuItem(label: string, onClick: () => void, danger = false): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = `menu-item${danger ? " menu-item-delete" : ""}`;
  b.setAttribute("role", "menuitem");
  b.textContent = label;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

async function moveFavoriteItem(itemId: string, delta: number): Promise<void> {
  const collectionId = selectedCollectionId();
  if (!collectionId || !favoriteItemReorderEnabled()) return;
  const currentIds = drawerSnapshots().map((item) => item.id);
  const nextIds = moveOne(currentIds, currentIds.indexOf(itemId), delta);
  if (nextIds.every((id, index) => id === currentIds[index])) return;
  hideActionMenu();
  const outcome = await drawerMutations.reorderItems({ collectionId, orderedItemIds: nextIds });
  if (outcome.status === "failed") showToast(localizeDrawerError(String(outcome.error)));
}

function hideActionMenu() {
  openMenuClipId = null;
  actionMenu.classList.add("hidden");
  hideAddChooser();
}

function openNoteModal(item: DisplayItem): void {
  hideActionMenu();
  noteTarget = clipLocator(item);
  noteInput.value = item.note ?? "";
  workspace.classList.add("note-editing");
  noteModal.classList.remove("hidden");
  noteInput.focus();
  noteInput.setSelectionRange(noteInput.value.length, noteInput.value.length);
  void invoke("set_main_modal_open", { open: true }).catch((err) => {
    console.error("Failed to protect note editor focus:", err);
  });
}

function closeNoteModal(): void {
  const wasOpen = noteTarget !== null || !noteModal.classList.contains("hidden");
  noteTarget = null;
  noteInput.value = "";
  workspace.classList.remove("note-editing");
  noteModal.classList.add("hidden");
  noteSave.disabled = false;
  if (wasOpen) {
    void invoke("set_main_modal_open", { open: false }).catch((err) => {
      console.error("Failed to release note editor focus:", err);
    });
  }
}

async function saveNote(): Promise<void> {
  const target = noteTarget;
  if (!target) return;
  noteSave.disabled = true;
  try {
    const completion = await locatedClip.setNote(target, noteInput.value);
    closeNoteModal();
    if (completion.status === "published") showToast(t("noteSaved"));
  } catch (err) {
    noteSave.disabled = false;
    showToast(localizeLocatedClipError(err, "drawerActionFailed"));
  }
}

noteCancel.addEventListener("click", closeNoteModal);
noteSave.addEventListener("click", () => void saveNote());
noteModal.addEventListener("click", (e) => {
  if (e.target === noteModal) closeNoteModal();
});
noteModal.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Escape") {
    e.preventDefault();
    closeNoteModal();
  } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    void saveNote();
  }
});

// === Add-to-collection chooser ===
async function requestCreateCollection(): Promise<void> {
  if (await drawerViewCoordinator.setOpen(true)) {
    panelDrawer.requestCreate();
  }
}

function openAddChooser(item: DisplayItem) {
  const token = chooserGate.open(item.id);
  const locator: ClipLocator = clipLocator(item);

  drawerMutations.memberCollectionIds(locator).then((existing) => {
    if (!chooserGate.isCurrent(item.id, token)) return;
    renderAddChooser(locator, existing);
  }).catch((error) => showToast(localizeDrawerError(String(error))));
}

function renderAddChooser(locator: ClipLocator, existing: readonly string[]) {
  addMenu.replaceChildren();
  const collections = currentDrawerView()?.collections ?? [];

  if (collections.length === 0) {
    const create = menuItem(t("createCollection"), () => {
      hideAddChooser();
      void requestCreateCollection();
    });
    addMenu.appendChild(create);
  } else {
    collections.forEach((c) => {
      const member = existing.includes(c.id);
      const b = menuItem(`${c.name}${member ? ` · ${t("addedToFavorites")}` : ""}`, () => {
        hideAddChooser();
        void drawerMutations.addToCollection({ collectionId: c.id, locator })
          .then((outcome) => {
            if (outcome.status === "succeeded") showToast(t("addedToFavorites"));
            else if (outcome.status === "failed") showToast(localizeDrawerError(String(outcome.error)));
          });
      });
      b.disabled = member;
      b.classList.toggle("menu-item-checked", member);
      addMenu.appendChild(b);
    });
  }

  // Position to the left of where the More menu opened (the menu is hidden now,
  // so reuse its last recorded anchor), flipping above when there is no room
  // below.
  const panelRect = document.getElementById("panel")!.getBoundingClientRect();
  placeMenu(
    addMenu,
    { top: lastMenuPos.anchorTop, bottom: lastMenuPos.anchorBottom },
    panelRect,
    lastMenuPos.right + 8,
  );
}

function hideAddChooser() {
  chooserGate.close();
  batchChooserOpen = false;
  addMenu.classList.add("hidden");
}

function openBatchAddChooser(): void {
  const items = selectedBatchItems();
  if (items.length === 0) return;
  chooserGate.close();
  batchChooserOpen = true;
  actionMenu.classList.add("hidden");
  addMenu.replaceChildren();

  const collections = currentDrawerView()?.collections ?? [];
  const targets = collections.filter((collection) => collection.id !== selectedCollectionId());
  if (collections.length === 0) {
    addMenu.appendChild(menuItem(t("createCollection"), () => {
      exitMultiSelect();
      void requestCreateCollection();
    }));
  } else if (targets.length === 0) {
    const none = menuItem(t("noOtherCollections"), () => {});
    none.disabled = true;
    addMenu.appendChild(none);
  } else {
    const locators = items.map((item) => clipLocator(item));
    for (const collection of targets) {
      addMenu.appendChild(menuItem(collection.name, () => {
        hideAddChooser();
        void drawerMutations.addBatchToCollection({
          collectionId: collection.id,
          locators,
        }).then((outcome) => {
          if (outcome.status === "failed") {
            showToast(localizeDrawerError(String(outcome.error)));
            return;
          }
          exitMultiSelect();
          if (outcome.status === "succeeded") {
            showToast(t("batchAdded", {
              changed: String(outcome.changed),
              unchanged: String(outcome.unchanged),
            }));
          }
        });
      }));
    }
  }

  const rect = selectionAdd.getBoundingClientRect();
  const panelRect = document.getElementById("panel")!.getBoundingClientRect();
  placeMenu(addMenu, rect, panelRect, panelRect.right - rect.right);
}

async function runBatchDestructiveAction(): Promise<void> {
  const items = selectedBatchItems();
  if (items.length === 0) return;

  if (selectedCollectionId() === null) {
    const ids = items.map((item) => item.id);
    try {
      const undo = await history.removeBatch(ids);
      exitMultiSelect();
      showToast(t("batchDeleted", { n: String(ids.length) }), async () => {
        try {
          await undo.undo();
          render();
        } catch (err) {
          showToast(localizeBackendError(String(err)));
        }
      });
    } catch (err) {
      showToast(localizeBackendError(String(err)));
    }
    return;
  }

  const collectionId = selectedCollectionId();
  if (!collectionId) return;
  const itemIds = items.map((item) => item.id);
  const outcome = await drawerMutations.removeBatchFromCollection({ collectionId, itemIds });
  if (outcome.status !== "failed") {
    exitMultiSelect();
    if (outcome.status === "succeeded") {
      showToast(t("batchRemoved", { n: String(outcome.changed) }));
    }
  } else {
    showToast(localizeDrawerError(String(outcome.error)));
  }
}

actionMenu.addEventListener("click", (e) => {
  e.stopPropagation();
});
addMenu.addEventListener("click", (e) => {
  e.stopPropagation();
});

// === Actions ===
async function pasteActive(item: DisplayItem) {
  try {
    await locatedClip.paste(clipLocator(item));
  } catch (err) {
    console.error("Paste failed:", err);
    showToast(localizeLocatedClipError(err, "pasteFailed"));
  }
}

async function copyActive(item: DisplayItem) {
  try {
    await locatedClip.copy(clipLocator(item));
  } catch (err) {
    console.error("Copy failed:", err);
    showToast(localizeLocatedClipError(err, "copyFailed"));
  }
}

async function deleteClip(clip: Clip) {
  try {
    const undo = await history.remove(clip.id);
    render();
    if (!undo) return;
    showToast(t("deleted"), async () => {
      try {
        await undo.undo();
        render();
      } catch (err) {
        showToast(localizeBackendError(String(err)));
      }
    });
  } catch (err) {
    console.error("Delete failed:", err);
  }
}

async function togglePin(clip: Clip) {
  try {
    await history.togglePin(clip.id);
    render();
  } catch (err) {
    showToast(localizeBackendError(String(err)));
  }
}

async function closePanel() {
  await invoke("hide_panel_command");
}

// === Automatic Preview ===
function showPreviewFor(item: DisplayItem) {
  if (!previewEnabled || previewState.currentId === item.id) return;
  const token = previewState.beginShow(item.id);
  workspaceTab = tabAfterPreviewIntent(workspaceTab, drawerIsOpen());
  void applyWorkspaceLayout();
  locatedClip.preview(clipLocator(item))
    .then(() => {
      previewState.resolveShow(token, item.id);
      void applyWorkspaceLayout();
    })
    .catch((err) => {
      console.error("Failed to show preview:", localizeLocatedClipError(err));
      if (previewState.isCurrent(token)) resyncPreviewState();
    });
}

function syncPreviewToSelection() {
  const selected = visibleClips[selectedIndex] ?? null;
  const action = decidePreviewSync(
    previewEnabled,
    document.hasFocus(),
    selected?.id ?? null,
    previewState.currentId,
  );
  if (action.type === "hide") hidePreview();
  else if (action.type === "show" && selected) showPreviewFor(selected);
}

function hidePreview() {
  const token = previewState.beginHide();
  invoke("hide_clip_preview")
    .then(() => {
      previewState.resolveHide(token);
      void applyWorkspaceLayout();
    })
    .catch((err) => {
      console.error("Failed to hide preview:", err);
      if (previewState.isCurrent(token)) resyncPreviewState();
    });
}

function resyncPreviewState() {
  const token = previewState.beginResync();
  invoke<{ id: string } | null>("get_active_clip_preview")
    .then((active) => {
      previewState.resolveResync(token, active ? active.id : null);
      void applyWorkspaceLayout();
    })
    .catch(() => {});
}

function isSpaceKey(e: KeyboardEvent): boolean {
  return e.code === "Space" || e.key === " ";
}

// === Item drag source (to the sidebar or within the active drawer) ===
// Pointer events provide session facts only. Drawer drag owns reorder
// precedence, insertion state, auto-scroll, mutation, and terminal cleanup.

function attachRowDrag(row: HTMLElement, handle: HTMLElement, item: DisplayItem) {
  let session: DrawerDragSession | null = null;
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    session = panelDrawer.start(item, row, { x: e.clientX, y: e.clientY });
  });
  handle.addEventListener("pointermove", (e) => {
    if (session === null) return;
    panelDrawer.move(session, { x: e.clientX, y: e.clientY });
  });
  handle.addEventListener("pointerup", (e) => {
    if (session === null) return;
    const ending = session;
    session = null;
    void panelDrawer.end(ending, { x: e.clientX, y: e.clientY });
  });
  const cancel = (reason: DrawerDragCancelReason) => {
    if (session === null) return;
    const cancelled = session;
    session = null;
    panelDrawer.cancel(reason, cancelled);
  };
  handle.addEventListener("pointercancel", () => cancel("pointercancel"));
  handle.addEventListener("lostpointercapture", () => cancel("lostpointercapture"));
  handle.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
  });
}

// === Toast ===
function showToast(message: string, onUndo?: () => void) {
  if (toastTimer) clearTimeout(toastTimer);

  toast.replaceChildren();
  const span = document.createElement("span");
  span.textContent = message;
  toast.appendChild(span);

  if (onUndo) {
    const undoBtn = document.createElement("button");
    undoBtn.className = "undo-btn";
    undoBtn.textContent = t("undo");
    undoBtn.addEventListener("click", () => {
      onUndo();
      hideToast();
    });
    toast.appendChild(undoBtn);
  }

  toast.classList.remove("hidden");

  toastTimer = setTimeout(() => {
    hideToast();
  }, 4000);
}

function hideToast() {
  toast.classList.add("hidden");
  if (toastTimer) clearTimeout(toastTimer);
}

// === Formatting ===
function formatTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const sec = Math.floor(diff / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);

  if (sec < 60) return t("justNow");
  if (min < 60) return t("minutesAgo", { n: min });
  if (hr < 24) return t("hoursAgo", { n: hr });
  const days = Math.floor(hr / 24);
  return t("daysAgo", { n: days });
}

// === Keyboard Navigation ===
function moveSelection(delta: number) {
  if (visibleClips.length === 0) return;
  if (selectedIndex < 0) {
    selectedIndex = 0;
  } else {
    selectedIndex = Math.min(Math.max(selectedIndex + delta, 0), visibleClips.length - 1);
  }
  render();
}

function pasteSelected() {
  if (selectedIndex >= 0 && selectedIndex < visibleClips.length) {
    pasteActive(visibleClips[selectedIndex]);
  }
}

document.addEventListener("keydown", (e) => {
  const inSearch = document.activeElement === searchInput;
  const inFilter = document.activeElement instanceof HTMLElement && document.activeElement.closest("#filter-bar");

  if (multiSelect.active && !inSearch && !inFilter && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
    e.preventDefault();
    multiSelect.toggleAllVisible(visibleClips.map((item) => item.id));
    render();
    return;
  }

  if (e.key === "/" && !inSearch) {
    e.preventDefault();
    multiSelect.exit();
    render();
    searchInput.focus();
    return;
  }

  if (inFilter) {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const buttons = Array.from(filterBar.querySelectorAll(".filter-btn")) as HTMLButtonElement[];
      const currentIdx = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const nextIdx = e.key === "ArrowLeft" ? (currentIdx - 1 + buttons.length) % buttons.length : (currentIdx + 1) % buttons.length;
      buttons[nextIdx].focus();
      const filter = buttons[nextIdx].dataset.filter as FilterKind;
      setFilter(filter);
      return;
    }
  }

  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      moveSelection(1);
      return;
    case "ArrowUp":
      e.preventDefault();
      moveSelection(-1);
      return;
    case "Enter":
      e.preventDefault();
      if (inFilter) {
        const btn = document.activeElement as HTMLButtonElement;
        const filter = btn.dataset.filter as FilterKind;
        if (filter) {
          setFilter(filter);
          btn.focus();
        }
        return;
      }
      if (multiSelect.active) {
        const item = visibleClips[selectedIndex];
        if (item) {
          multiSelect.toggle(item.id);
          render();
        }
      } else {
        pasteSelected();
      }
      return;
    case "Escape":
      e.preventDefault();
      const transientOpen = multiSelect.active
        || !noteModal.classList.contains("hidden")
        || openMenuClipId !== null
        || chooserGate.isOpen
        || batchChooserOpen
        || panelDrawer.isAnyOverlayOpen();
      const layer = escapeLayer(transientOpen, previewState.isOpen, drawerIsOpen());
      if (layer === "modal-or-menu" && multiSelect.active) {
        exitMultiSelect();
        return;
      }
      if (layer === "modal-or-menu" && !noteModal.classList.contains("hidden")) {
        closeNoteModal();
        return;
      }
      if (layer === "modal-or-menu" && (openMenuClipId || chooserGate.isOpen || batchChooserOpen)) {
        hideActionMenu();
        return;
      }
      if (layer === "modal-or-menu" && panelDrawer.closeOverlays()) return;
      if (layer === "modal-or-menu") return;
      if (layer === "preview") {
        hidePreview();
        return;
      }
      if (layer === "drawer") {
        void drawerViewCoordinator.setOpen(false);
        return;
      }
      if (inSearch && vimMode) {
        searchInput.blur();
      } else {
        closePanel();
      }
      return;
  }

  if (!inSearch && !inFilter) {
    if (vimMode && (e.key === "j" || e.key === "k")) {
      e.preventDefault();
      moveSelection(e.key === "j" ? 1 : -1);
      return;
    }
  }
});

window.addEventListener("keydown", (e) => {
  if (!isSpaceKey(e) || !multiSelect.active) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (!e.repeat) {
    const item = visibleClips[selectedIndex];
    if (item) {
      multiSelect.toggle(item.id);
      render();
    }
  }
}, true);

// Focus loss (alt-tab, minimize) aborts an in-flight handle drag so the row
// doesn't stay stuck in a held/dragging state.
window.addEventListener("blur", () => {
  panelDrawer.cancel("window-blur");
});

searchInput.addEventListener("input", () => {
  multiSelect.exit();
  selectedIndex = 0;
  render();
});

filterBar.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest(".filter-btn") as HTMLButtonElement | null;
  if (!btn) return;
  const filter = btn.dataset.filter as FilterKind;
  if (filter && filter !== activeFilter) {
    setFilter(filter);
  }
});

document.addEventListener("click", (e) => {
  if (!openMenuClipId && !chooserGate.isOpen && !batchChooserOpen) return;
  const target = e.target as HTMLElement;
  if (!target.closest(".more-btn") && !target.closest("#clip-action-menu") && !target.closest("#add-to-collection-menu")) {
    hideActionMenu();
  }
}, true);

document.body.addEventListener("click", (e) => {
  if (e.target === document.body || e.target === document.documentElement) {
    closePanel();
  }
});

// === Initialize ===
window.addEventListener("DOMContentLoaded", () => {
  panelDrawer = mountDrawerRenderer(drawerViewCoordinator, {
    mutations: drawerMutations,
    // Reorder eligibility has one owner: Panel state. The drag adapter
    // receives it as data instead of scraping this renderer's rows.
    itemReorderSnapshot: () => ({
      enabled: favoriteItemReorderEnabled(),
      collectionId: selectedCollectionId(),
      orderedItemIds: drawerSnapshots().map((item) => item.id),
    }),
  });
  drawerViewCoordinator.subscribe({
    cancelDrag: () => {
      panelDrawer.cancel("source-removed");
    },
    renderPanel: renderPanelDrawerView,
    renderDrawer: (view) => panelDrawer.render(view),
  });
  void mountPreview();
  void init();
});
