// Inline Drawer pane: Collection list + History button, create/rename,
// reorder, destructive remove modal, and the item-drop target.

import { localizeDrawerError, t } from "./i18n";
import { computeMenuPlacement } from "./menu";
import { clipLocator } from "./drag";
import { rectContains } from "./geometry";
import { createDrawerDragLifecycle } from "./drawer-drag";
import type {
  DrawerCollectionMoveDirection,
  DrawerDragCancelReason,
  DrawerDragLifecycle,
  DrawerDragPoint,
  DrawerDragSession,
  DrawerDragTerminalOutcome,
} from "./drawer-drag";
import { createInlineDragCard } from "./drag-overlay";
import type { InlineDragCard } from "./drag-overlay";
import { createRenameController } from "./rename-commit";
import type { DrawerMutationOutcome, DrawerMutationWorkflow } from "./drawer-mutations";
import type { DrawerView } from "./drawer-view";
import type { DrawerViewCoordinator } from "./drawer-view-coordinator";
import type { Clip, CollectionSummary, FavoriteItem } from "./types";

type ProductionDrawerDragAdapter = Parameters<typeof createDrawerDragLifecycle<HTMLElement>>[0];
type DrawerDragTargetState = Parameters<ProductionDrawerDragAdapter["renderTargets"]>[0];
type DrawerDragReorderAdapter = NonNullable<ProductionDrawerDragAdapter["reorder"]>;
type DrawerCollectionReorderAdapter = NonNullable<ProductionDrawerDragAdapter["collectionReorder"]>;
type DrawerDragItemContext = Parameters<ProductionDrawerDragAdapter["lookupMembership"]>[0];

/** The workflow surface the drag adapter consumes; tests substitute a fake. */
export type DrawerMutations = Pick<
  DrawerMutationWorkflow,
  | "reorderItems"
  | "addToCollection"
  | "memberCollectionIds"
  | "createCollection"
  | "renameCollection"
  | "deleteCollection"
  | "reorderCollections"
>;

/** Reorder eligibility derived once from Panel state. The drag adapter
 * receives this as data instead of scraping the Panel's row attributes. */
export interface DrawerItemReorderSnapshot {
  readonly enabled: boolean;
  readonly collectionId: string | null;
  readonly orderedItemIds: readonly string[];
}

export interface PanelDrawerDependencies {
  mutations: DrawerMutations;
  itemReorderSnapshot(): DrawerItemReorderSnapshot;
}

interface DrawerItemMutationAdapterDependencies {
  mutations: DrawerMutations;
  itemReorderSnapshot(): DrawerItemReorderSnapshot;
  presentFailure(error: unknown): void;
  presentAdded(collectionId: string): void;
}

/** The production drag adapter's context, commit, and reporting callbacks,
 * wired to the workflow module so they are testable against fake invoke and
 * refresh handles without DOM. */
export interface DrawerItemMutationAdapter {
  reorder: Pick<DrawerDragReorderAdapter, "context" | "commit" | "showSuccess" | "showFailure">;
  lookupMembership(start: DrawerDragItemContext): Promise<readonly string[]>;
  commit(collectionId: string, start: DrawerDragItemContext): Promise<void>;
  showSuccess(collectionId: string): void;
  showFailure(error: unknown): void;
}

export function createDrawerItemMutationAdapter(
  dependencies: DrawerItemMutationAdapterDependencies,
): DrawerItemMutationAdapter {
  const { mutations, itemReorderSnapshot, presentFailure, presentAdded } = dependencies;
  // The lifecycle pairs commit with showSuccess sequentially; the outcome of
  // the last commit decides whether success presentation is due.
  let lastMembershipOutcome: DrawerMutationOutcome | null = null;

  return {
    reorder: {
      context: (start) => {
        if (start.locator.scope !== "drawer") return null;
        const snapshot = itemReorderSnapshot();
        if (!snapshot.enabled || snapshot.collectionId === null) return null;
        if (!snapshot.orderedItemIds.includes(start.locator.id)) return null;
        return {
          collectionId: snapshot.collectionId,
          itemId: start.locator.id,
          orderedItemIds: snapshot.orderedItemIds,
        };
      },
      // Success and committed-stale both end inside the workflow: the refresh
      // barrier has already been awaited when the commit resolves.
      commit: (collectionId, orderedItemIds) =>
        mutations.reorderItems({ collectionId, orderedItemIds }).then(raiseFailed),
      showSuccess: () => {},
      showFailure: presentFailure,
    },
    lookupMembership: (start) => mutations.memberCollectionIds(start.locator),
    commit: async (collectionId, start) => {
      const outcome = await mutations.addToCollection({
        collectionId,
        locator: start.locator,
      });
      lastMembershipOutcome = outcome;
      raiseFailed(outcome);
    },
    showSuccess: (collectionId) => {
      if (lastMembershipOutcome?.status !== "succeeded") return;
      lastMembershipOutcome = null;
      presentAdded(collectionId);
    },
    showFailure: presentFailure,
  };
}

