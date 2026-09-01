import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { setLanguage, applyI18n, t, localizeBackendError } from "./i18n";
import { applyTheme } from "./theme";
import { decidePreviewSync, PreviewController } from "./preview-state";
import { ShortcutMatcher, FAVORITES_DEFAULT_CODES } from "./shortcut";
import { ChooserGate, computeMenuPlacement } from "./menu";
import { DragController, itemDragStartPayload, isFavoriteItem, clipLocator, rectContains } from "./drag";
import type { ItemDragPoint } from "./drag";
import { classifyClip, filterItems } from "./dataset";
import type { FilterKind } from "./dataset";
import { MultiSelectState } from "./multi-select";
import { decideWorkspaceLayout, escapeLayer, tabAfterPreviewIntent } from "./workspace-state";
import type { WorkspaceTab } from "./workspace-state";
import {
  beginInlineItemDrag,
  cancelHistoryDrawerDrag,
  cancelInlineItemDrag,
  endHistoryDrawerDrag,
  endInlineItemDrag,
  moveHistoryDrawerDrag,
  moveInlineItemDrag,
  startHistoryDrawerDrag,
} from "./favorites";
import { beginInlineDragCard, finishInlineDragCard, moveInlineDragCard } from "./drag-overlay";
import type { DrawerDragCancelReason } from "./drawer-drag";
import "./preview";
import { insertBefore, moveOne } from "./reorder";
import type { BatchMutationResult, Clip, ClipboardUpdate, ClipLocator, CollectionSummary, FavoriteItem, FavoritesUiState } from "./types";

type DisplayItem = Clip | FavoriteItem;

let clips: Clip[] = [];
let favoriteItems: FavoriteItem[] = [];
let collections: CollectionSummary[] = [];
let selectedCollection: string | null = null;
let sidebarOpen = false;
let sidebarStateRevision = 0;
let workspaceTab: WorkspaceTab = "drawer";
let workspaceLayoutRevision = 0;
// The search-filtered view of the active dataset, in display order. Keyboard
// selection indexes into this — never into the raw arrays directly.
let visibleClips: DisplayItem[] = [];
let selectedIndex = -1;
let vimMode = false;
let pasteFilesAsFiles = true;
let previewEnabled = true;
let rememberHistoryFilter = false;
let activeFilter: FilterKind = "all";
let openMenuClipId: string | null = null;
let noteTarget: ClipLocator | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
const previewState = new PreviewController();
let shortcutMatcher = new ShortcutMatcher(FAVORITES_DEFAULT_CODES);
// The history row currently being dragged toward the drawer, so a mid-drag
// re-render can clear its source feedback and broadcast a cancel.
let activeDragSource: HTMLElement | null = null;
// Monotonic session id + the active one, carried on every move/end/cancel so
// the sidebar can reject stale or cancelled drags.
let dragSessionSeq = 0;
let activeDragSessionId: number | null = null;
let activeDragKind: "history" | "favorite" | null = null;
let activeItemReorderId: string | null = null;
let itemReorderBeforeId: string | null = null;
let itemReorderInsideList = false;
let itemReorderPointer: { x: number; y: number } | null = null;
let itemReorderScrollFrame: number | null = null;
const chooserGate = new ChooserGate();
let lastMenuPos = { anchorTop: 0, anchorBottom: 0, right: 0 };
const multiSelect = new MultiSelectState();
let batchChooserOpen = false;

