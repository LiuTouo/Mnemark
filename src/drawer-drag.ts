import { DragController, rectContains } from "./drag";
import type { ItemDragPoint, ItemDragStart } from "./drag";
import { insertBefore } from "./reorder";

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
  | "source-removed"
  | "item-reorder";

export interface DrawerDragStart<Source> extends ItemDragStart {
  source: Source;
}

export interface DrawerCollectionDragStart<Source> {
  kind: "collection";
  sessionId: number;
  collectionId: string;
  x: number;
  y: number;
  source: Source;
}

export interface DrawerCollectionDragPoint {
  kind: "collection";
  sessionId: number;
  collectionId: string;
  x: number;
  y: number;
}

export type DrawerDragStartFact<Source> =
  | DrawerDragStart<Source>
  | DrawerCollectionDragStart<Source>;

export type DrawerDragPoint = ItemDragPoint | DrawerCollectionDragPoint;

export interface DrawerDragTargetState {
  active: boolean;
  membershipReady: boolean;
  membershipIds: readonly string[];
  targetId: string | null;
}

export interface DrawerDragRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface DrawerDragReorderContext {
  collectionId: string;
  itemId: string;
  orderedItemIds: readonly string[];
}

export interface DrawerDragReorderGeometry {
  list: DrawerDragRect;
  items: ReadonlyArray<{ id: string; rect: DrawerDragRect }>;
}

export interface DrawerDragReorderState {
  active: boolean;
  inside: boolean;
  beforeId: string | null;
}

export interface DrawerDragReorderAdapter {
  context(start: ItemDragStart): DrawerDragReorderContext | null;
  measure(): DrawerDragReorderGeometry;
  render(state: DrawerDragReorderState): void;
  scrollBy(amount: number): boolean;
  commit(collectionId: string, orderedItemIds: readonly string[]): Promise<void>;
  showSuccess(collectionId: string): Promise<void> | void;
  showFailure(error: unknown): Promise<void> | void;
}

export interface DrawerCollectionReorderContext {
  collectionId: string;
  orderedCollectionIds: readonly string[];
}

export interface DrawerCollectionReorderAdapter {
  context(collectionId: string): DrawerCollectionReorderContext | null;
  measure(): DrawerDragReorderGeometry;
  render(state: DrawerDragReorderState): void;
  commit(orderedCollectionIds: readonly string[]): Promise<void>;
  showSuccess(collectionId: string): Promise<void> | void;
  showFailure(error: unknown): Promise<void> | void;
}

export type DrawerCollectionMoveDirection = -1 | 1;

export interface DrawerDragAdapter<Source> {
  reorder?: DrawerDragReorderAdapter;
  collectionReorder?: DrawerCollectionReorderAdapter;
  lookupMembership(start: ItemDragStart): Promise<readonly string[]>;
  collectionAt(point: ItemDragPoint): string | null;
  renderTargets(state: DrawerDragTargetState): void;
  activateSource(source: Source): void;
  releaseSource(source: Source): void;
  beginVisual(start: ItemDragStart): void;
  moveVisual(point: ItemDragPoint): void;
  finishVisual(
    outcome: DrawerDragTerminalOutcome,
    reason?: DrawerDragCancelReason,
  ): void;
  clearTransientFeedback(): void;
  commit(collectionId: string, start: ItemDragStart): Promise<void>;
  showUnavailable(collectionId: string): void;
  showSuccess(collectionId: string): Promise<void> | void;
  showFailure(error: unknown): Promise<void> | void;
}

export interface DrawerDragLifecycle<Source> {
  nextSessionId(): number;
  start(start: DrawerDragStartFact<Source>): void;
  move(point: DrawerDragPoint): void;
  end(point: DrawerDragPoint): Promise<DrawerDragTerminalOutcome | null>;
  cancel(sessionId: number, reason: DrawerDragCancelReason): DrawerDragTerminalOutcome | null;
  consumeClickSuppression(sessionId: number): boolean;
  moveCollection(
    collectionId: string,
    direction: DrawerCollectionMoveDirection,
  ): Promise<DrawerDragTerminalOutcome>;
}

type MembershipResult =
  | { ok: true; ids: readonly string[] }
  | { ok: false; error: unknown };

interface ActiveSession<Source> {
  kind: "item";
  start: DrawerDragStart<Source>;
  point: ItemDragPoint;
  membershipIds: readonly string[] | null;
  membershipResult: Promise<MembershipResult>;
  reorderContext: DrawerDragReorderContext | null;
  reorderState: DrawerDragReorderState | null;
  reorderFrame: number | null;
  ending: boolean;
}

interface ActiveCollectionSession<Source> {
  kind: "collection";
  start: DrawerCollectionDragStart<Source>;
  point: DrawerCollectionDragPoint;
  drag: DragController;
  reorderState: DrawerDragReorderState | null;
  sourceActive: boolean;
  ending: boolean;
}

type DrawerSession<Source> = ActiveSession<Source> | ActiveCollectionSession<Source>;

function pointFromStart(start: ItemDragStart): ItemDragPoint {
  return {
    sessionId: start.sessionId,
    locator: start.locator,
    x: start.x,
    y: start.y,
  };
}

function sameLocator(left: ItemDragPoint["locator"], right: ItemDragPoint["locator"]): boolean {
  return left.scope === right.scope && left.id === right.id;
}

function isCollectionStart<Source>(
  start: DrawerDragStartFact<Source>,
): start is DrawerCollectionDragStart<Source> {
  return "kind" in start && start.kind === "collection";
}

