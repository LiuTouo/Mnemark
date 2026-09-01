// Inline favorites pane: collection list + History button, create/rename,
// reorder, destructive remove modal, and the item-drop target.

import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { applyI18n, localizeBackendError, setLanguage, t } from "./i18n";
import { applyTheme } from "./theme";
import { computeMenuPlacement } from "./menu";
import { clipLocator } from "./drag";
import { rectContains } from "./geometry";
import { createDrawerDragLifecycle } from "./drawer-drag";
import type {
  DrawerCollectionMoveDirection,
  DrawerDragCancelReason,
  DrawerDragPoint,
  DrawerDragSession,
  DrawerDragTerminalOutcome,
} from "./drawer-drag";
import { beginInlineDragCard, finishInlineDragCard, moveInlineDragCard } from "./drag-overlay";
import { createRenameController } from "./rename-commit";
import type { Clip, CollectionSummary, FavoriteItem, FavoritesUiState } from "./types";

type ProductionDrawerDragAdapter = Parameters<typeof createDrawerDragLifecycle<HTMLElement>>[0];
type DrawerDragTargetState = Parameters<ProductionDrawerDragAdapter["renderTargets"]>[0];
type DrawerDragReorderAdapter = NonNullable<ProductionDrawerDragAdapter["reorder"]>;
type DrawerCollectionReorderAdapter = NonNullable<ProductionDrawerDragAdapter["collectionReorder"]>;

interface AppConfig {
  language?: string;
  theme?: string;
  ui_opacity_percent?: number;
}

const SVG_NS = "http://www.w3.org/2000/svg";

let collections: CollectionSummary[] = [];
let selected: string | null = null;
let moreMenuFor: string | null = null;
let editingCreate = false;
// Rename-editing flow lives in rename-commit.ts so the rejection path
// (exit editing + re-render authoritative state) is unit-tested.
const renameCtl = createRenameController({
  rename: (id, name) => invoke("rename_collection", { id, name }),
  reload: () => loadCollections(),
  render: () => render(),
  showError: (message) => showToast(message),
});
const listEl = document.getElementById("favorites-list")!;
const drawerItemList = document.getElementById("clip-list")!;
const emptyEl = document.getElementById("favorites-empty")!;
const createRow = document.getElementById("favorites-create-row")!;
const createInput = document.getElementById("favorites-create-input") as HTMLElement;
const addBtn = document.getElementById("favorites-add") as HTMLButtonElement;
const moreMenu = document.getElementById("favorites-more-menu")!;
const toast = document.getElementById("favorites-toast")!;
const removeModal = document.getElementById("remove-modal")!;
const removeModalBody = document.getElementById("remove-modal-body")!;
const removeCancel = document.getElementById("remove-modal-cancel") as HTMLButtonElement;
const removeConfirm = document.getElementById("remove-modal-confirm") as HTMLButtonElement;

