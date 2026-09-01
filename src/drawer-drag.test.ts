import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDrawerDragLifecycle,
} from "./drawer-drag";
import type {
  DrawerCollectionDragStart,
  DrawerDragCancelReason,
  DrawerDragPoint,
  DrawerDragStart,
  DrawerDragTerminalOutcome,
  DrawerDragVisual,
} from "./drawer-drag";

type DrawerDragAdapter = Parameters<typeof createDrawerDragLifecycle<string>>[0];
type DrawerDragItemContext = Parameters<DrawerDragAdapter["lookupMembership"]>[0];
type DrawerDragItemPoint = Parameters<DrawerDragAdapter["collectionAt"]>[0];
type DrawerDragTargetState = Parameters<DrawerDragAdapter["renderTargets"]>[0];
type DrawerDragReorderAdapter = NonNullable<DrawerDragAdapter["reorder"]>;
type DrawerDragReorderGeometry = ReturnType<DrawerDragReorderAdapter["measure"]>;
type DrawerDragReorderState = Parameters<DrawerDragReorderAdapter["render"]>[0];
type DrawerCollectionReorderAdapter = NonNullable<DrawerDragAdapter["collectionReorder"]>;
type DrawerCollectionReorderContext = NonNullable<
  ReturnType<DrawerCollectionReorderAdapter["context"]>
>;

type FixtureItemStart = DrawerDragStart<string>;
type FixtureCollectionStart = DrawerCollectionDragStart<string>;
type FixturePoint = DrawerDragPoint;

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function startFact(
  fixtureId: number,
  visual: DrawerDragVisual = { kind: "Text", preview: "clip", thumbnailBase64: null },
): FixtureItemStart {
  return {
    kind: "item",
    locator: { scope: "history", id: `clip-${fixtureId}` },
    visual,
    x: 10,
    y: 20,
    source: `row-${fixtureId}`,
  };
}

function favoriteStartFact(fixtureId: number, snapshotId: string): FixtureItemStart {
  return {
    ...startFact(fixtureId),
    locator: { scope: "favorite", id: snapshotId },
    source: `drawer-row-${snapshotId}`,
  };
}

function collectionStartFact(
  _fixtureId: number,
  collectionId = "drawer-b",
): FixtureCollectionStart {
  return {
    kind: "collection",
    collectionId,
    x: 10,
    y: 120,
    source: `collection-row-${collectionId}`,
  };
}

function collectionPoint(
  start: FixtureCollectionStart,
  x = start.x,
  y = start.y,
): FixturePoint {
  return {
    x,
    y,
  };
}

function point(start: FixtureItemStart, x = start.x, y = start.y): FixturePoint {
  return {
    x,
    y,
  };
}

class MemoryDrawerReorderAdapter implements DrawerDragReorderAdapter {
  projection: "all" | "search" | "filter" = "all";
  collectionId = "drawer-a";
  orderedItemIds = ["snapshot-a", "snapshot-b", "snapshot-c", "snapshot-d"];
  geometry: DrawerDragReorderGeometry = {
    list: { left: 0, top: -100, right: 100, bottom: 500 },
    items: [
      { id: "snapshot-a", rect: { left: 0, top: 0, right: 100, bottom: 100 } },
      { id: "snapshot-b", rect: { left: 0, top: 100, right: 100, bottom: 200 } },
      { id: "snapshot-c", rect: { left: 0, top: 200, right: 100, bottom: 300 } },
      { id: "snapshot-d", rect: { left: 0, top: 300, right: 100, bottom: 400 } },
    ],
  };
  readonly states: DrawerDragReorderState[] = [];
  readonly commits: Array<{ collectionId: string; orderedItemIds: readonly string[] }> = [];
  readonly successes: string[] = [];
  readonly failures: unknown[] = [];
  readonly scrollAmounts: number[] = [];
  scrollResult = false;
  onScroll: (() => void) | null = null;
  commitGate: Promise<void> | null = null;
  commitError: unknown | null = null;
  successRecovery: Promise<void> | null = null;
  failureRecovery: Promise<void> | null = null;

  context(start: DrawerDragItemContext) {
    if (this.projection !== "all" || start.locator.scope !== "favorite") return null;
    return {
      collectionId: this.collectionId,
      itemId: start.locator.id,
      orderedItemIds: [...this.orderedItemIds],
    };
  }

  measure(): DrawerDragReorderGeometry {
    return this.geometry;
  }

  render(state: DrawerDragReorderState): void {
    this.states.push({ ...state });
  }

  scrollBy(amount: number): boolean {
    this.scrollAmounts.push(amount);
    this.onScroll?.();
    return this.scrollResult;
  }

  async commit(collectionId: string, orderedItemIds: readonly string[]): Promise<void> {
    this.commits.push({ collectionId, orderedItemIds: [...orderedItemIds] });
    if (this.commitGate) await this.commitGate;
    if (this.commitError) throw this.commitError;
  }

  showSuccess(collectionId: string): Promise<void> | void {
    this.successes.push(collectionId);
    return this.successRecovery ?? undefined;
  }

  showFailure(error: unknown): Promise<void> | void {
    this.failures.push(error);
    return this.failureRecovery ?? undefined;
  }
}

class MemoryCollectionReorderAdapter implements DrawerCollectionReorderAdapter {
  orderedCollectionIds = ["drawer-a", "drawer-b", "drawer-c", "drawer-d"];
  geometry: DrawerDragReorderGeometry = {
    list: { left: 0, top: 0, right: 100, bottom: 400 },
    items: [
      { id: "drawer-a", rect: { left: 0, top: 0, right: 100, bottom: 100 } },
      { id: "drawer-b", rect: { left: 0, top: 100, right: 100, bottom: 200 } },
      { id: "drawer-c", rect: { left: 0, top: 200, right: 100, bottom: 300 } },
      { id: "drawer-d", rect: { left: 0, top: 300, right: 100, bottom: 400 } },
    ],
  };
  readonly states: DrawerDragReorderState[] = [];
  readonly commits: ReadonlyArray<string>[] = [];
  readonly successes: string[] = [];
  readonly failures: unknown[] = [];
  commitGate: Promise<void> | null = null;
  commitError: unknown | null = null;
  successRecovery: Promise<void> | null = null;
  failureRecovery: Promise<void> | null = null;