const searchInput = document.getElementById("search-input") as HTMLInputElement;
const filterBar = document.getElementById("filter-bar")!;
const clipList = document.getElementById("clip-list")!;
const itemReorderIndicator = document.createElement("div");
itemReorderIndicator.className = "clip-reorder-indicator";
itemReorderIndicator.setAttribute("aria-hidden", "true");
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
    const config = await invoke<{
      language?: string;
      vim_mode?: boolean;
      theme?: string;
      ui_opacity_percent?: number;
      paste_files_as_files?: boolean;
      preview_enabled?: boolean;
      remember_history_filter?: boolean;
      favorites_toggle_shortcut?: { codes: string[] };
    }>("get_config");
    setLanguage(config.language || "zh-TW");
    vimMode = !!config.vim_mode;
    pasteFilesAsFiles = config.paste_files_as_files !== false;
    previewEnabled = config.preview_enabled !== false;
    rememberHistoryFilter = !!config.remember_history_filter;
    applyTheme(config.theme || "system");
    const opacity = Math.min(100, Math.max(50, config.ui_opacity_percent ?? 99));
    document.documentElement.style.setProperty("--panel-opacity", String(opacity / 100));
    shortcutMatcher = new ShortcutMatcher(config.favorites_toggle_shortcut?.codes ?? FAVORITES_DEFAULT_CODES);
  } catch (err) {
    console.error("Failed to load config:", err);
    setLanguage("zh-TW");
  }
}

function sortClips() {
  clips.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.captured_at - a.captured_at);
}

function activeDataset(): DisplayItem[] {
  return selectedCollection === null ? clips : favoriteItems;
}

function favoriteItemReorderEnabled(): boolean {
  return selectedCollection !== null
    && searchInput.value.length === 0
    && activeFilter === "all"
    && !multiSelect.active;
}

async function loadFavoritesContext() {
  const sidebarRevision = sidebarStateRevision;
  try {
    const previousCollection = selectedCollection;
    const [cols, state] = await Promise.all([
      invoke<CollectionSummary[]>("list_collections"),
      invoke<FavoritesUiState>("get_favorites_ui_state"),
    ]);
    collections = cols;
    selectedCollection = state.selected_collection;
    if (previousCollection !== selectedCollection) multiSelect.exit();
    // A startup/event snapshot may have begun before a newer user toggle.
    // Never let that older read overwrite the optimistic state of the click.
    if (sidebarRevision === sidebarStateRevision) sidebarOpen = state.open;
    if (selectedCollection !== null) {
      favoriteItems = await invoke<FavoriteItem[]>("list_favorite_items", { collectionId: selectedCollection });
    } else {
      favoriteItems = [];
    }
    favoritesToggle.classList.toggle("active", sidebarOpen);
    favoritesToggle.setAttribute("aria-pressed", String(sidebarOpen));
    favoritesToggle.title = sidebarOpen ? t("sidebarClose") : t("sidebarOpen");
    render();
    void applyWorkspaceLayout();
  } catch (err) {
    console.error("Failed to load favorites context:", err);
  }
}

function updateFavoritesToggleA11y() {
  favoritesToggle.classList.toggle("active", sidebarOpen);
  favoritesToggle.setAttribute("aria-pressed", String(sidebarOpen));
  favoritesToggle.title = sidebarOpen ? t("sidebarClose") : t("sidebarOpen");
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
    sidebarOpen,
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
  drawerTab.disabled = !sidebarOpen;
  previewTab.disabled = !previewState.isOpen;

  await invoke("set_main_workspace_layout", {
    leftExtent: layout.leftExtent,
    rightExtent: layout.rightExtent,
  }).catch((err) => console.error("Failed to resize workspace:", err));
}