// === small DOM helpers ===
function svgEl(name: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS(SVG_NS, name);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function icon(d: string, size = 15): SVGElement {
  const s = svgEl("svg", {
    width: String(size),
    height: String(size),
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
  });
  const path = svgEl("path", { d });
  s.append(path);
  return s;
}

const DRAG_HANDLE_D =
  "M8 5a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm0 6a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm0 6a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm8-12a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm0 6a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm0 6a1 1 0 1 0 0 2 1 1 0 0 0 0-2z";
const MORE_D = "M5 12a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z";

// === init ===
async function refreshConfig(): Promise<void> {
  const config = await invoke<AppConfig>("get_config");
  setLanguage(config.language || "zh-TW");
  applyTheme(config.theme || "system");
  const opacity = Math.min(100, Math.max(50, config.ui_opacity_percent ?? 99));
  document.documentElement.style.setProperty("--panel-opacity", String(opacity / 100));
}

async function loadCollections(): Promise<void> {
  collections = await invoke<CollectionSummary[]>("list_collections");
  render();
}

async function loadUiState(): Promise<void> {
  const s = await invoke<FavoritesUiState>("get_favorites_ui_state");
  selected = s.selected_collection;
  render();
}

// === render ===
function render(): void {
  drawerDrag.cancel("source-removed");
  listEl.replaceChildren();
  const hasCollections = collections.length > 0;
  emptyEl.classList.toggle("hidden", hasCollections);

  // History is navigation, not another drawer. Show a contextual return row
  // only while a drawer dataset is active, keeping it visually separate from
  // sortable/drop-target collection rows.
  if (selected !== null) {
    const activeCollection = collections.find((c) => c.id === selected);
    const historyBtn = document.createElement("button");
    historyBtn.className = "favorites-history-return";
    historyBtn.setAttribute("aria-label", t("returnToHistory"));
    historyBtn.append(icon("M15 18l-6-6 6-6"));
    const historyCopy = document.createElement("span");
    historyCopy.className = "favorites-history-copy";
    const historyLabel = document.createElement("span");
    historyLabel.className = "favorites-history-label";
    historyLabel.textContent = t("returnToHistory");
    const historyContext = document.createElement("span");
    historyContext.className = "favorites-history-context";
    historyContext.textContent = t("currentlyViewing", { name: activeCollection?.name ?? "" });
    historyCopy.append(historyLabel, historyContext);
    historyBtn.append(historyCopy);
    historyBtn.addEventListener("click", () => selectCollection(null));
    listEl.append(historyBtn);
  }

  collections.forEach((c) => {
    const row = document.createElement("div");
    row.className = `favorites-row${selected === c.id ? " selected" : ""}`;
    row.dataset.collectionId = c.id;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(selected === c.id));

    const handle = document.createElement("button");
    handle.className = "favorites-drag-handle";
    handle.setAttribute("aria-label", t("dragHandleLabel"));
    handle.title = t("dragHandleLabel");
    handle.append(icon(DRAG_HANDLE_D, 14));
    attachReorderDrag(handle, c.id);

    const name = document.createElement("span");
    name.className = "favorites-row-name";
    name.textContent = c.name;
    name.title = c.name;
    if (renameCtl.editingId === c.id) {
      const editor = makeNameEditor({
        value: c.name,
        className: "favorites-rename-input",
        label: t("collectionNamePlaceholder"),
        onCommit: (v) => renameCtl.commit(c.id, v),
        onCancel: () => renameCtl.cancel(),
      });
      row.append(handle, editor);
      editor.focus();
      selectAllContents(editor);
    } else {
      name.addEventListener("dblclick", () => renameCtl.begin(c.id));
      row.append(handle, name);
    }

    const count = document.createElement("span");
    count.className = "favorites-row-count";
    count.textContent = String(c.item_count);
    row.append(count);

    const dropLabel = document.createElement("span");
    dropLabel.className = "favorites-row-drop-label";
    dropLabel.setAttribute("aria-hidden", "true");
    row.append(dropLabel);

    const more = document.createElement("button");
    more.className = "clip-action-btn more-btn favorites-more-btn";
    more.title = t("moreTitle");
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", String(moreMenuFor === c.id));
    more.append(icon(MORE_D, 15));
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMoreMenu(c.id, more);
    });
    row.append(more);

    row.addEventListener("click", () => {
      if (renameCtl.editingId !== c.id) selectCollection(c.id);
    });

    listEl.append(row);
  });

  createRow.classList.toggle("hidden", !editingCreate);
  updateMoreMenu();
}

function selectCollection(id: string | null): void {
  invoke("set_favorites_selected", { collectionId: id }).catch(() => {});
}

// === name editor ===
// A single-line plaintext contenteditable, shared by create and rename so both
// avoid native input/form semantics (no autofill or saved-info UI in the
// WebView). Enter commits, Escape cancels, blur commits (guarded by caller
// state), and paste is flattened to plaintext with no newlines.
function wireNameEditor(
  el: HTMLElement,
  opts: { onCommit: (value: string) => void; onCancel: () => void },
): HTMLElement {
  el.setAttribute("role", "textbox");
  el.setAttribute("contenteditable", "plaintext-only");
  el.spellcheck = false;

  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      opts.onCommit(el.textContent ?? "");
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      opts.onCancel();
    } else {
      e.stopPropagation();
    }
  });

  el.addEventListener("beforeinput", (e) => {
    const ie = e as InputEvent;
    if (ie.inputType === "insertParagraph" || ie.inputType === "insertLineBreak") {
      e.preventDefault();
      return;
    }
    if (ie.inputType === "insertFromPaste") {
      const text = ie.dataTransfer?.getData("text/plain");
      if (text != null) {
        e.preventDefault();
        document.execCommand("insertText", false, text.replace(/[\r\n]+/g, " "));
      }
    }
  });

  el.addEventListener("blur", () => opts.onCommit(el.textContent ?? ""));

  return el;
}