function raiseFailed(outcome: DrawerMutationOutcome): void {
  if (outcome.status === "failed") throw outcome.error;
}

export interface PanelDrawerController {
  isAnyOverlayOpen(): boolean;
  closeOverlays(): boolean;
  start(item: Clip | FavoriteItem, source: HTMLElement, point: DrawerDragPoint): DrawerDragSession;
  move(session: DrawerDragSession, point: DrawerDragPoint): void;
  end(session: DrawerDragSession, point: DrawerDragPoint): Promise<DrawerDragTerminalOutcome | null>;
  cancel(reason: DrawerDragCancelReason, session?: DrawerDragSession): DrawerDragTerminalOutcome | null;
  requestCreate(): void;
}

export type DrawerViewController = Pick<
  DrawerViewCoordinator,
  "currentView" | "select"
>;

export interface PanelDrawerRenderer extends PanelDrawerController {
  render(view: DrawerView): void;
}

const SVG_NS = "http://www.w3.org/2000/svg";

let moreMenuFor: string | null = null;
let editingCreate = false;
let renameCtl: ReturnType<typeof createRenameController>;
let drawerDrag: DrawerDragLifecycle<HTMLElement>;
let drawerViewController: DrawerViewController;
let drawerMutations: DrawerMutations;
let listEl: HTMLElement;
let drawerItemList: HTMLElement;
let emptyEl: HTMLElement;
let createRow: HTMLElement;
let createInput: HTMLElement;
let addBtn: HTMLButtonElement;
let moreMenu: HTMLElement;
let toast: HTMLElement;
let removeModal: HTMLElement;
let removeModalBody: HTMLElement;
let removeCancel: HTMLButtonElement;
let removeConfirm: HTMLButtonElement;

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

function currentCollections(): readonly CollectionSummary[] {
  return drawerViewController.currentView?.collections ?? [];
}

function renderCurrentView(): void {
  const view = drawerViewController.currentView;
  if (view) render(view);
}

// === render ===
function render(view: DrawerView): void {
  listEl.replaceChildren();
  const collections = view.collections;
  const selected = view.selectedCollection;
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
  void drawerViewController.select(id);
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
  renderCurrentView();
  createInput.textContent = "";
  createInput.focus();
}

function commitCreate(value: string): void {
  if (!editingCreate) return;
  const name = value.trim();
  if (!name) { cancelCreate(); return; }
  void drawerMutations.createCollection(name)
    .then((outcome) => {
      if (outcome.status === "failed") {
        showToast(localizeDrawerError(String(outcome.error)));
        return;
      }
      editingCreate = false;
      renderCurrentView();
      if (outcome.status === "succeeded") showToast(t("collectionAdded"));
    });
}

