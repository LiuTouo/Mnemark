import { insertBefore } from "./reorder";
import { rectContains } from "./geometry";
import type { Clip, ClipLocator } from "./types";

export type DrawerDragTerminalOutcome =
  | "success"
  | "unavailable"
  | "no-op"
  | "cancelled"
  | "failed"
  | "replaced";

export type DrawerDragCancelReason =
  | "pointercancel"
  | "lostpointercapture"
  | "window-blur"
  | "explicit"
  | "source-removed";

const drawerDragSessionBrand: unique symbol = Symbol("drawer-drag-session");
export interface DrawerDragSession {
  readonly [drawerDragSessionBrand]: true;
}

export interface DrawerDragPoint {
  x: number;
  y: number;
}

export interface DrawerDragVisual {
  kind: Clip["kind"];
  preview: string;
  thumbnailBase64: string | null;
}

export interface DrawerDragStart<Source> {
  kind: "item";
  locator: ClipLocator;
  visual: DrawerDragVisual;
  x: number;
  y: number;
  source: Source;
}

export interface DrawerCollectionDragStart<Source> {
  kind: "collection";
  collectionId: string;
  x: number;
  y: number;
  source: Source;
}

export interface DrawerCollectionMoveStart {
  kind: "collection-move";
  collectionId: string;
  direction: DrawerCollectionMoveDirection;
}

interface DrawerDragItemContext {
  locator: ClipLocator;
  visual: DrawerDragVisual;
  x: number;
  y: number;
}

interface DrawerDragItemPoint {
  locator: ClipLocator;
  x: number;
  y: number;
}

export type DrawerDragStartFact<Source> =
  | DrawerDragStart<Source>
  | DrawerCollectionDragStart<Source>
  | DrawerCollectionMoveStart;

interface DrawerDragTargetState {
  active: boolean;
  membershipReady: boolean;
  membershipIds: readonly string[];
  targetId: string | null;
}

interface DrawerDragRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface DrawerDragReorderContext {
  collectionId: string;
  itemId: string;
  orderedItemIds: readonly string[];
}

interface DrawerDragReorderGeometry {
  list: DrawerDragRect;
  items: ReadonlyArray<{ id: string; rect: DrawerDragRect }>;
}

interface DrawerDragReorderState {
  active: boolean;
  inside: boolean;
  beforeId: string | null;
}

interface DrawerDragReorderAdapter {
  context(start: DrawerDragItemContext): DrawerDragReorderContext | null;
  measure(): DrawerDragReorderGeometry;
  render(state: DrawerDragReorderState): void;
  scrollBy(amount: number): boolean;
  commit(collectionId: string, orderedItemIds: readonly string[]): Promise<void>;
  showSuccess(collectionId: string): Promise<void> | void;
  showFailure(error: unknown): Promise<void> | void;
}

interface DrawerCollectionReorderContext {
  collectionId: string;
  orderedCollectionIds: readonly string[];
}

interface DrawerCollectionReorderAdapter {
  context(collectionId: string): DrawerCollectionReorderContext | null;
  measure(): DrawerDragReorderGeometry;
  render(state: DrawerDragReorderState): void;
  commit(orderedCollectionIds: readonly string[]): Promise<void>;
  showSuccess(collectionId: string): Promise<void> | void;
  showFailure(error: unknown): Promise<void> | void;
}

export type DrawerCollectionMoveDirection = -1 | 1;

interface DrawerDragAdapter<Source> {
  reorder?: DrawerDragReorderAdapter;
  collectionReorder?: DrawerCollectionReorderAdapter;
  lookupMembership(start: DrawerDragItemContext): Promise<readonly string[]>;
  collectionAt(point: DrawerDragItemPoint): string | null;
  renderTargets(state: DrawerDragTargetState): void;
  activateSource(source: Source): void;
  releaseSource(source: Source): void;
  suppressClick(source: Source): void;
  beginVisual(start: DrawerDragItemContext): void;
  moveVisual(point: DrawerDragItemPoint): void;
  finishVisual(
    outcome: DrawerDragTerminalOutcome,
    reason?: DrawerDragCancelReason | "item-reorder",
  ): void;
  clearTransientFeedback(): void;
  commit(collectionId: string, start: DrawerDragItemContext): Promise<void>;
  showUnavailable(collectionId: string): void;
  showSuccess(collectionId: string): Promise<void> | void;
  showFailure(error: unknown): Promise<void> | void;
}