  context(collectionId: string): DrawerCollectionReorderContext | null {
    if (!this.orderedCollectionIds.includes(collectionId)) return null;
    return {
      collectionId,
      orderedCollectionIds: [...this.orderedCollectionIds],
    };
  }

  measure(): DrawerDragReorderGeometry {
    return this.geometry;
  }

  render(state: DrawerDragReorderState): void {
    this.states.push({ ...state });
  }

  async commit(orderedCollectionIds: readonly string[]): Promise<void> {
    this.commits.push([...orderedCollectionIds]);
    if (this.commitGate) await this.commitGate;
    if (this.commitError) throw this.commitError;
  }

  showSuccess(collectionId: string): Promise<void> | void {
    this.successes.push(collectionId);
    return this.successRecovery ?? undefined;
  }

  showFailure(error: unknown): Promise<void> | void {
    this.failures.push(error);
    return this.failureRecovery ?? undefined;
  }
}

class MemoryDrawerDragAdapter implements DrawerDragAdapter {
  readonly memberships = new Map<string, ReturnType<typeof deferred<readonly string[]>>>();
  readonly targetStates: DrawerDragTargetState[] = [];
  readonly activatedSources: string[] = [];
  readonly releasedSources: string[] = [];
  readonly begunVisuals: DrawerDragItemContext[] = [];
  readonly movedVisuals: DrawerDragItemPoint[] = [];
  readonly finishedVisuals: DrawerDragTerminalOutcome[] = [];
  readonly finishedVisualReasons: Array<DrawerDragCancelReason | "item-reorder" | undefined> = [];
  readonly commits: Array<{ collectionId: string; locatorId: string }> = [];
  readonly unavailable: string[] = [];
  readonly successes: string[] = [];
  readonly failures: unknown[] = [];
  readonly suppressedSources: string[] = [];
  collectionId: string | null = "drawer-a";
  commitError: unknown | null = null;
  commitGate: Promise<void> | null = null;
  failureRecovery: Promise<void> | null = null;
  reorder: DrawerDragReorderAdapter | undefined;
  collectionReorder: DrawerCollectionReorderAdapter | undefined;
  transientCleanupCount = 0;
  indicatorVisible = false;
  frameScheduled = false;

  lookupMembership(start: DrawerDragItemContext): Promise<readonly string[]> {
    const request = deferred<readonly string[]>();
    this.memberships.set(start.locator.id, request);
    return request.promise;
  }

  collectionAt(_point: DrawerDragItemPoint): string | null {
    return this.collectionId;
  }

  renderTargets(state: DrawerDragTargetState): void {
    this.targetStates.push({ ...state, membershipIds: [...state.membershipIds] });
  }

  activateSource(source: string): void {
    this.activatedSources.push(source);
    this.indicatorVisible = true;
    this.frameScheduled = true;
  }

  releaseSource(source: string): void {
    this.releasedSources.push(source);
  }

  suppressClick(source: string): void {
    this.suppressedSources.push(source);
  }

  beginVisual(start: DrawerDragItemContext): void {
    this.begunVisuals.push(start);
  }

  moveVisual(nextPoint: DrawerDragItemPoint): void {
    this.movedVisuals.push(nextPoint);
  }

  finishVisual(
    outcome: DrawerDragTerminalOutcome,
    reason?: DrawerDragCancelReason | "item-reorder",
  ): void {
    this.finishedVisuals.push(outcome);
    this.finishedVisualReasons.push(reason);
  }

  clearTransientFeedback(): void {
    this.transientCleanupCount += 1;
    this.indicatorVisible = false;
    this.frameScheduled = false;
  }

  async commit(collectionId: string, start: DrawerDragItemContext): Promise<void> {
    this.commits.push({ collectionId, locatorId: start.locator.id });
    if (this.commitError !== null) throw this.commitError;
    if (this.commitGate !== null) await this.commitGate;
  }

  showUnavailable(collectionId: string): void {
    this.unavailable.push(collectionId);
  }

  showSuccess(collectionId: string): void {
    this.successes.push(collectionId);
  }

  showFailure(error: unknown): Promise<void> | void {
    this.failures.push(error);
    return this.failureRecovery ?? undefined;
  }
}

async function resolveMembership(
  adapter: MemoryDrawerDragAdapter,
  start: FixtureItemStart,
  ids: readonly string[],
): Promise<void> {
  adapter.memberships.get(start.locator.id)!.resolve(ids);
  await Promise.resolve();
}

function expectClean(adapter: MemoryDrawerDragAdapter, source: string): void {
  expect(adapter.releasedSources).toContain(source);
  expect(adapter.targetStates[adapter.targetStates.length - 1]).toEqual({
    active: false,
    membershipReady: false,
    membershipIds: [],
    targetId: null,
  });
  expect(adapter.indicatorVisible).toBe(false);
  expect(adapter.frameScheduled).toBe(false);
}

