import { rectContains } from "./drag";
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

export interface DrawerDragAdapter<Source> {
  reorder?: DrawerDragReorderAdapter;
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
  start(start: DrawerDragStart<Source>): void;
  move(point: ItemDragPoint): void;
  end(point: ItemDragPoint): Promise<DrawerDragTerminalOutcome | null>;
  cancel(sessionId: number, reason: DrawerDragCancelReason): DrawerDragTerminalOutcome | null;
}

type MembershipResult =
  | { ok: true; ids: readonly string[] }
  | { ok: false; error: unknown };

interface ActiveSession<Source> {
  start: DrawerDragStart<Source>;
  point: ItemDragPoint;
  membershipIds: readonly string[] | null;
  membershipResult: Promise<MembershipResult>;
  reorderContext: DrawerDragReorderContext | null;
  reorderState: DrawerDragReorderState | null;
  reorderFrame: number | null;
  ending: boolean;
}

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

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function inactiveReorderState(): DrawerDragReorderState {
  return {
    active: false,
    inside: false,
    beforeId: null,
  };
}

export function createDrawerDragLifecycle<Source>(
  adapter: DrawerDragAdapter<Source>,
): DrawerDragLifecycle<Source> {
  let active: ActiveSession<Source> | null = null;
  let newestSessionId: number | null = null;

  function isCurrent(session: ActiveSession<Source>): boolean {
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
    const inside = rectContains(geometry.list, session.point.x, session.point.y);
    let beforeId: string | null = null;
    if (inside) {
      for (const item of geometry.items) {
        if (item.id === context.itemId) continue;
        if (session.point.y < item.rect.top + (item.rect.bottom - item.rect.top) / 2) {
          beforeId = item.id;
          break;
        }
      }
    }
    const state: DrawerDragReorderState = {
      active: true,
      inside,
      beforeId,
    };
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

  function finish(
    session: ActiveSession<Source>,
    outcome: DrawerDragTerminalOutcome,
    reason?: DrawerDragCancelReason,
  ): DrawerDragTerminalOutcome | null {
    if (!isCurrent(session)) return null;
    active = null;
    clearReorder(session);
    adapter.renderTargets({
      active: false,
      membershipReady: false,
      membershipIds: [],
      targetId: null,
    });
    adapter.clearTransientFeedback();
    adapter.releaseSource(session.start.source);
    adapter.finishVisual(outcome, reason);
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

  function start(startFact: DrawerDragStart<Source>): void {
    if (newestSessionId !== null && startFact.sessionId <= newestSessionId) return;
    if (active) finish(active, "replaced");
    newestSessionId = startFact.sessionId;

    const membershipResult = adapter.lookupMembership(startFact).then<MembershipResult, MembershipResult>(
      (ids) => ({ ok: true, ids }),
      (error: unknown) => ({ ok: false, error }),
    );
    const session: ActiveSession<Source> = {
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

  function move(point: ItemDragPoint): void {
    const session = active;
    if (!session
      || session.ending
      || point.sessionId !== session.start.sessionId
      || !sameLocator(point.locator, session.start.locator)) return;
    session.point = point;
    adapter.moveVisual(point);
    render(session);
    updateReorder(session);
  }

  async function end(point: ItemDragPoint): Promise<DrawerDragTerminalOutcome | null> {
    const session = active;
    if (!session
      || session.ending
      || point.sessionId !== session.start.sessionId
      || !sameLocator(point.locator, session.start.locator)) return null;

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

  return { start, move, end, cancel };
}