export interface DrawerDragLifecycle<Source> {
  start(start: DrawerDragStartFact<Source>): DrawerDragSession;
  move(session: DrawerDragSession, point: DrawerDragPoint): void;
  end(
    session: DrawerDragSession,
    point?: DrawerDragPoint,
  ): Promise<DrawerDragTerminalOutcome | null>;
  cancel(
    reason: DrawerDragCancelReason,
    session?: DrawerDragSession,
  ): DrawerDragTerminalOutcome | null;
}

type MembershipResult =
  | { ok: true; ids: readonly string[] }
  | { ok: false; error: unknown };

interface ActiveSession<Source> {
  kind: "item";
  token: DrawerDragSession;
  start: DrawerDragStart<Source>;
  point: DrawerDragItemPoint;
  membershipIds: readonly string[] | null;
  membershipResult: Promise<MembershipResult>;
  reorderContext: DrawerDragReorderContext | null;
  reorderState: DrawerDragReorderState | null;
  reorderFrame: number | null;
  ending: boolean;
}

interface ActiveCollectionSession<Source> {
  kind: "collection";
  token: DrawerDragSession;
  start: DrawerCollectionDragStart<Source>;
  point: DrawerDragPoint;
  drag: DragThreshold;
  reorderState: DrawerDragReorderState | null;
  sourceActive: boolean;
  ending: boolean;
}

interface ActiveCollectionMoveSession {
  kind: "collection-move";
  token: DrawerDragSession;
  start: DrawerCollectionMoveStart;
  ending: boolean;
}

type DrawerSession<Source> =
  | ActiveSession<Source>
  | ActiveCollectionSession<Source>
  | ActiveCollectionMoveSession;

function pointFromStart(start: DrawerDragItemContext): DrawerDragItemPoint {
  return {
    locator: start.locator,
    x: start.x,
    y: start.y,
  };
}

function isCollectionStart<Source>(
  start: DrawerDragStartFact<Source>,
): start is DrawerCollectionDragStart<Source> {
  return "kind" in start && start.kind === "collection";
}