function makeNameEditor(opts: {
  value: string;
  className: string;
  label: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}): HTMLElement {
  const el = document.createElement("div");
  el.className = opts.className;
  el.setAttribute("aria-label", opts.label);
  el.textContent = opts.value;
  return wireNameEditor(el, opts);
}

function selectAllContents(el: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

// === create ===
function startCreate(): void {
  editingCreate = true;
  render();
  createInput.textContent = "";
  createInput.focus();
}

function commitCreate(value: string): void {
  if (!editingCreate) return;
  const name = value.trim();
  if (!name) { cancelCreate(); return; }
  invoke<CollectionSummary>("create_collection", { name })
    .then(() => {
      editingCreate = false;
      showToast(t("collectionAdded"));
      return loadCollections();
    })
    .catch((err) => showToast(String(err)));
}

function cancelCreate(): void {
  editingCreate = false;
  render();
}

// === more menu ===
function toggleMoreMenu(id: string, anchor: HTMLElement): void {
  moreMenuFor = moreMenuFor === id ? null : id;
  updateMoreMenu();
  if (moreMenuFor) {
    const rect = anchor.getBoundingClientRect();
    const panelRect = document.getElementById("favorites-panel")!.getBoundingClientRect();
    placeMoreMenu(rect, panelRect);
  }
}

// Same boundary-safe placement as the history More menu: prefer below, flip
// above when that side has more room, constrain height (scroll) when neither
// side fits. `updateMoreMenu` has already populated the items, so the natural
// size is measurable here.
function placeMoreMenu(rect: DOMRect, panelRect: DOMRect): void {
  moreMenu.style.maxHeight = "";
  moreMenu.style.maxWidth = "";
  const p = computeMenuPlacement(
    { top: rect.top - panelRect.top, bottom: rect.bottom - panelRect.top },
    { width: panelRect.width, height: panelRect.height },
    moreMenu.offsetWidth,
    moreMenu.offsetHeight,
    panelRect.right - rect.right,
  );
  moreMenu.style.top = `${p.top}px`;
  moreMenu.style.right = `${p.right}px`;
  moreMenu.style.maxHeight = p.maxHeight === null ? "" : `${p.maxHeight}px`;
  moreMenu.style.maxWidth = p.maxWidth === null ? "" : `${p.maxWidth}px`;
}

function updateMoreMenu(): void {
  moreMenu.replaceChildren();
  const id = moreMenuFor;
  if (!id) { moreMenu.classList.add("hidden"); return; }
  moreMenu.classList.remove("hidden");

  const col = collections.find((c) => c.id === id);
  if (!col) { moreMenu.classList.add("hidden"); return; }
  const index = collections.findIndex((c) => c.id === id);

  const rename = menuItem(t("renameCollection"), () => { moreMenuFor = null; renameCtl.begin(id); });
  const up = menuItem(t("moveUp"), () => moveCollection(id, -1), index === 0);
  const down = menuItem(t("moveDown"), () => moveCollection(id, 1), index === collections.length - 1);
  const remove = menuItem(t("remove"), () => openRemoveModal(col), false, true);

  moreMenu.append(rename, up, down, remove);
}

function menuItem(label: string, onClick: () => void, disabled = false, danger = false): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = `menu-item${danger ? " menu-item-delete" : ""}`;
  b.setAttribute("role", "menuitem");
  b.textContent = label;
  b.disabled = disabled;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    moreMenuFor = null;
    updateMoreMenu();
    onClick();
  });
  return b;
}

async function moveCollection(
  id: string,
  direction: DrawerCollectionMoveDirection,
): Promise<void> {
  const session = drawerDrag.start({
    kind: "collection-move",
    collectionId: id,
    direction,
  });
  await drawerDrag.end(session);
}

// === remove modal ===
let removeTargetId: string | null = null;
let restoreFocus: HTMLElement | null = null;

function openRemoveModal(col: CollectionSummary): void {
  removeTargetId = col.id;
  removeModalBody.textContent = t("removeCollectionBody", { name: col.name, count: String(col.item_count) });
  restoreFocus = document.activeElement as HTMLElement | null;
  removeModal.classList.remove("hidden");
  removeCancel.focus();
}

function closeRemoveModal(): void {
  removeModal.classList.add("hidden");
  removeTargetId = null;
  restoreFocus?.focus();
  restoreFocus = null;
}