function isCollectionPoint(point: DrawerDragPoint): point is DrawerCollectionDragPoint {
  return "kind" in point && point.kind === "collection";
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

export function createDrawerDragLifecycle<Source>(
  adapter: DrawerDragAdapter<Source>,
): DrawerDragLifecycle<Source> {
  let active: DrawerSession<Source> | null = null;
  let newestSessionId: number | null = null;
  let sessionSequence = 0;
  let clickSuppressionSessionId: number | null = null;

  function isCurrent(session: DrawerSession<Source>): boolean {
    return active === session;
  }

  function nextSessionId(): number {
    sessionSequence = Math.max(sessionSequence, newestSessionId ?? 0) + 1;
    return sessionSequence;
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
    point: ItemDragPoint,
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
    reason?: DrawerDragCancelReason,
  ): DrawerDragTerminalOutcome | null {
    if (!isCurrent(session)) return null;
    active = null;
    if (session.kind === "item") clearReorder(session);
    else clearCollectionReorder(session);
    adapter.renderTargets({
      active: false,
      membershipReady: false,
      membershipIds: [],
      targetId: null,
    });
    adapter.clearTransientFeedback();
    if (session.kind === "item" || session.sourceActive) {
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

  function start(startFact: DrawerDragStartFact<Source>): void {
    if (newestSessionId !== null && startFact.sessionId <= newestSessionId) return;
    if (active) finish(active, "replaced");
    newestSessionId = startFact.sessionId;

    if (isCollectionStart(startFact)) {
      const drag = new DragController(6);
      drag.pointerDown(startFact.x, startFact.y);
      active = {
        kind: "collection",
        start: startFact,
        point: {
          kind: "collection",
          sessionId: startFact.sessionId,
          collectionId: startFact.collectionId,
          x: startFact.x,
          y: startFact.y,
        },
        drag,
        reorderState: null,
        sourceActive: false,
        ending: false,
      };
      return;
    }

    const membershipResult = adapter.lookupMembership(startFact).then<MembershipResult, MembershipResult>(
      (ids) => ({ ok: true, ids }),
      (error: unknown) => ({ ok: false, error }),
    );
    const session: ActiveSession<Source> = {
      kind: "item",
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
  }

  function move(point: DrawerDragPoint): void {
    const session = active;
    if (!session || session.ending || point.sessionId !== session.start.sessionId) return;
    if (session.kind === "collection") {
      if (!isCollectionPoint(point) || point.collectionId !== session.start.collectionId) return;
      session.point = point;
      if (session.drag.pointerMove(point.x, point.y)) {
        session.sourceActive = true;
        clickSuppressionSessionId = session.start.sessionId;
        adapter.activateSource(session.start.source);
      }
      if (session.drag.isDragging) updateCollectionReorder(session);
      return;
    }
    if (isCollectionPoint(point) || !sameLocator(point.locator, session.start.locator)) return;
    session.point = point;
    adapter.moveVisual(point);
    render(session);
    updateReorder(session);
  }

  async function end(point: DrawerDragPoint): Promise<DrawerDragTerminalOutcome | null> {
    const session = active;
    if (!session || session.ending || point.sessionId !== session.start.sessionId) return null;
    if (session.kind === "collection") {
      if (!isCollectionPoint(point) || point.collectionId !== session.start.collectionId) return null;
      session.ending = true;
      session.point = point;
      const reorderState = session.drag.isDragging
        ? updateCollectionReorder(session)
        : null;
      const reorder = adapter.collectionReorder;
      const context = reorder?.context(session.start.collectionId) ?? null;
      session.drag.pointerUp();
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
    if (isCollectionPoint(point) || !sameLocator(point.locator, session.start.locator)) return null;

    session.ending = true;
    session.point = point;
    adapter.moveVisual(point);
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
      } catch (error) {
        const outcome = finish(session, "failed", "item-reorder");
        await adapter.reorder.showFailure(error);
        return outcome;
      }
      await adapter.reorder.showSuccess(reorderContext.collectionId);
      if (!isCurrent(session)) return null;
      const outcome = finish(session, "success", "item-reorder");
      return outcome;
    }

    const membership = await session.membershipResult;
    if (!isCurrent(session)) return null;
    if (!membership.ok) return fail(session, membership.error);

    session.membershipIds = membership.ids;
    render(session);
    const collectionId = adapter.collectionAt(point);
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
    sessionId: number,
    reason: DrawerDragCancelReason,
  ): DrawerDragTerminalOutcome | null {
    const session = active;
    if (!session || session.start.sessionId !== sessionId) return null;
    return finish(session, "cancelled", reason);
  }

  function consumeClickSuppression(sessionId: number): boolean {
    if (clickSuppressionSessionId !== sessionId) return false;
    clickSuppressionSessionId = null;
    return true;
  }

  async function moveCollection(
    collectionId: string,
    direction: DrawerCollectionMoveDirection,
  ): Promise<DrawerDragTerminalOutcome> {
    const reorder = adapter.collectionReorder;
    const context = reorder?.context(collectionId) ?? null;
    if (!reorder || !context) return "no-op";
    const index = context.orderedCollectionIds.indexOf(collectionId);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= context.orderedCollectionIds.length) {
      return "no-op";
    }
    const beforeId = direction < 0
      ? context.orderedCollectionIds[targetIndex]
      : context.orderedCollectionIds[targetIndex + 1] ?? null;
    return commitCollectionMove(context, beforeId);
  }

  return {
    nextSessionId,
    start,
    move,
    end,
    cancel,
    consumeClickSuppression,
    moveCollection,
  };
}