function collectionLifecycleFixture() {
  const adapter = new MemoryDrawerDragAdapter();
  const collectionReorder = new MemoryCollectionReorderAdapter();
  adapter.collectionReorder = collectionReorder;
  return {
    adapter,
    collectionReorder,
    lifecycle: createDrawerDragLifecycle(adapter),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Drawer drag lifecycle", () => {
  it("owns session identity and rejects cancellation from a replaced session", () => {
    const adapter = new MemoryDrawerDragAdapter();
    const lifecycle = createDrawerDragLifecycle<string>(adapter);
    const first = lifecycle.start({
      kind: "item",
      locator: { scope: "history", id: "clip-first" },
      visual: { kind: "Text", preview: "first", thumbnailBase64: null },
      x: 10,
      y: 20,
      source: "row-first",
    });
    const second = lifecycle.start({
      kind: "item",
      locator: { scope: "history", id: "clip-second" },
      visual: { kind: "Text", preview: "second", thumbnailBase64: null },
      x: 30,
      y: 40,
      source: "row-second",
    });

    expect(first).not.toBe(second);
    expect(lifecycle.cancel("explicit", first)).toBeNull();
    expect(lifecycle.cancel("explicit", second)).toBe("cancelled");
  });

  it("keeps collection reorder pending below the movement threshold", async () => {
    const { adapter, collectionReorder, lifecycle } = collectionLifecycleFixture();
    const start = collectionStartFact(30);

    const session = lifecycle.start(start);
    lifecycle.move(session, collectionPoint(start, 13, 124));

    expect(collectionReorder.states).toEqual([]);
    expect(adapter.activatedSources).toEqual([]);
    expect(adapter.suppressedSources).toEqual([]);
    await expect(lifecycle.end(session, collectionPoint(start, 13, 124))).resolves.toBe("no-op");
    expect(collectionReorder.commits).toEqual([]);
  });

  it("requests synthetic-click suppression once when collection drag begins", async () => {
    const { adapter, collectionReorder, lifecycle } = collectionLifecycleFixture();
    const start = collectionStartFact(31);

    const session = lifecycle.start(start);
    lifecycle.move(session, collectionPoint(start, 20, 120));
    lifecycle.move(session, collectionPoint(start, 30, 130));

    expect(adapter.activatedSources).toEqual(["collection-row-drawer-b"]);
    expect(collectionReorder.states[collectionReorder.states.length - 1]).toEqual({
      active: true,
      inside: true,
      beforeId: "drawer-c",
    });
    await expect(lifecycle.end(session, collectionPoint(start, 20, 120))).resolves.toBe("no-op");
    expect(adapter.suppressedSources).toEqual(["collection-row-drawer-b"]);
    expect(collectionReorder.states[collectionReorder.states.length - 1]).toEqual({
      active: false,
      inside: false,
      beforeId: null,
    });
  });

  it("commits collection reorder, reloads authoritative order, and cleans terminal state", async () => {
    const { adapter, collectionReorder, lifecycle } = collectionLifecycleFixture();
    const start = collectionStartFact(32);

    const session = lifecycle.start(start);
    lifecycle.move(session, collectionPoint(start, 20, 120));

    await expect(lifecycle.end(session, collectionPoint(start, 20, 10))).resolves.toBe("success");
    expect(collectionReorder.commits).toEqual([
      ["drawer-b", "drawer-a", "drawer-c", "drawer-d"],
    ]);
    expect(collectionReorder.successes).toEqual(["drawer-b"]);
    expect(collectionReorder.states[collectionReorder.states.length - 1]).toEqual({
      active: false,
      inside: false,
      beforeId: null,
    });
    expect(adapter.releasedSources).toEqual(["collection-row-drawer-b"]);
    expect(adapter.finishedVisuals).toEqual([]);
    expectClean(adapter, "collection-row-drawer-b");
  });

  it("awaits authoritative collection reload before successful terminal cleanup", async () => {
    const { adapter, collectionReorder, lifecycle } = collectionLifecycleFixture();
    const recovery = deferred<void>();
    collectionReorder.successRecovery = recovery.promise;
    const start = collectionStartFact(41);

    const session = lifecycle.start(start);
    lifecycle.move(session, collectionPoint(start, 20, 10));
    let settled = false;
    const outcome = lifecycle.end(session, collectionPoint(start, 20, 10)).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(collectionReorder.successes).toEqual(["drawer-b"]);
    expect(settled).toBe(false);

    recovery.resolve();
    await expect(outcome).resolves.toBe("success");
    expectClean(adapter, "collection-row-drawer-b");
  });

  it("cleans and recovers when authoritative collection reload rejects", async () => {
    const { adapter, collectionReorder, lifecycle } = collectionLifecycleFixture();
    const recovery = deferred<void>();
    const error = new Error("authoritative collection reload failed");
    collectionReorder.successRecovery = recovery.promise;
    const start = collectionStartFact(42);

    const session = lifecycle.start(start);
    lifecycle.move(session, collectionPoint(start, 20, 10));
    const outcome = lifecycle.end(session, collectionPoint(start, 20, 10));
    await new Promise((resolve) => setTimeout(resolve, 0));
    recovery.reject(error);

    await expect(outcome).resolves.toBe("failed");
    expect(collectionReorder.failures).toEqual([error]);
    expectClean(adapter, "collection-row-drawer-b");
  });

  it.each([
    { label: "first", y: 10, beforeId: "drawer-a" },
    { label: "middle", y: 120, beforeId: "drawer-c" },
    { label: "last", y: 300, beforeId: "drawer-d" },
    { label: "list-end", y: 390, beforeId: null },
  ])("renders the $label collection insertion position", ({ y, beforeId }) => {
    const { collectionReorder, lifecycle } = collectionLifecycleFixture();
    const start = collectionStartFact(33);

    const session = lifecycle.start(start);
    lifecycle.move(session, collectionPoint(start, 20, y));

    expect(collectionReorder.states[collectionReorder.states.length - 1]).toEqual({
      active: true,
      inside: true,
      beforeId,
    });
    lifecycle.cancel("explicit", session);
  });

  it("treats the current collection insertion position as a no-op", async () => {
    const { adapter, collectionReorder, lifecycle } = collectionLifecycleFixture();
    const start = collectionStartFact(34);

    const session = lifecycle.start(start);
    lifecycle.move(session, collectionPoint(start, 20, 120));

    await expect(lifecycle.end(session, collectionPoint(start, 20, 120))).resolves.toBe("no-op");
    expect(collectionReorder.commits).toEqual([]);
    expect(collectionReorder.successes).toEqual([]);
    expectClean(adapter, "collection-row-drawer-b");
  });

  it("uses the same canonical order for drag and Move Up", async () => {
    const {
      collectionReorder: dragReorder,
      lifecycle: dragLifecycle,
    } = collectionLifecycleFixture();
    const start = collectionStartFact(35);
    const dragSession = dragLifecycle.start(start);
    dragLifecycle.move(dragSession, collectionPoint(start, 20, 10));
    await dragLifecycle.end(dragSession, collectionPoint(start, 20, 10));

    const {
      collectionReorder: menuReorder,
      lifecycle: menuLifecycle,
    } = collectionLifecycleFixture();
    const menuSession = menuLifecycle.start({
      kind: "collection-move",
      collectionId: "drawer-b",
      direction: -1,
    });
    await expect(menuLifecycle.end(menuSession)).resolves.toBe("success");

    expect(menuReorder.commits).toEqual(dragReorder.commits);
  });

  it("uses the same canonical order for drag and Move Down", async () => {
    const {
      collectionReorder: dragReorder,
      lifecycle: dragLifecycle,
    } = collectionLifecycleFixture();
    const start = collectionStartFact(36);
    const dragSession = dragLifecycle.start(start);
    dragLifecycle.move(dragSession, collectionPoint(start, 20, 300));
    await dragLifecycle.end(dragSession, collectionPoint(start, 20, 300));

    const {
      collectionReorder: menuReorder,
      lifecycle: menuLifecycle,
    } = collectionLifecycleFixture();
    const menuSession = menuLifecycle.start({
      kind: "collection-move",
      collectionId: "drawer-b",
      direction: 1,
    });
    await expect(menuLifecycle.end(menuSession)).resolves.toBe("success");

    expect(menuReorder.commits).toEqual(dragReorder.commits);
  });

  it("treats collection Move Up and Move Down boundaries as no-ops", async () => {
    const { collectionReorder, lifecycle } = collectionLifecycleFixture();

    const firstSession = lifecycle.start({
      kind: "collection-move",
      collectionId: "drawer-a",
      direction: -1,
    });
    await expect(lifecycle.end(firstSession)).resolves.toBe("no-op");
    const lastSession = lifecycle.start({
      kind: "collection-move",
      collectionId: "drawer-d",
      direction: 1,
    });
    await expect(lifecycle.end(lastSession)).resolves.toBe("no-op");
    expect(collectionReorder.commits).toEqual([]);
    expect(collectionReorder.successes).toEqual([]);
  });

  it("cleans collection visuals before awaiting authoritative failure recovery", async () => {
    const { adapter, collectionReorder, lifecycle } = collectionLifecycleFixture();
    const error = new Error("collection reorder rejected");
    const recovery = deferred<void>();
    collectionReorder.commitError = error;
    collectionReorder.failureRecovery = recovery.promise;
    const start = collectionStartFact(37);

    const session = lifecycle.start(start);
    lifecycle.move(session, collectionPoint(start, 20, 10));
    let settled = false;
    const outcome = lifecycle.end(session, collectionPoint(start, 20, 10)).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(collectionReorder.failures).toEqual([error]);
    expect(adapter.releasedSources).toEqual(["collection-row-drawer-b"]);
    expect(collectionReorder.states[collectionReorder.states.length - 1]).toMatchObject({
      active: false,
    });
    expect(settled).toBe(false);

    recovery.resolve();
    await expect(outcome).resolves.toBe("failed");
  });

  it.each<DrawerDragCancelReason>([
    "pointercancel",
    "lostpointercapture",
    "window-blur",
    "explicit",
  ])("cancels collection reorder without mutation for %s", (reason) => {
    const { adapter, collectionReorder, lifecycle } = collectionLifecycleFixture();
    const start = collectionStartFact(38);

    const session = lifecycle.start(start);
    lifecycle.move(session, collectionPoint(start, 20, 10));

    expect(lifecycle.cancel(reason, session)).toBe("cancelled");
    expect(lifecycle.cancel(reason, session)).toBeNull();
    expect(collectionReorder.commits).toEqual([]);
    expect(adapter.releasedSources).toEqual(["collection-row-drawer-b"]);
    expectClean(adapter, "collection-row-drawer-b");
  });

  it("rejects stale collection move, end, and cancel after session replacement", async () => {
    const { collectionReorder, lifecycle } = collectionLifecycleFixture();
    const stale = collectionStartFact(39, "drawer-b");
    const current = collectionStartFact(40, "drawer-c");

    const staleSession = lifecycle.start(stale);
    lifecycle.move(staleSession, collectionPoint(stale, 20, 10));
    const currentSession = lifecycle.start(current);
    const stateCount = collectionReorder.states.length;

    lifecycle.move(staleSession, collectionPoint(stale, 20, 390));
    await expect(lifecycle.end(staleSession, collectionPoint(stale, 20, 390))).resolves.toBeNull();
    expect(lifecycle.cancel("explicit", staleSession)).toBeNull();
    expect(collectionReorder.states).toHaveLength(stateCount);
    expect(collectionReorder.commits).toEqual([]);
    lifecycle.cancel("explicit", currentSession);
  });

  it("prioritizes an active-list reorder over a collection drop", async () => {
    const adapter = new MemoryDrawerDragAdapter();
    const reorder = new MemoryDrawerReorderAdapter();
    adapter.reorder = reorder;
    adapter.collectionId = "drawer-b";
    const lifecycle = createDrawerDragLifecycle(adapter);
    const start = favoriteStartFact(18, "snapshot-d");

    const session = lifecycle.start(start);

    await expect(lifecycle.end(session, point(start, 50, 125))).resolves.toBe("success");
    expect(reorder.commits).toEqual([{
      collectionId: "drawer-a",
      orderedItemIds: ["snapshot-a", "snapshot-d", "snapshot-b", "snapshot-c"],
    }]);
    expect(reorder.successes).toEqual(["drawer-a"]);
    expect(adapter.commits).toEqual([]);
    expect(adapter.finishedVisualReasons).toEqual(["item-reorder"]);
    expectClean(adapter, "drawer-row-snapshot-d");
  });

  it("auto-scrolls at an edge and refreshes insertion from the latest geometry", () => {
    const frames = new Map<number, FrameRequestCallback>();
    const cancelled: number[] = [];
    let nextFrame = 1;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      cancelled.push(id);
      frames.delete(id);
    });
    const adapter = new MemoryDrawerDragAdapter();
    const reorder = new MemoryDrawerReorderAdapter();
    reorder.orderedItemIds = ["snapshot-a", "snapshot-b", "snapshot-c", "snapshot-d", "snapshot-e"];
    reorder.geometry = {
      list: { left: 0, top: 0, right: 100, bottom: 400 },
      items: reorder.orderedItemIds.map((id, index) => ({
        id,
        rect: { left: 0, top: index * 100, right: 100, bottom: (index + 1) * 100 },
      })),
    };
    reorder.scrollResult = true;
    reorder.onScroll = () => {
      reorder.geometry = {
        ...reorder.geometry,
        items: reorder.geometry.items.map((item) => ({
          id: item.id,
          rect: {
            ...item.rect,
            top: item.rect.top - 100,
            bottom: item.rect.bottom - 100,
          },
        })),
      };
    };
    adapter.reorder = reorder;
    const lifecycle = createDrawerDragLifecycle(adapter);
    const start = favoriteStartFact(19, "snapshot-a");

    const session = lifecycle.start(start);
    lifecycle.move(session, point(start, 50, 370));
    expect(reorder.states[reorder.states.length - 1]).toMatchObject({ beforeId: "snapshot-e" });

    const firstFrameId = [...frames.keys()][0];
    const firstFrame = frames.get(firstFrameId)!;
    frames.delete(firstFrameId);
    firstFrame(0);

    expect(reorder.scrollAmounts[0]).toBeGreaterThan(0);
    expect(reorder.states[reorder.states.length - 1]).toMatchObject({ beforeId: null });
    const pendingFrameId = [...frames.keys()][0];
    lifecycle.move(session, point(start, 50, 200));
    expect(cancelled).toContain(pendingFrameId);

    lifecycle.cancel("explicit", session);
    vi.unstubAllGlobals();
  });

  it("auto-scrolls upward faster as the pointer approaches the top edge", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames.delete(id);
    });
    const adapter = new MemoryDrawerDragAdapter();
    const reorder = new MemoryDrawerReorderAdapter();
    reorder.geometry = {
      ...reorder.geometry,
      list: { left: 0, top: 0, right: 100, bottom: 400 },
    };
    adapter.reorder = reorder;
    const lifecycle = createDrawerDragLifecycle(adapter);
    const nearStart = favoriteStartFact(43, "snapshot-a");
    const nearSession = lifecycle.start(nearStart);
    lifecycle.move(nearSession, point(nearStart, 50, 30));
    const nearFrameId = [...frames.keys()][0];
    const nearFrame = frames.get(nearFrameId)!;
    frames.delete(nearFrameId);
    nearFrame(0);
    lifecycle.cancel("explicit", nearSession);

    const farStart = favoriteStartFact(44, "snapshot-b");
    const farSession = lifecycle.start(farStart);
    lifecycle.move(farSession, point(farStart, 50, 0));
    const farFrameId = [...frames.keys()][0];
    const farFrame = frames.get(farFrameId)!;
    frames.delete(farFrameId);
    farFrame(0);

    expect(reorder.scrollAmounts[0]).toBeLessThan(0);
    expect(reorder.scrollAmounts[1]).toBeLessThan(reorder.scrollAmounts[0]);
    lifecycle.cancel("explicit", farSession);
    vi.unstubAllGlobals();
  });

  it("cancels a scheduled edge scroll with the drag session", () => {
    const frames = new Map<number, FrameRequestCallback>();
    const cancelled: number[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(1, callback);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      cancelled.push(id);
      frames.delete(id);
    });
    const adapter = new MemoryDrawerDragAdapter();
    const reorder = new MemoryDrawerReorderAdapter();
    reorder.geometry = {
      ...reorder.geometry,
      list: { left: 0, top: 0, right: 100, bottom: 400 },
    };
    adapter.reorder = reorder;
    const lifecycle = createDrawerDragLifecycle(adapter);
    const start = favoriteStartFact(27, "snapshot-a");

    const session = lifecycle.start(start);
    lifecycle.move(session, point(start, 50, 390));
    expect(frames.has(1)).toBe(true);

    expect(lifecycle.cancel("explicit", session)).toBe("cancelled");
    expect(cancelled).toEqual([1]);
    expect(frames.size).toBe(0);
    expect(reorder.states[reorder.states.length - 1]).toMatchObject({ active: false });
  });

  it("reloads a late successful reorder without clearing its replacement session", async () => {
    const adapter = new MemoryDrawerDragAdapter();
    const reorder = new MemoryDrawerReorderAdapter();
    const commit = deferred<void>();
    reorder.commitGate = commit.promise;
    adapter.reorder = reorder;
    const lifecycle = createDrawerDragLifecycle(adapter);
    const staleStart = favoriteStartFact(20, "snapshot-d");
    const currentStart = favoriteStartFact(21, "snapshot-c");

    const staleSession = lifecycle.start(staleStart);
    const staleEnd = lifecycle.end(staleSession, point(staleStart, 50, 125));
    await Promise.resolve();
    lifecycle.start(currentStart);
    commit.resolve();

    await expect(staleEnd).resolves.toBeNull();
    expect(reorder.successes).toEqual(["drawer-a"]);
    expect(reorder.states[reorder.states.length - 1]).toMatchObject({
      active: true,
    });
  });

  it("rejects late reorder moves and ends from a replaced session", async () => {
    const adapter = new MemoryDrawerDragAdapter();
    const reorder = new MemoryDrawerReorderAdapter();
    adapter.reorder = reorder;
    const lifecycle = createDrawerDragLifecycle(adapter);
    const staleStart = favoriteStartFact(28, "snapshot-d");
    const currentStart = favoriteStartFact(29, "snapshot-c");

    const staleSession = lifecycle.start(staleStart);
    lifecycle.start(currentStart);
    const stateCount = reorder.states.length;
    lifecycle.move(staleSession, point(staleStart, 50, 125));

    await expect(lifecycle.end(staleSession, point(staleStart, 50, 125))).resolves.toBeNull();
    expect(lifecycle.cancel("explicit", staleSession)).toBeNull();
    expect(reorder.states).toHaveLength(stateCount);
    expect(reorder.commits).toEqual([]);
  });

  it.each([
    {
      label: "first",
      movedId: "snapshot-d",
      y: 0,
      beforeId: "snapshot-a",
      expected: ["snapshot-d", "snapshot-a", "snapshot-b", "snapshot-c"],
    },
    {
      label: "middle",
      movedId: "snapshot-a",
      y: 200,
      beforeId: "snapshot-c",
      expected: ["snapshot-b", "snapshot-a", "snapshot-c", "snapshot-d"],
    },
    {
      label: "last",
      movedId: "snapshot-a",
      y: 300,
      beforeId: "snapshot-d",
      expected: ["snapshot-b", "snapshot-c", "snapshot-a", "snapshot-d"],
    },
    {
      label: "list-end",
      movedId: "snapshot-a",
      y: 450,
      beforeId: null,
      expected: ["snapshot-b", "snapshot-c", "snapshot-d", "snapshot-a"],
    },
  ])("commits the $label insertion position through the lifecycle", async ({
    movedId,
    y,
    beforeId,
    expected,
  }) => {
    const adapter = new MemoryDrawerDragAdapter();
    const reorder = new MemoryDrawerReorderAdapter();
    adapter.reorder = reorder;
    const lifecycle = createDrawerDragLifecycle(adapter);
    const start = favoriteStartFact(22, movedId);

    const session = lifecycle.start(start);
    lifecycle.move(session, point(start, 50, y));

    expect(reorder.states[reorder.states.length - 1]).toMatchObject({
      active: true,
      inside: true,
      beforeId,
    });
    await expect(lifecycle.end(session, point(start, 50, y))).resolves.toBe("success");
    expect(reorder.commits).toEqual([{
      collectionId: "drawer-a",
      orderedItemIds: expected,
    }]);
  });

  it.each([
    { label: "search", projection: "search" as const },
    { label: "non-All filter", projection: "filter" as const },
  ])(
    "does not persist a reorder while $label is active",
    async ({ projection }) => {
      const adapter = new MemoryDrawerDragAdapter();
      const reorder = new MemoryDrawerReorderAdapter();
      reorder.projection = projection;
      adapter.reorder = reorder;
      adapter.collectionId = null;
      const lifecycle = createDrawerDragLifecycle(adapter);
      const start = favoriteStartFact(23, "snapshot-a");

      const session = lifecycle.start(start);
      await resolveMembership(adapter, start, []);
      await expect(lifecycle.end(session, point(start, 50, 200))).resolves.toBe("no-op");

      expect(reorder.commits).toEqual([]);
    },
  );

  it("treats the current insertion position as a reorder no-op", async () => {
    const adapter = new MemoryDrawerDragAdapter();
    const reorder = new MemoryDrawerReorderAdapter();
    adapter.reorder = reorder;
    adapter.collectionId = "drawer-b";
    const lifecycle = createDrawerDragLifecycle(adapter);
    const start = favoriteStartFact(24, "snapshot-b");

    const session = lifecycle.start(start);
    await expect(lifecycle.end(session, point(start, 50, 200))).resolves.toBe("no-op");

    expect(reorder.commits).toEqual([]);
    expect(adapter.commits).toEqual([]);
    expect(adapter.finishedVisualReasons).toEqual(["item-reorder"]);
    expect(reorder.states[reorder.states.length - 1]).toEqual({
      active: false,
      inside: false,
      beforeId: null,
    });
  });

  it("awaits authoritative reload before completing a successful reorder", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    const cancelled: number[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(1, callback);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      cancelled.push(id);
      frames.delete(id);
    });
    const adapter = new MemoryDrawerDragAdapter();
    const reorder = new MemoryDrawerReorderAdapter();
    reorder.geometry = {
      ...reorder.geometry,
      list: { left: 0, top: 0, right: 100, bottom: 400 },
    };
    const recovery = deferred<void>();
    reorder.successRecovery = recovery.promise;
    adapter.reorder = reorder;
    const lifecycle = createDrawerDragLifecycle(adapter);
    const start = favoriteStartFact(25, "snapshot-d");
    let settled = false;

    const session = lifecycle.start(start);
    expect(frames.has(1)).toBe(true);
    const outcome = lifecycle.end(session, point(start, 50, 125)).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();

    expect(reorder.successes).toEqual(["drawer-a"]);
    expect(cancelled).toEqual([1]);
    expect(frames.size).toBe(0);
    expect(settled).toBe(false);
    recovery.resolve();
    await expect(outcome).resolves.toBe("success");
    expectClean(adapter, "drawer-row-snapshot-d");
  });

  it("fails and cleans up when authoritative reload rejects after item reorder", async () => {
    const adapter = new MemoryDrawerDragAdapter();
    const reorder = new MemoryDrawerReorderAdapter();
    const error = new Error("reload rejected");
    reorder.successRecovery = Promise.reject(error);
    adapter.reorder = reorder;
    const lifecycle = createDrawerDragLifecycle(adapter);
    const start = favoriteStartFact(26, "snapshot-d");
    const session = lifecycle.start(start);

    await expect(lifecycle.end(session, point(start, 50, 125))).resolves.toBe("failed");

    expect(reorder.commits).toHaveLength(1);
    expect(reorder.failures).toEqual([error]);
    expectClean(adapter, "drawer-row-snapshot-d");
  });

  it("shows failure, reloads authoritative order, and clears reorder feedback", async () => {
    const adapter = new MemoryDrawerDragAdapter();
    const reorder = new MemoryDrawerReorderAdapter();
    const error = new Error("reorder rejected");
    const recovery = deferred<void>();
    reorder.commitError = error;
    reorder.failureRecovery = recovery.promise;
    adapter.reorder = reorder;
    const lifecycle = createDrawerDragLifecycle(adapter);
    const start = favoriteStartFact(26, "snapshot-d");
    let settled = false;

    const session = lifecycle.start(start);
    const outcome = lifecycle.end(session, point(start, 50, 125)).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();

    expect(reorder.failures).toEqual([error]);
    expect(reorder.successes).toEqual([]);
    expect(settled).toBe(false);
    expectClean(adapter, "drawer-row-snapshot-d");
    recovery.resolve();
    await expect(outcome).resolves.toBe("failed");
  });

  it("commits a History Clip once and cleans every terminal visual", async () => {
    const adapter = new MemoryDrawerDragAdapter();
    const lifecycle = createDrawerDragLifecycle(adapter);
    const start = startFact(1);

    const session = lifecycle.start(start);
    lifecycle.move(session, point(start, 30, 40));
    await resolveMembership(adapter, start, []);

    const firstEnd = lifecycle.end(session, point(start, 50, 60));
    const duplicateEnd = lifecycle.end(session, point(start, 50, 60));
    await expect(duplicateEnd).resolves.toBeNull();
    await expect(firstEnd).resolves.toBe("success");
    expect(adapter.commits).toEqual([{ collectionId: "drawer-a", locatorId: "clip-1" }]);
    expect(adapter.successes).toEqual(["drawer-a"]);
    expect(adapter.finishedVisuals).toEqual(["success"]);
    expectClean(adapter, "row-1");
  });

  it("copies one Drawer snapshot into different collections without changing its source membership", async () => {
    const adapter = new MemoryDrawerDragAdapter();
    const lifecycle = createDrawerDragLifecycle(adapter);
    const firstCopy = favoriteStartFact(11, "snapshot-a");

    adapter.collectionId = "drawer-b";
    const firstSession = lifecycle.start(firstCopy);
    await resolveMembership(adapter, firstCopy, ["drawer-a"]);
    await expect(lifecycle.end(firstSession, point(firstCopy))).resolves.toBe("success");

    const secondCopy = favoriteStartFact(12, "snapshot-a");
    adapter.collectionId = "drawer-c";
    const secondSession = lifecycle.start(secondCopy);
    await resolveMembership(adapter, secondCopy, ["drawer-a", "drawer-b"]);
    await expect(lifecycle.end(secondSession, point(secondCopy))).resolves.toBe("success");

    expect(adapter.commits).toEqual([
      { collectionId: "drawer-b", locatorId: "snapshot-a" },
      { collectionId: "drawer-c", locatorId: "snapshot-a" },
    ]);
  });

  it("marks an existing membership unavailable without mutation", async () => {
    const adapter = new MemoryDrawerDragAdapter();
    const lifecycle = createDrawerDragLifecycle(adapter);
    const start = startFact(2);

    const session = lifecycle.start(start);
    await resolveMembership(adapter, start, ["drawer-a"]);
    expect(adapter.targetStates[adapter.targetStates.length - 1]).toMatchObject({
      active: true,
      membershipReady: true,
      targetId: null,
    });

    await expect(lifecycle.end(session, point(start))).resolves.toBe("unavailable");
    expect(adapter.commits).toEqual([]);
    expect(adapter.unavailable).toEqual(["drawer-a"]);
    expectClean(adapter, "row-2");
  });

  it("does not copy a Drawer snapshot into a collection that already contains it", async () => {
    const adapter = new MemoryDrawerDragAdapter();
    const lifecycle = createDrawerDragLifecycle(adapter);
    const start = favoriteStartFact(15, "snapshot-member");

    const session = lifecycle.start(start);
    await resolveMembership(adapter, start, ["drawer-a"]);

    await expect(lifecycle.end(session, point(start))).resolves.toBe("unavailable");
    expect(adapter.commits).toEqual([]);
    expect(adapter.unavailable).toEqual(["drawer-a"]);
    expectClean(adapter, "drawer-row-snapshot-member");
  });

  it("treats a drop outside Drawer collections as a no-op", async () => {
    const adapter = new MemoryDrawerDragAdapter();
    adapter.collectionId = null;
    const lifecycle = createDrawerDragLifecycle(adapter);
    const start = startFact(3);

    const session = lifecycle.start(start);
    await resolveMembership(adapter, start, []);

    await expect(lifecycle.end(session, point(start))).resolves.toBe("no-op");
    expect(adapter.commits).toEqual([]);
    expect(adapter.finishedVisuals).toEqual(["no-op"]);
    expectClean(adapter, "row-3");
  });

  it("invalidates late membership, move, end, and cancel from a replaced session", async () => {
    const adapter = new MemoryDrawerDragAdapter();
    const lifecycle = createDrawerDragLifecycle(adapter);
    const oldStart = startFact(4);
    const freshStart = startFact(5);

    const oldSession = lifecycle.start(oldStart);
    const freshSession = lifecycle.start(freshStart);
    const stateCountAfterReplacement = adapter.targetStates.length;
    await resolveMembership(adapter, oldStart, []);
    lifecycle.move(oldSession, point(oldStart, 99, 99));
    await expect(lifecycle.end(oldSession, point(oldStart))).resolves.toBeNull();
    expect(lifecycle.cancel("explicit", oldSession)).toBeNull();

    expect(adapter.targetStates).toHaveLength(stateCountAfterReplacement);
    expect(adapter.commits).toEqual([]);
    expect(adapter.finishedVisuals).toEqual(["replaced"]);

    await resolveMembership(adapter, freshStart, []);
    await expect(lifecycle.end(freshSession, point(freshStart))).resolves.toBe("success");
    expect(adapter.commits).toEqual([{ collectionId: "drawer-a", locatorId: "clip-5" }]);
  });

  it("does not let a pending Drawer item end commit after a new session starts", async () => {
    const adapter = new MemoryDrawerDragAdapter();
    const lifecycle = createDrawerDragLifecycle(adapter);
    const staleStart = favoriteStartFact(13, "snapshot-stale");
    const currentStart = favoriteStartFact(14, "snapshot-current");

    const staleSession = lifecycle.start(staleStart);
    const staleEnd = lifecycle.end(staleSession, point(staleStart));
    const currentSession = lifecycle.start(currentStart);
    await resolveMembership(adapter, staleStart, []);

    await expect(staleEnd).resolves.toBeNull();
    expect(adapter.commits).toEqual([]);

    await resolveMembership(adapter, currentStart, []);
    await expect(lifecycle.end(currentSession, point(currentStart))).resolves.toBe("success");
    expect(adapter.commits).toEqual([
      { collectionId: "drawer-a", locatorId: "snapshot-current" },
    ]);
  });

  it("recovers a late mutation failure without clearing the replacement session", async () => {
    const adapter = new MemoryDrawerDragAdapter();
    const lifecycle = createDrawerDragLifecycle(adapter);
    const staleStart = favoriteStartFact(16, "snapshot-stale-commit");
    const currentStart = favoriteStartFact(17, "snapshot-current");
    const commit = deferred<void>();
    const error = new Error("late mutation rejection");
    adapter.commitGate = commit.promise;

    const staleSession = lifecycle.start(staleStart);
    await resolveMembership(adapter, staleStart, []);
    const staleEnd = lifecycle.end(staleSession, point(staleStart));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adapter.commits).toEqual([
      { collectionId: "drawer-a", locatorId: "snapshot-stale-commit" },
    ]);

    lifecycle.start(currentStart);
    commit.reject(error);

    await expect(staleEnd).resolves.toBeNull();
    expect(adapter.failures).toEqual([error]);
    expect(adapter.targetStates[adapter.targetStates.length - 1]).toMatchObject({
      active: true,
      membershipReady: false,
    });
    expect(adapter.releasedSources).toContain("drawer-row-snapshot-stale-commit");
    expect(adapter.finishedVisuals).toEqual(["replaced"]);
  });

  it.each<DrawerDragCancelReason>([
    "pointercancel",
    "lostpointercapture",
    "window-blur",
    "explicit",
  ])("uses the same idempotent cleanup for %s", (reason) => {
    const adapter = new MemoryDrawerDragAdapter();
    const lifecycle = createDrawerDragLifecycle(adapter);
    const start = startFact(6);

    const session = lifecycle.start(start);
    expect(lifecycle.cancel(reason, session)).toBe("cancelled");
    expect(lifecycle.cancel(reason, session)).toBeNull();

    expect(adapter.transientCleanupCount).toBe(1);
    expect(adapter.finishedVisuals).toEqual(["cancelled"]);
    expect(adapter.commits).toEqual([]);
    expectClean(adapter, "row-6");
  });

  it("fails closed when authoritative membership lookup fails", async () => {
    const adapter = new MemoryDrawerDragAdapter();
    const lifecycle = createDrawerDragLifecycle(adapter);
    const start = startFact(8);
    const error = new Error("membership unavailable");

    const session = lifecycle.start(start);
    adapter.memberships.get(start.locator.id)!.reject(error);

    await expect(lifecycle.end(session, point(start))).resolves.toBe("failed");
    expect(adapter.commits).toEqual([]);
    expect(adapter.failures).toEqual([error]);
    expectClean(adapter, "row-8");
  });

  it("cleans a failed mutation and awaits authoritative recovery", async () => {
    const adapter = new MemoryDrawerDragAdapter();
    const lifecycle = createDrawerDragLifecycle(adapter);
    const start = favoriteStartFact(9, "snapshot-failure");
    const error = new Error("mutation rejected");
    const recovery = deferred<void>();
    adapter.commitError = error;
    adapter.failureRecovery = recovery.promise;

    const session = lifecycle.start(start);
    await resolveMembership(adapter, start, []);
    let settled = false;
    const outcome = lifecycle.end(session, point(start)).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(adapter.failures).toEqual([error]);
    expectClean(adapter, "drawer-row-snapshot-failure");
    expect(settled).toBe(false);

    recovery.resolve();
    await expect(outcome).resolves.toBe("failed");
  });

  it.each<DrawerDragVisual>([
    { kind: "Text", preview: "selected text", thumbnailBase64: null },
    { kind: "Image", preview: "image", thumbnailBase64: "data:image/jpeg;base64,thumb" },
    { kind: "FilePaths", preview: "C:\\notes.txt", thumbnailBase64: null },
  ])("passes the $kind visual once while moves stay lightweight", (visual) => {
    const adapter = new MemoryDrawerDragAdapter();
    const lifecycle = createDrawerDragLifecycle(adapter);
    const start = startFact(10, visual);

    const session = lifecycle.start(start);
    lifecycle.move(session, point(start, 40, 50));

    expect(adapter.begunVisuals).toHaveLength(1);
    expect(adapter.begunVisuals[0].visual).toEqual(visual);
    expect(adapter.movedVisuals).toEqual([{
      locator: start.locator,
      x: 40,
      y: 50,
    }]);
  });
});