function confirmRemove(): void {
  if (!removeTargetId) return;
  const id = removeTargetId;
  closeRemoveModal();
  invoke("delete_collection", { id })
    .then(() => { showToast(t("collectionRemoved")); return loadCollections(); })
    .catch((err) => showToast(String(err)));
}

// === toast ===
let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(message: string): void {
  if (toastTimer) clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.remove("hidden");
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 2500);
}

// === collection reorder drag ===
function attachReorderDrag(handle: HTMLElement, id: string): void {
  let session: DrawerDragSession | null = null;
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    session = drawerDrag.start({
      kind: "collection",
      collectionId: id,
      x: e.clientX,
      y: e.clientY,
      source: handle.closest<HTMLElement>(".favorites-row") ?? handle,
    });
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener("pointermove", (e) => {
    if (session === null) return;
    drawerDrag.move(session, { x: e.clientX, y: e.clientY });
  });
  handle.addEventListener("pointerup", (e) => {
    if (session === null) return;
    const ending = session;
    session = null;
    void drawerDrag.end(ending, { x: e.clientX, y: e.clientY });
  });
  const cancel = (reason: DrawerDragCancelReason) => {
    if (session === null) return;
    const cancelled = session;
    session = null;
    drawerDrag.cancel(reason, cancelled);
  };
  handle.addEventListener("pointercancel", () => cancel("pointercancel"));
  handle.addEventListener("lostpointercapture", () => cancel("lostpointercapture"));
}

// === inline item drop target ===
function screenRect(el: HTMLElement): { left: number; top: number; right: number; bottom: number } {
  const r = el.getBoundingClientRect();
  return {
    left: r.left,
    top: r.top,
    right: r.right,
    bottom: r.bottom,
  };
}

function collectionUnderPoint(x: number, y: number): string | null {
  const rows = [...listEl.querySelectorAll<HTMLElement>(".favorites-row[data-collection-id]")];
  for (const row of rows) {
    const rect = screenRect(row);
    if (rectContains(rect, x, y)) {
      return row.dataset.collectionId ?? null;
    }
  }
  return null;
}

function clearDropFeedback(): void {
  document.body.classList.remove("item-drag-active");
  listEl.querySelectorAll(".favorites-row.drop-target, .favorites-row.drop-available, .favorites-row.drop-unavailable").forEach((row) => {
    row.classList.remove("drop-target", "drop-available", "drop-unavailable");
  });
  listEl.querySelector(".favorites-history-return")?.classList.remove("drag-disabled");
}

function clearDrawerFeedback(): void {
  clearDropFeedback();
  listEl.querySelectorAll<HTMLElement>(".favorites-row[data-collection-id]").forEach((row) => {
    row.setAttribute("aria-disabled", "false");
    const label = row.querySelector<HTMLElement>(".favorites-row-drop-label");
    if (label) label.textContent = t("dropHere");
  });
}

function renderDrawerTargets(state: DrawerDragTargetState): void {
  document.body.classList.toggle("item-drag-active", state.active);
  listEl.querySelector(".favorites-history-return")?.classList.toggle("drag-disabled", state.active);
  listEl.querySelectorAll<HTMLElement>(".favorites-row[data-collection-id]").forEach((row) => {
    const id = row.dataset.collectionId!;
    const unavailable = state.active
      && state.membershipReady
      && state.membershipIds.includes(id);
    row.classList.toggle("drop-available", state.active && !unavailable);
    row.classList.toggle("drop-unavailable", unavailable);
    row.classList.toggle("drop-target", state.active && state.targetId === id);
    row.setAttribute("aria-disabled", String(unavailable));
    const label = row.querySelector<HTMLElement>(".favorites-row-drop-label");
    if (label) label.textContent = unavailable ? t("alreadyInDrawer") : t("dropHere");
  });
}

const collectionReorderIndicator = document.createElement("div");
collectionReorderIndicator.className = "drop-indicator";

const itemReorderIndicator = document.createElement("div");
itemReorderIndicator.className = "clip-reorder-indicator";
itemReorderIndicator.setAttribute("aria-hidden", "true");

function drawerItemRows(): HTMLElement[] {
  return [...drawerItemList.querySelectorAll<HTMLElement>(".clip-item[data-is-favorite='1']")];
}

function selectedDrawerCollectionId(): string | null {
  return listEl.querySelector<HTMLElement>(".favorites-row.selected[data-collection-id]")
    ?.dataset.collectionId ?? null;
}