async function init() {
  await refreshConfig();
  applyI18n();

  clips = await invoke("get_clips");
  selectedIndex = 0;
  await loadFavoritesContext();
  render();

  await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    if (!focused) return;
    resyncPreviewState();
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
      clipList.scrollTop = 0;
    });
  });

  await listen<ClipboardUpdate>("clipboard-update", (event) => {
    const { clip, evicted } = event.payload;
    const existingIndex = clips.findIndex((c) => c.content_hash === clip.content_hash);
    if (existingIndex >= 0) {
      clips[existingIndex] = clip;
    } else {
      clips.unshift(clip);
    }
    if (evicted.length > 0) {
      clips = clips.filter((c) => !evicted.includes(c.id));
    }
    sortClips();
    render();
  });

  // Favorites data + selection sync across both windows.
  await listen<void>("favorites-updated", () => {
    void loadFavoritesContext();
  });
  await listen<FavoritesUiState>("favorites-ui-state-changed", () => {
    void loadFavoritesContext();
  });
  await listen<void>("main-panel-reset", () => {
    closeNoteModal();
    exitMultiSelect(false);
    hideActionMenu();
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
  const revision = ++sidebarStateRevision;
  try {
    const state = await invoke<FavoritesUiState>("toggle_favorites_sidebar");
    if (revision === sidebarStateRevision) {
      sidebarOpen = state.open;
      if (sidebarOpen) workspaceTab = "drawer";
      updateFavoritesToggleA11y();
    }
  } catch (err) {
    console.error("Failed to toggle drawer:", err);
  }
}

function onFavoritesShortcutKeydown(e: KeyboardEvent) {
  if (shortcutMatcher.keydown(e.code, e.repeat)) {
    e.preventDefault();
    e.stopPropagation();
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
  selectionAdd.textContent = t(selectedCollection === null ? "addToCollection" : "addToOtherCollection");
  selectionDestructive.textContent = t(selectedCollection === null ? "deleteTitle" : "removeFromCollection");
  const nothingSelected = multiSelect.size === 0;
  selectionAdd.disabled = nothingSelected;
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
  if (activeDragSource) {
    releaseDragSource(activeDragSource, activeDragSessionId !== null, "source-removed");
  }
  clipList.replaceChildren();

  const searching = query.length > 0;
  const filtering = activeFilter !== "all";
  const showEmpty = visibleClips.length === 0;
  const totalEmpty = source.length === 0;

  emptyState.classList.toggle("hidden", !showEmpty);
  if (showEmpty) {
    if (totalEmpty) {
      emptyTitle.textContent = selectedCollection === null ? t("emptyTitle") : t("favoritesEmptyTitle");
      emptyHint.classList.toggle("hidden", selectedCollection !== null);
      if (selectedCollection !== null) {
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
    const itemIndex = favoriteItems.findIndex((favorite) => favorite.id === item.id);
    const reorderEnabled = favoriteItemReorderEnabled();
    const moveUp = menuItem(t("moveUp"), () => void moveFavoriteItem(item.id, -1));
    moveUp.disabled = !reorderEnabled || itemIndex <= 0;
    actionMenu.appendChild(moveUp);
    const moveDown = menuItem(t("moveDown"), () => void moveFavoriteItem(item.id, 1));
    moveDown.disabled = !reorderEnabled || itemIndex < 0 || itemIndex >= favoriteItems.length - 1;
    actionMenu.appendChild(moveDown);
    actionMenu.appendChild(menuItem(t("removeFromCollection"), () => {
      const fav = item as FavoriteItem;
      invoke("remove_favorite", { collectionId: selectedCollection, itemId: fav.id })
        .then(() => {
          showToast(t("removedFromFavorites"));
          void loadFavoritesContext();
        })
        .catch((err) => showToast(localizeBackendError(String(err))));
    }, true));
    actionMenu.appendChild(menuItem(t("addToOtherCollection"), () => {
      hideActionMenu();
      openAddChooser(item);
    }));
  } else {
    actionMenu.appendChild(menuItem(t("addToCollection"), () => {
      hideActionMenu();
      openAddChooser(item);
    }));
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
  const collectionId = selectedCollection;
  if (!collectionId || !favoriteItemReorderEnabled()) return;
  const currentIds = favoriteItems.map((item) => item.id);
  const nextIds = moveOne(currentIds, currentIds.indexOf(itemId), delta);
  if (nextIds.every((id, index) => id === currentIds[index])) return;
  hideActionMenu();
  try {
    await invoke("reorder_favorite_items", { collectionId, ids: nextIds });
    await loadFavoritesContext();
  } catch (err) {
    showToast(localizeBackendError(String(err)));
    await loadFavoritesContext();
  }
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
    const isFavorite = target.scope === "favorite";
    const command = isFavorite ? "set_favorite_note" : "set_clip_note";
    const note = await invoke<string | null>(command, { id: target.id, note: noteInput.value });
    const items = isFavorite ? favoriteItems : clips;
    const item = items.find((candidate) => candidate.id === target.id);
    if (item) item.note = note;
    closeNoteModal();
    showToast(t("noteSaved"));
    if (previewState.currentId === target.id) {
      const previewCommand = isFavorite ? "show_favorite_preview" : "show_clip_preview";
      void invoke(previewCommand, { id: target.id }).catch((err) => {
        console.error("Failed to refresh preview note:", err);
      });
    }
  } catch (err) {
    noteSave.disabled = false;
    showToast(localizeBackendError(String(err)));
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
function openAddChooser(item: DisplayItem) {
  const token = chooserGate.open(item.id);
  const locator: ClipLocator = clipLocator(item);

  invoke<string[]>("favorite_collection_ids", { locator }).then((existing) => {
    if (!chooserGate.isCurrent(item.id, token)) return;
    renderAddChooser(locator, existing);
  }).catch(() => {});
}

function renderAddChooser(locator: ClipLocator, existing: string[]) {
  addMenu.replaceChildren();

  if (collections.length === 0) {
    const create = menuItem(t("createCollection"), () => {
      hideAddChooser();
      void invoke("set_favorites_open", { open: true }).then(() => emit("favorites-create-request"));
    });
    addMenu.appendChild(create);
  } else {
    collections.forEach((c) => {
      const member = existing.includes(c.id);
      const b = menuItem(`${c.name}${member ? ` · ${t("addedToFavorites")}` : ""}`, () => {
        hideAddChooser();
        invoke("add_favorite", { collectionId: c.id, locator })
          .then(() => { showToast(t("addedToFavorites")); void loadFavoritesContext(); })
          .catch((err) => showToast(localizeBackendError(String(err))));
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

  const targets = collections.filter((collection) => collection.id !== selectedCollection);
  if (collections.length === 0) {
    addMenu.appendChild(menuItem(t("createCollection"), () => {
      exitMultiSelect();
      void invoke("set_favorites_open", { open: true }).then(() => emit("favorites-create-request"));
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
        void invoke<BatchMutationResult>("add_favorites", {
          collectionId: collection.id,
          locators,
        }).then((result) => {
          exitMultiSelect();
          showToast(t("batchAdded", {
            changed: String(result.changed),
            unchanged: String(result.unchanged),
          }));
          void loadFavoritesContext();
        }).catch((err) => showToast(localizeBackendError(String(err))));
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

  if (selectedCollection === null) {
    const ids = items.map((item) => item.id);
    try {
      await invoke("delete_clips", { ids });
      const deleted = new Set(ids);
      clips = clips.filter((clip) => !deleted.has(clip.id));
      exitMultiSelect();
      showToast(t("batchDeleted", { n: String(ids.length) }), async () => {
        try {
          await invoke("undo_delete_batch", { ids });
          clips = await invoke("get_clips");
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

  const collectionId = selectedCollection;
  const itemIds = items.map((item) => item.id);
  try {
    const result = await invoke<BatchMutationResult>("remove_favorites", {
      collectionId,
      itemIds,
    });
    const removed = new Set(itemIds);
    favoriteItems = favoriteItems.filter((item) => !removed.has(item.id));
    exitMultiSelect();
    showToast(t("batchRemoved", { n: String(result.changed) }));
    void loadFavoritesContext();
  } catch (err) {
    showToast(localizeBackendError(String(err)));
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
  if (isFavoriteItem(item)) {
    try {
      await invoke<string>("paste_favorite", { id: item.id });
    } catch (err) {
      console.error("Paste failed:", err);
      showToast(t("pasteFailed"));
    }
    return;
  }
  await pasteClip(item as Clip);
}

async function pasteClip(clip: Clip) {
  try {
    switch (clip.kind) {
      case "Text":
        await invoke("paste_text", { text: clip.text_content || "" });
        break;
      case "FilePaths":
        if (pasteFilesAsFiles) {
          await invoke<string>("paste_files", { id: clip.id });
        } else {
          await invoke("paste_text", { text: clip.text_content || "" });
        }
        break;
      case "Image":
        await invoke("paste_image", { id: clip.id });
        break;
    }
  } catch (err) {
    console.error("Paste failed:", err);
    showToast(t("pasteFailed"));
  }
}

async function copyActive(item: DisplayItem) {
  if (isFavoriteItem(item)) {
    try {
      await invoke<string>("copy_favorite", { id: item.id });
      showToast(t("copied"));
    } catch (err) {
      console.error("Copy failed:", err);
      showToast(t("copyFailed"));
    }
    return;
  }
  await copyOnly(item as Clip);
}

async function copyOnly(clip: Clip) {
  try {
    let toastKey = "copied";
    switch (clip.kind) {
      case "Text":
        await invoke("copy_only_text", { text: clip.text_content || "" });
        break;
      case "FilePaths":
        if (pasteFilesAsFiles) {
          const outcome = await invoke<string>("copy_only_files", { id: clip.id });
          if (outcome === "text") toastKey = "filesMissingFallback";
        } else {
          await invoke("copy_only_text", { text: clip.text_content || "" });
        }
        break;
      case "Image":
        await invoke("copy_only_image", { id: clip.id });
        break;
    }
    showToast(t(toastKey));
  } catch (err) {
    console.error("Copy failed:", err);
    showToast(t("copyFailed"));
  }
}

async function deleteClip(clip: Clip) {
  const removeLocal = () => {
    clips = clips.filter((c) => c.id !== clip.id);
    render();
  };
  try {
    await invoke("delete_clip", { id: clip.id });
    removeLocal();
    showToast(t("deleted"), async () => {
      try {
        await invoke("undo_delete", { id: clip.id });
        clips = await invoke("get_clips");
        render();
      } catch (err) {
        showToast(localizeBackendError(String(err)));
      }
    });
  } catch (err) {
    if (String(err).includes("Clip not found")) {
      removeLocal();
    } else {
      console.error("Delete failed:", err);
    }
  }
}

async function togglePin(clip: Clip) {
  try {
    await invoke("set_pinned", { id: clip.id, pinned: !clip.pinned });
    clip.pinned = !clip.pinned;
    sortClips();
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
  workspaceTab = tabAfterPreviewIntent(workspaceTab, sidebarOpen);
  void applyWorkspaceLayout();
  const cmd = isFavoriteItem(item) ? "show_favorite_preview" : "show_clip_preview";
  invoke(cmd, { id: item.id })
    .then(() => {
      previewState.resolveShow(token, item.id);
      void applyWorkspaceLayout();
    })
    .catch((err) => {
      console.error("Failed to show preview:", err);
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
// History clips drag into a drawer collection. Drawer items keep that copy
// behavior when dropped over the sidebar, while a drop inside the unfiltered
// center list persists a new item order.
function stopItemReorderAutoScroll(): void {
  if (itemReorderScrollFrame !== null) cancelAnimationFrame(itemReorderScrollFrame);
  itemReorderScrollFrame = null;
}

function clearItemReorderFeedback(): void {
  stopItemReorderAutoScroll();
  activeItemReorderId = null;
  itemReorderBeforeId = null;
  itemReorderInsideList = false;
  itemReorderPointer = null;
  itemReorderIndicator.remove();
  clipList.classList.remove("reordering-items");
}

function itemReorderScrollVelocity(point: { x: number; y: number }): number {
  const rect = clipList.getBoundingClientRect();
  if (!rectContains(rect, point.x, point.y)) return 0;
  const edge = 40;
  if (point.y < rect.top + edge) {
    return -Math.max(3, Math.ceil((rect.top + edge - point.y) / 3));
  }
  if (point.y > rect.bottom - edge) {
    return Math.max(3, Math.ceil((point.y - (rect.bottom - edge)) / 3));
  }
  return 0;
}

function placeItemReorderIndicator(itemId: string, point: { x: number; y: number }): void {
  const listRect = clipList.getBoundingClientRect();
  itemReorderInsideList = rectContains(listRect, point.x, point.y);
  if (!itemReorderInsideList) {
    itemReorderBeforeId = null;
    itemReorderIndicator.remove();
    return;
  }

  const rows = [...clipList.querySelectorAll<HTMLElement>('.clip-item[data-is-favorite="1"]')];
  let beforeId: string | null = null;
  for (const candidate of rows) {
    if (candidate.dataset.clipId === itemId) continue;
    const rect = candidate.getBoundingClientRect();
    if (point.y < rect.top + rect.height / 2) {
      beforeId = candidate.dataset.clipId ?? null;
      break;
    }
  }
  itemReorderBeforeId = beforeId;
  const beforeRow = beforeId
    ? clipList.querySelector<HTMLElement>(`.clip-item[data-clip-id="${CSS.escape(beforeId)}"]`)
    : null;
  if (beforeRow) clipList.insertBefore(itemReorderIndicator, beforeRow);
  else clipList.appendChild(itemReorderIndicator);
}

function runItemReorderAutoScroll(): void {
  itemReorderScrollFrame = null;
  const itemId = activeItemReorderId;
  const point = itemReorderPointer;
  if (!itemId || !point) return;
  const velocity = itemReorderScrollVelocity(point);
  if (velocity === 0) return;
  const previous = clipList.scrollTop;
  clipList.scrollTop += velocity;
  placeItemReorderIndicator(itemId, point);
  if (clipList.scrollTop !== previous) {
    itemReorderScrollFrame = requestAnimationFrame(runItemReorderAutoScroll);
  }
}

function updateItemReorder(itemId: string, point: { x: number; y: number }): void {
  if (activeItemReorderId !== itemId) return;
  itemReorderPointer = point;
  placeItemReorderIndicator(itemId, point);
  const velocity = itemReorderScrollVelocity(point);
  if (velocity === 0) {
    stopItemReorderAutoScroll();
  } else if (itemReorderScrollFrame === null) {
    itemReorderScrollFrame = requestAnimationFrame(runItemReorderAutoScroll);
  }
}

function commitItemReorder(
  itemId: string,
  sessionId: number,
  point: { x: number; y: number },
): boolean {
  const collectionId = selectedCollection;
  if (!collectionId || activeItemReorderId !== itemId || !favoriteItemReorderEnabled()) return false;
  updateItemReorder(itemId, point);
  if (!itemReorderInsideList) return false;

  const currentIds = favoriteItems.map((item) => item.id);
  const nextIds = insertBefore(currentIds, itemId, itemReorderBeforeId);
  cancelInlineItemDrag(sessionId);
  finishInlineDragCard(false);
  clearItemReorderFeedback();
  if (nextIds.every((id, index) => id === currentIds[index])) return true;
  void invoke("reorder_favorite_items", { collectionId, ids: nextIds })
    .then(() => loadFavoritesContext())
    .catch(async (err) => {
      showToast(localizeBackendError(String(err)));
      await loadFavoritesContext();
    });
  return true;
}

function releaseDragSource(
  el: HTMLElement,
  cancel: boolean,
  reason: DrawerDragCancelReason = "explicit",
): void {
  let kind: "history" | "favorite" | null = null;
  if (activeDragSource === el) {
    kind = activeDragKind;
    activeDragSource = null;
    activeDragKind = null;
    if (cancel && activeDragSessionId !== null) {
      if (kind === "history") {
        cancelHistoryDrawerDrag(activeDragSessionId, reason);
      } else {
        cancelInlineItemDrag(activeDragSessionId);
        finishInlineDragCard(true);
      }
    }
    activeDragSessionId = null;
  }
  clearItemReorderFeedback();
  if (kind !== "history") el.classList.remove("dragging-source", "drag-held");
}

function attachRowDrag(row: HTMLElement, handle: HTMLElement, item: DisplayItem) {
  const drag = new DragController(6);
  const locator = clipLocator(item);
  const favorite = isFavoriteItem(item);
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    drag.beginImmediately(e.clientX, e.clientY);
    dragSessionSeq += 1;
    activeDragSessionId = dragSessionSeq;
    activeDragKind = favorite ? "favorite" : "history";
    activeDragSource = row;
    if (favorite && favoriteItemReorderEnabled()) {
      activeItemReorderId = item.id;
      clipList.classList.add("reordering-items");
      updateItemReorder(item.id, { x: e.clientX, y: e.clientY });
    }
    handle.setPointerCapture(e.pointerId);
    const point = { x: e.clientX, y: e.clientY };
    const payload: ItemDragPoint = { sessionId: activeDragSessionId, locator, x: point.x, y: point.y };
    const start = itemDragStartPayload(activeDragSessionId, item, point);
    if (favorite) {
      row.classList.add("dragging-source");
      beginInlineItemDrag(start);
      beginInlineDragCard(start);
      moveInlineItemDrag(payload);
    } else {
      startHistoryDrawerDrag({ ...start, source: row });
    }
  });
  handle.addEventListener("pointermove", (e) => {
    if (!drag.isDragging || activeDragSessionId === null) return;
    const p = { x: e.clientX, y: e.clientY };
    const payload: ItemDragPoint = { sessionId: activeDragSessionId, locator, x: p.x, y: p.y };
    if (favorite) {
      moveInlineItemDrag(payload);
      moveInlineDragCard(payload);
    } else {
      moveHistoryDrawerDrag(payload);
    }
    if (activeItemReorderId === item.id) updateItemReorder(item.id, p);
  });
  handle.addEventListener("pointerup", (e) => {
    if (drag.didDrag && activeDragSessionId !== null) {
      const p = { x: e.clientX, y: e.clientY };
      const payload: ItemDragPoint = { sessionId: activeDragSessionId, locator, x: p.x, y: p.y };
      const reordered = favorite
        && commitItemReorder(item.id, activeDragSessionId, p);
      if (!reordered) {
        if (favorite) {
          void endInlineItemDrag(payload);
          finishInlineDragCard(false);
        } else {
          void endHistoryDrawerDrag(payload);
        }
      }
    }
    releaseDragSource(row, false);
    drag.pointerUp();
  });
  handle.addEventListener("pointercancel", () => {
    const didDrag = drag.didDrag;
    releaseDragSource(row, didDrag, "pointercancel");
    drag.pointerUp();
  });
  handle.addEventListener("lostpointercapture", () => {
    const didDrag = drag.didDrag;
    releaseDragSource(row, didDrag, "lostpointercapture");
    drag.pointerUp();
  });
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
      if (activeDragSource) {
        releaseDragSource(activeDragSource, true, "explicit");
        return;
      }
      const removeModal = document.getElementById("remove-modal")!;
      const favoritesMenu = document.getElementById("favorites-more-menu")!;
      const transientOpen = multiSelect.active
        || !noteModal.classList.contains("hidden")
        || openMenuClipId !== null
        || chooserGate.isOpen
        || batchChooserOpen
        || !removeModal.classList.contains("hidden")
        || !favoritesMenu.classList.contains("hidden");
      const layer = escapeLayer(transientOpen, previewState.isOpen, sidebarOpen);
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
      if (layer === "modal-or-menu" && !removeModal.classList.contains("hidden")) {
        (document.getElementById("remove-modal-cancel") as HTMLButtonElement).click();
        return;
      }
      if (layer === "modal-or-menu") return;
      if (layer === "preview") {
        hidePreview();
        return;
      }
      if (layer === "drawer") {
        void invoke("set_favorites_open", { open: false });
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
  if (activeDragSource) releaseDragSource(activeDragSource, true, "window-blur");
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
window.addEventListener("DOMContentLoaded", init);
