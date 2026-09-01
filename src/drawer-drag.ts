import type { ItemDragPoint, ItemDragStart } from "./drag";

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

export interface DrawerDragAdapter<Source> {
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

  function finish(
    session: ActiveSession<Source>,
    outcome: DrawerDragTerminalOutcome,
    reason?: DrawerDragCancelReason,
  ): DrawerDragTerminalOutcome | null {
    if (!isCurrent(session)) return null;
    active = null;
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
      ending: false,
    };
    active = session;
    adapter.activateSource(startFact.source);
    adapter.beginVisual(startFact);
    render(session);

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

    const membership = await session.membershipResult;
    if (!isCurrent(session)) return null;
    if (!membership.ok) {
      const outcome = finish(session, "failed");
      await adapter.showFailure(membership.error);
      return outcome;
    }

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
      if (!isCurrent(session)) return null;
      const outcome = finish(session, "failed");
      await adapter.showFailure(error);
      return outcome;
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