async function restoreAuthoritativeItemOrder(collectionId: string): Promise<void> {
  const items = await invoke<FavoriteItem[]>("list_favorite_items", { collectionId });
  if (selectedDrawerCollectionId() !== collectionId) return;
  const rows = new Map(drawerItemRows().map((row) => [row.dataset.clipId ?? "", row]));
  for (const item of items) {
    const row = rows.get(item.id);
    if (row) drawerItemList.append(row);
  }
}

const drawerReorderAdapter: DrawerDragReorderAdapter = {
  context: (start) => {
    const collectionId = selectedDrawerCollectionId();
    const filter = document.querySelector<HTMLElement>(".filter-btn.active")?.dataset.filter;
    const selectionActive = document.getElementById("selection-toggle")?.classList.contains("active") ?? false;
    const orderedItemIds = drawerItemRows()
      .map((row) => row.dataset.clipId ?? "")
      .filter((id) => id.length > 0);
    if (start.locator.scope !== "favorite"
      || !collectionId
      || (document.getElementById("search-input") as HTMLInputElement).value.length > 0
      || filter !== "all"
      || selectionActive
      || !orderedItemIds.includes(start.locator.id)) return null;
    return {
      collectionId,
      itemId: start.locator.id,
      orderedItemIds,
    };
  },
  measure: () => ({
    list: drawerItemList.getBoundingClientRect(),
    items: drawerItemRows()
      .map((row) => ({
        id: row.dataset.clipId ?? "",
        rect: row.getBoundingClientRect(),
      }))
      .filter((item) => item.id.length > 0),
  }),
  render: (state) => {
    drawerItemList.classList.toggle("reordering-items", state.active);
    itemReorderIndicator.remove();
    if (!state.active || !state.inside) return;
    const beforeRow = state.beforeId === null
      ? null
      : drawerItemRows().find((row) => row.dataset.clipId === state.beforeId) ?? null;
    if (beforeRow) drawerItemList.insertBefore(itemReorderIndicator, beforeRow);
    else drawerItemList.appendChild(itemReorderIndicator);
  },
  scrollBy: (amount) => {
    const previous = drawerItemList.scrollTop;
    drawerItemList.scrollTop += amount;
    return drawerItemList.scrollTop !== previous;
  },
  commit: (collectionId, orderedItemIds) => invoke("reorder_favorite_items", {
    collectionId,
    ids: orderedItemIds,
  }),
  showSuccess: restoreAuthoritativeItemOrder,
  showFailure: async (error) => {
    showToast(localizeBackendError(String(error)));
    const collectionId = selectedDrawerCollectionId();
    if (collectionId) await restoreAuthoritativeItemOrder(collectionId);
  },
};

const collectionReorderAdapter: DrawerCollectionReorderAdapter = {
  context: (collectionId) => collections.some((collection) => collection.id === collectionId)
    ? {
      collectionId,
      orderedCollectionIds: collections.map((collection) => collection.id),
    }
    : null,
  measure: () => ({
    list: screenRect(listEl),
    items: [...listEl.querySelectorAll<HTMLElement>(".favorites-row[data-collection-id]")]
      .map((row) => ({
        id: row.dataset.collectionId ?? "",
        rect: screenRect(row),
      }))
      .filter((collection) => collection.id.length > 0),
  }),
  render: (state) => {
    listEl.classList.toggle("reordering", state.active);
    collectionReorderIndicator.remove();
    if (!state.active || !state.inside) return;
    const beforeRow = state.beforeId === null
      ? null
      : listEl.querySelector<HTMLElement>(`.favorites-row[data-collection-id="${state.beforeId}"]`);
    if (beforeRow) beforeRow.before(collectionReorderIndicator);
    else listEl.append(collectionReorderIndicator);
  },
  commit: (orderedCollectionIds) => invoke("reorder_collections", {
    ids: orderedCollectionIds,
  }),
  showSuccess: async () => {
    await loadCollections();
  },
  showFailure: async (error) => {
    showToast(String(error));
    await loadCollections();
  },
};