function cancelCreate(): void {
  editingCreate = false;
  renderCurrentView();
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

  const collections = currentCollections();
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
  void drawerMutations.deleteCollection(id).then((outcome) => {
    if (outcome.status === "succeeded") showToast(t("collectionRemoved"));
    else if (outcome.status === "failed") showToast(localizeDrawerError(String(outcome.error)));
  });
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

function drawerItemRows(): HTMLElement[] {
  return [...drawerItemList.querySelectorAll<HTMLElement>(".clip-item[data-is-favorite='1']")];
}

function createProductionDrawerDrag(
  inlineDragCard: InlineDragCard,
  dependencies: PanelDrawerDependencies,
): DrawerDragLifecycle<HTMLElement> {
  const collectionReorderIndicator = document.createElement("div");
  collectionReorderIndicator.className = "drop-indicator";

  const itemReorderIndicator = document.createElement("div");
  itemReorderIndicator.className = "clip-reorder-indicator";
  itemReorderIndicator.setAttribute("aria-hidden", "true");

  const itemMutations = createDrawerItemMutationAdapter({
    mutations: dependencies.mutations,
    itemReorderSnapshot: dependencies.itemReorderSnapshot,
    presentFailure: (error) => showToast(localizeDrawerError(String(error))),
    presentAdded: (collectionId) => {
      showToast(t("addedToFavorites"));
      const row = listEl.querySelector<HTMLElement>(`.favorites-row[data-collection-id="${collectionId}"]`);
      if (row) {
        row.classList.add("drop-success");
        setTimeout(() => row.classList.remove("drop-success"), 600);
      }
    },
  });

  const drawerReorderAdapter: DrawerDragReorderAdapter = {
    ...itemMutations.reorder,
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
  };

  const collectionReorderAdapter: DrawerCollectionReorderAdapter = {
    context: (collectionId) => {
      const collections = currentCollections();
      return collections.some((collection) => collection.id === collectionId) ? {
        collectionId,
        orderedCollectionIds: collections.map((collection) => collection.id),
      }
        : null;
    },
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
    commit: (orderedCollectionIds) =>
      drawerMutations.reorderCollections(orderedCollectionIds).then(raiseFailed),
    showSuccess: () => {},
    showFailure: (error) => {
      showToast(localizeDrawerError(String(error)));
    },
  };

  return createDrawerDragLifecycle<HTMLElement>({
    reorder: drawerReorderAdapter,
    collectionReorder: collectionReorderAdapter,
    lookupMembership: itemMutations.lookupMembership,
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
    beginVisual: (start) => inlineDragCard.begin(start),
    moveVisual: (point) => inlineDragCard.move(point),
    finishVisual: (outcome, reason) => inlineDragCard.finish(
      reason !== "item-reorder" && (outcome === "cancelled" || outcome === "replaced"),
    ),
    clearTransientFeedback: clearDrawerFeedback,
    commit: itemMutations.commit,
    showUnavailable: (collectionId) => {
      const row = listEl.querySelector<HTMLElement>(`.favorites-row[data-collection-id="${collectionId}"]`);
      row?.classList.add("drop-invalid");
      setTimeout(() => row?.classList.remove("drop-invalid"), 450);
      showToast(t("alreadyInDrawer"));
    },
    showSuccess: itemMutations.showSuccess,
    showFailure: itemMutations.showFailure,
  });
}

function createPanelDrawerController(): PanelDrawerRenderer {
  return {
    isAnyOverlayOpen(): boolean {
      return moreMenuFor !== null
        || !removeModal.classList.contains("hidden")
        || drawerDrag.isActive();
    },
    closeOverlays(): boolean {
      if (moreMenuFor !== null) {
        moreMenuFor = null;
        updateMoreMenu();
        return true;
      }
      if (!removeModal.classList.contains("hidden")) {
        closeRemoveModal();
        return true;
      }
      return drawerDrag.cancel("explicit") !== null;
    },
    render(view: DrawerView): void {
      render(view);
    },
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
    requestCreate(): void {
      startCreate();
    },
  };
}

export function mountDrawerRenderer(
  controller: DrawerViewController,
  dependencies: PanelDrawerDependencies,
): PanelDrawerRenderer {
  drawerViewController = controller;
  drawerMutations = dependencies.mutations;
  listEl = document.getElementById("favorites-list")!;
  drawerItemList = document.getElementById("clip-list")!;
  emptyEl = document.getElementById("favorites-empty")!;
  createRow = document.getElementById("favorites-create-row")!;
  createInput = document.getElementById("favorites-create-input") as HTMLElement;
  addBtn = document.getElementById("favorites-add") as HTMLButtonElement;
  moreMenu = document.getElementById("favorites-more-menu")!;
  toast = document.getElementById("favorites-toast")!;
  removeModal = document.getElementById("remove-modal")!;
  removeModalBody = document.getElementById("remove-modal-body")!;
  removeCancel = document.getElementById("remove-modal-cancel") as HTMLButtonElement;
  removeConfirm = document.getElementById("remove-modal-confirm") as HTMLButtonElement;

  // Rename editing and drag adapters are DOM-bound and therefore belong to
  // the explicit Panel mount instead of module evaluation.
  renameCtl = createRenameController({
    rename: async (id, name) => {
      const outcome = await drawerMutations.renameCollection(id, name);
      if (outcome.status === "committed-stale") renderCurrentView();
      raiseFailed(outcome);
    },
    render: renderCurrentView,
    showError: (message) => showToast(localizeDrawerError(message)),
  });
  const inlineDragCard = createInlineDragCard(document.getElementById("drag-overlay-card")!);
  drawerDrag = createProductionDrawerDrag(inlineDragCard, dependencies);

  addBtn.addEventListener("click", () => { moreMenuFor = null; updateMoreMenu(); if (editingCreate) cancelCreate(); else startCreate(); });
  wireNameEditor(createInput, {
    onCommit: (v) => commitCreate(v),
    onCancel: () => cancelCreate(),
  });

  removeCancel.addEventListener("click", closeRemoveModal);
  removeConfirm.addEventListener("click", confirmRemove);
  removeModal.addEventListener("keydown", (e) => {
    if (e.key === "Tab") trapFocus(e);
  });
  document.addEventListener("click", () => { if (moreMenuFor) { moreMenuFor = null; updateMoreMenu(); } });

  return createPanelDrawerController();
}

function trapFocus(e: KeyboardEvent): void {
  const focusables = [removeCancel, removeConfirm].filter((b) => !b.disabled);
  if (focusables.length < 2) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