function isCollectionMoveStart<Source>(
  start: DrawerDragStartFact<Source>,
): start is DrawerCollectionMoveStart {
  return start.kind === "collection-move";
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function canonicalCollectionOrder(
  context: DrawerCollectionReorderContext,
  beforeId: string | null,
): string[] {
  return insertBefore(
    context.orderedCollectionIds,
    context.collectionId,
    beforeId,
  );
}

function inactiveReorderState(): DrawerDragReorderState {
  return {
    active: false,
    inside: false,
    beforeId: null,
  };
}

function reorderStateForPoint(
  geometry: DrawerDragReorderGeometry,
  point: { x: number; y: number },
  movedId: string,
): DrawerDragReorderState {
  const inside = rectContains(geometry.list, point.x, point.y);
  let beforeId: string | null = null;
  if (inside) {
    for (const item of geometry.items) {
      if (item.id === movedId) continue;
      if (point.y < item.rect.top + (item.rect.bottom - item.rect.top) / 2) {
        beforeId = item.id;
        break;
      }
    }
  }
  return {
    active: true,
    inside,
    beforeId,
  };
}

class DragThreshold {
  private dragging = false;

  constructor(
    private readonly startX: number,
    private readonly startY: number,
    private readonly thresholdPx = 6,
  ) {}

  move(x: number, y: number): boolean {
    if (this.dragging) return false;
    if (Math.hypot(x - this.startX, y - this.startY) < this.thresholdPx) return false;
    this.dragging = true;
    return true;
  }

  get isDragging(): boolean {
    return this.dragging;
  }
}

export function createDrawerDragLifecycle<Source>(
  adapter: DrawerDragAdapter<Source>,
): DrawerDragLifecycle<Source> {
  let active: DrawerSession<Source> | null = null;

  function isCurrent(session: DrawerSession<Source>): boolean {
    return active === session;
  }

  function targetState(session: ActiveSession<Source>): DrawerDragTargetState {
    const rawTargetId = adapter.collectionAt(session.point);
    const membershipIds = session.membershipIds ?? [];
    const unavailable = rawTargetId !== null
      && session.membershipIds !== null
      && membershipIds.includes(rawTargetId);
    return {
      active: true,
      membershipReady: session.membershipIds !== null,
      membershipIds,
      targetId: unavailable ? null : rawTargetId,
    };
  }

  function render(session: ActiveSession<Source>): void {
    if (isCurrent(session)) adapter.renderTargets(targetState(session));
  }

  function currentReorderContext(
    session: ActiveSession<Source>,
  ): DrawerDragReorderContext | null {
    if (!session.reorderContext || !adapter.reorder) return null;
    const current = adapter.reorder.context(session.start);
    if (!current
      || current.collectionId !== session.reorderContext.collectionId
      || current.itemId !== session.reorderContext.itemId) return null;
    return current;
  }

  function stopReorderAutoScroll(session: ActiveSession<Source>): void {
    if (session.reorderFrame !== null) cancelAnimationFrame(session.reorderFrame);
    session.reorderFrame = null;
  }

  function reorderScrollVelocity(
    geometry: DrawerDragReorderGeometry,
    point: DrawerDragItemPoint,
  ): number {
    if (!rectContains(geometry.list, point.x, point.y)) return 0;
    const edge = 40;
    if (point.y < geometry.list.top + edge) {
      return -Math.max(3, Math.ceil((geometry.list.top + edge - point.y) / 3));
    }
    if (point.y > geometry.list.bottom - edge) {
      return Math.max(3, Math.ceil((point.y - (geometry.list.bottom - edge)) / 3));
    }
    return 0;
  }

  function scheduleReorderAutoScroll(
    session: ActiveSession<Source>,
    geometry: DrawerDragReorderGeometry,
  ): void {
    const velocity = reorderScrollVelocity(geometry, session.point);
    if (session.ending || velocity === 0) {
      stopReorderAutoScroll(session);
    } else if (session.reorderFrame === null) {
      session.reorderFrame = requestAnimationFrame(() => runReorderAutoScroll(session));
    }
  }

  function updateReorder(
    session: ActiveSession<Source>,
    scheduleAutoScroll = true,
  ): DrawerDragReorderState | null {
    const reorder = adapter.reorder;
    const context = currentReorderContext(session);
    if (!reorder || !context) {
      stopReorderAutoScroll(session);
      if (session.reorderState) reorder?.render(inactiveReorderState());
      session.reorderState = null;
      return null;
    }

    session.reorderContext = context;
    const geometry = reorder.measure();
    const state = reorderStateForPoint(geometry, session.point, context.itemId);
    session.reorderState = state;
    reorder.render(state);
    if (scheduleAutoScroll) scheduleReorderAutoScroll(session, geometry);
    else stopReorderAutoScroll(session);
    return state;
  }

  function runReorderAutoScroll(session: ActiveSession<Source>): void {
    session.reorderFrame = null;
    const reorder = adapter.reorder;
    if (!isCurrent(session) || session.ending || !reorder || !currentReorderContext(session)) return;
    const velocity = reorderScrollVelocity(reorder.measure(), session.point);
    if (velocity === 0) return;
    const scrolled = reorder.scrollBy(velocity);
    updateReorder(session, scrolled);
  }

  function clearReorder(session: ActiveSession<Source>): void {
    stopReorderAutoScroll(session);
    if (session.reorderState) adapter.reorder?.render(inactiveReorderState());
    session.reorderState = null;
  }

  function updateCollectionReorder(
    session: ActiveCollectionSession<Source>,
  ): DrawerDragReorderState | null {
    const reorder = adapter.collectionReorder;
    const context = reorder?.context(session.start.collectionId) ?? null;
    if (!reorder || !context) {
      if (session.reorderState) reorder?.render(inactiveReorderState());
      session.reorderState = null;
      return null;
    }

    const state = reorderStateForPoint(
      reorder.measure(),
      session.point,
      context.collectionId,
    );
    session.reorderState = state;
    reorder.render(state);
    return state;
  }

  function clearCollectionReorder(session: ActiveCollectionSession<Source>): void {
    if (session.reorderState) adapter.collectionReorder?.render(inactiveReorderState());
    session.reorderState = null;
  }

  async function commitCollectionMove(
    context: DrawerCollectionReorderContext,
    beforeId: string | null,
    beforeFailure?: () => void,
  ): Promise<"success" | "no-op" | "failed"> {
    const reorder = adapter.collectionReorder;
    if (!reorder) return "no-op";
    const nextIds = canonicalCollectionOrder(context, beforeId);
    if (sameOrder(nextIds, context.orderedCollectionIds)) return "no-op";
    try {
      await reorder.commit(nextIds);
      await reorder.showSuccess(context.collectionId);
      return "success";
    } catch (error) {
      beforeFailure?.();
      await reorder.showFailure(error);
      return "failed";
    }
  }

  function finish(
    session: DrawerSession<Source>,
    outcome: DrawerDragTerminalOutcome,
    reason?: DrawerDragCancelReason | "item-reorder",
  ): DrawerDragTerminalOutcome | null {
    if (!isCurrent(session)) return null;
    active = null;
    if (session.kind === "item") clearReorder(session);
    else if (session.kind === "collection") clearCollectionReorder(session);
    adapter.renderTargets({
      active: false,
      membershipReady: false,
      membershipIds: [],
      targetId: null,
    });
    adapter.clearTransientFeedback();
    if (session.kind === "item"
      || (session.kind === "collection" && session.sourceActive)) {
      adapter.releaseSource(session.start.source);
    }
    if (session.kind === "item") adapter.finishVisual(outcome, reason);
    return outcome;
  }

  async function fail(
    session: ActiveSession<Source>,
    error: unknown,
  ): Promise<DrawerDragTerminalOutcome | null> {
    const outcome = finish(session, "failed");
    await adapter.showFailure(error);
    return outcome;
  }

  function start(startFact: DrawerDragStartFact<Source>): DrawerDragSession {
    if (active) finish(active, "replaced");
    const token: DrawerDragSession = Object.freeze({
      [drawerDragSessionBrand]: true as const,
    });

    if (isCollectionMoveStart(startFact)) {
      active = {
        kind: "collection-move",
        token,
        start: startFact,
        ending: false,
      };
      return token;
    }

    if (isCollectionStart(startFact)) {
      active = {
        kind: "collection",
        token,
        start: startFact,
        point: {
          x: startFact.x,
          y: startFact.y,
        },
        drag: new DragThreshold(startFact.x, startFact.y),
        reorderState: null,
        sourceActive: false,
        ending: false,
      };
      return token;
    }

    const membershipResult = adapter.lookupMembership(startFact).then<MembershipResult, MembershipResult>(
      (ids) => ({ ok: true, ids }),
      (error: unknown) => ({ ok: false, error }),
    );
    const session: ActiveSession<Source> = {
      kind: "item",
      token,
      start: startFact,
      point: pointFromStart(startFact),
      membershipIds: null,
      membershipResult,
      reorderContext: adapter.reorder?.context(startFact) ?? null,
      reorderState: null,
      reorderFrame: null,
      ending: false,
    };
    active = session;
    adapter.activateSource(startFact.source);
    adapter.beginVisual(startFact);
    render(session);
    updateReorder(session);

    void membershipResult.then((result) => {
      if (!isCurrent(session) || !result.ok) return;
      session.membershipIds = result.ids;
      render(session);
    });
    return token;
  }

  function move(token: DrawerDragSession, point: DrawerDragPoint): void {
    const session = active;
    if (!session || session.ending || token !== session.token) return;
    if (session.kind === "collection-move") return;
    if (session.kind === "collection") {
      session.point = {
        x: point.x,
        y: point.y,
      };
      if (session.drag.move(point.x, point.y)) {
        session.sourceActive = true;
        adapter.activateSource(session.start.source);
        adapter.suppressClick(session.start.source);
      }
      if (session.drag.isDragging) updateCollectionReorder(session);
      return;
    }
    session.point = {
      locator: session.start.locator,
      x: point.x,
      y: point.y,
    };
    adapter.moveVisual(session.point);
    render(session);
    updateReorder(session);
  }

  async function end(
    token: DrawerDragSession,
    point?: DrawerDragPoint,
  ): Promise<DrawerDragTerminalOutcome | null> {
    const session = active;
    if (!session || session.ending || token !== session.token) return null;
    if (session.kind === "collection-move") {
      session.ending = true;
      const reorder = adapter.collectionReorder;
      const context = reorder?.context(session.start.collectionId) ?? null;
      if (!reorder || !context) return finish(session, "no-op");
      const index = context.orderedCollectionIds.indexOf(session.start.collectionId);
      const targetIndex = index + session.start.direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= context.orderedCollectionIds.length) {
        return finish(session, "no-op");
      }
      const beforeId = session.start.direction < 0
        ? context.orderedCollectionIds[targetIndex]
        : context.orderedCollectionIds[targetIndex + 1] ?? null;
      let failureOutcome: DrawerDragTerminalOutcome | null = null;
      const outcome = await commitCollectionMove(
        context,
        beforeId,
        () => {
          failureOutcome = finish(session, "failed");
        },
      );
      if (outcome === "failed") return failureOutcome;
      if (outcome === "no-op") return finish(session, "no-op");
      if (!isCurrent(session)) return null;
      return finish(session, "success");
    }
    if (!point) return null;
    if (session.kind === "collection") {
      session.ending = true;
      session.point = {
        x: point.x,
        y: point.y,
      };
      const reorderState = session.drag.isDragging
        ? updateCollectionReorder(session)
        : null;
      const reorder = adapter.collectionReorder;
      const context = reorder?.context(session.start.collectionId) ?? null;
      if (!reorderState?.inside || !reorder || !context) return finish(session, "no-op");
      let failureOutcome: DrawerDragTerminalOutcome | null = null;
      const outcome = await commitCollectionMove(
        context,
        reorderState.beforeId,
        () => {
          failureOutcome = finish(session, "failed");
        },
      );
      if (outcome === "failed") return failureOutcome;
      if (outcome === "no-op") return finish(session, "no-op");
      if (!isCurrent(session)) return null;
      return finish(session, "success");
    }

    session.ending = true;
    session.point = {
      locator: session.start.locator,
      x: point.x,
      y: point.y,
    };
    adapter.moveVisual(session.point);
    render(session);

    const reorderState = updateReorder(session, false);
    const reorderContext = currentReorderContext(session);
    if (reorderState?.inside && reorderContext && adapter.reorder) {
      const nextIds = insertBefore(
        reorderContext.orderedItemIds,
        reorderContext.itemId,
        reorderState.beforeId,
      );
      if (sameOrder(nextIds, reorderContext.orderedItemIds)) {
        return finish(session, "no-op", "item-reorder");
      }
      try {
        await adapter.reorder.commit(reorderContext.collectionId, nextIds);
        await adapter.reorder.showSuccess(reorderContext.collectionId);
      } catch (error) {
        const outcome = finish(session, "failed", "item-reorder");
        await adapter.reorder.showFailure(error);
        return outcome;
      }
      if (!isCurrent(session)) return null;
      const outcome = finish(session, "success", "item-reorder");
      return outcome;
    }

    const membership = await session.membershipResult;
    if (!isCurrent(session)) return null;
    if (!membership.ok) return fail(session, membership.error);

    session.membershipIds = membership.ids;
    render(session);
    const collectionId = adapter.collectionAt(session.point);
    if (collectionId === null) return finish(session, "no-op");
    if (membership.ids.includes(collectionId)) {
      const outcome = finish(session, "unavailable");
      adapter.showUnavailable(collectionId);
      return outcome;
    }

    try {
      await adapter.commit(collectionId, session.start);
    } catch (error) {
      return fail(session, error);
    }
    if (!isCurrent(session)) return null;
    const outcome = finish(session, "success");
    await adapter.showSuccess(collectionId);
    return outcome;
  }

  function cancel(
    reason: DrawerDragCancelReason,
    token?: DrawerDragSession,
  ): DrawerDragTerminalOutcome | null {
    const session = active;
    if (!session || session.ending || (token !== undefined && token !== session.token)) return null;
    return finish(session, "cancelled", reason);
  }

  return {
    start,
    move,
    end,
    cancel,
  };
}