const drawerDrag = createDrawerDragLifecycle<HTMLElement>({
  reorder: drawerReorderAdapter,
  collectionReorder: collectionReorderAdapter,
  lookupMembership: (start) => invoke<string[]>("favorite_collection_ids", { locator: start.locator }),
  collectionAt: (point) => collectionUnderPoint(point.x, point.y),
  renderTargets: renderDrawerTargets,
  activateSource: (source) => source.classList.add("dragging-source"),
  releaseSource: (source) => source.classList.remove("dragging-source", "drag-held"),
  suppressClick: (source) => {
    source.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    }, { capture: true, once: true });
  },
  beginVisual: beginInlineDragCard,
  moveVisual: moveInlineDragCard,
  finishVisual: (outcome, reason) => finishInlineDragCard(
    reason !== "item-reorder" && (outcome === "cancelled" || outcome === "replaced"),
  ),
  clearTransientFeedback: clearDrawerFeedback,
  commit: (collectionId, start) => invoke("add_favorite", {
    collectionId,
    locator: start.locator,
  }),
  showUnavailable: (collectionId) => {
    const row = listEl.querySelector<HTMLElement>(`.favorites-row[data-collection-id="${collectionId}"]`);
    row?.classList.add("drop-invalid");
    setTimeout(() => row?.classList.remove("drop-invalid"), 450);
    showToast(t("alreadyInDrawer"));
  },
  showSuccess: async (collectionId) => {
    showToast(t("addedToFavorites"));
    await loadCollections();
    const row = listEl.querySelector<HTMLElement>(`.favorites-row[data-collection-id="${collectionId}"]`);
    if (row) {
      row.classList.add("drop-success");
      setTimeout(() => row.classList.remove("drop-success"), 600);
    }
  },
  showFailure: async (error) => {
    showToast(localizeBackendError(String(error)));
    await loadCollections();
  },
});

export const panelDrawerDrag = {
  start(
    item: Clip | FavoriteItem,
    source: HTMLElement,
    point: DrawerDragPoint,
  ): DrawerDragSession {
    return drawerDrag.start({
      kind: "item",
      locator: clipLocator(item),
      visual: {
        kind: item.kind,
        preview: item.preview,
        thumbnailBase64: item.kind === "Image" ? item.thumbnail_base64 : null,
      },
      source,
      ...point,
    });
  },
  move(session: DrawerDragSession, point: DrawerDragPoint): void {
    drawerDrag.move(session, point);
  },
  end(
    session: DrawerDragSession,
    point: DrawerDragPoint,
  ): Promise<DrawerDragTerminalOutcome | null> {
    return drawerDrag.end(session, point);
  },
  cancel(
    reason: DrawerDragCancelReason,
    session?: DrawerDragSession,
  ): DrawerDragTerminalOutcome | null {
    return drawerDrag.cancel(reason, session);
  },
};

// === init ===
async function init(): Promise<void> {
  try {
    await refreshConfig();
  } catch {
    setLanguage("zh-TW");
  }
  applyI18n();
  await Promise.all([loadCollections(), loadUiState()]);

  addBtn.addEventListener("click", () => { moreMenuFor = null; updateMoreMenu(); if (editingCreate) cancelCreate(); else startCreate(); });
  wireNameEditor(createInput, {
    onCommit: (v) => commitCreate(v),
    onCancel: () => cancelCreate(),
  });

  removeCancel.addEventListener("click", closeRemoveModal);
  removeConfirm.addEventListener("click", confirmRemove);
  removeModal.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeRemoveModal(); }
    else if (e.key === "Tab") trapFocus(e);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drawerDrag.cancel("explicit") !== null) {
      return;
    } else if (e.key === "Escape" && moreMenuFor) {
      moreMenuFor = null;
      updateMoreMenu();
    }
  });
  document.addEventListener("click", () => { if (moreMenuFor) { moreMenuFor = null; updateMoreMenu(); } });

  await listen<void>("favorites-updated", () => { void loadCollections(); });
  await listen<FavoritesUiState>("favorites-ui-state-changed", (e) => {
    selected = e.payload.selected_collection;
    render();
  });
  // The main panel asks us to enter create mode when it has no collections.
  await listen("favorites-create-request", () => startCreate());

  window.addEventListener("focus", () => {
    refreshConfig()
      .then(() => {
        applyI18n();
        render();
      })
      .catch(() => {});
  });
  window.addEventListener("blur", () => {
    drawerDrag.cancel("window-blur");
  });
}

function trapFocus(e: KeyboardEvent): void {
  const focusables = [removeCancel, removeConfirm].filter((b) => !b.disabled);
  if (focusables.length < 2) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

window.addEventListener("DOMContentLoaded", () => { void init(); });
