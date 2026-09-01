import { describe, expect, it } from "vitest";
import {
  createDrawerDragLifecycle,
} from "./drawer-drag";
import type {
  DrawerDragAdapter,
  DrawerDragCancelReason,
  DrawerDragStart,
  DrawerDragTargetState,
  DrawerDragTerminalOutcome,
} from "./drawer-drag";
import type { ItemDragPoint, ItemDragStart, ItemDragVisual } from "./drag";

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
  sessionId: number,
  visual: ItemDragVisual = { kind: "Text", preview: "clip", thumbnailBase64: null },
): DrawerDragStart<string> {
  return {
    sessionId,
    locator: { scope: "history", id: `clip-${sessionId}` },
    visual,
    x: 10,
    y: 20,
    source: `row-${sessionId}`,
  };
}

function favoriteStartFact(sessionId: number, snapshotId: string): DrawerDragStart<string> {
  return {
    ...startFact(sessionId),
    locator: { scope: "favorite", id: snapshotId },
    source: `drawer-row-${snapshotId}`,
  };
}

function point(start: ItemDragStart, x = start.x, y = start.y): ItemDragPoint {
  return {
    sessionId: start.sessionId,
    locator: start.locator,
    x,
    y,
  };
}

class MemoryDrawerDragAdapter implements DrawerDragAdapter<string> {
  readonly memberships = new Map<number, ReturnType<typeof deferred<readonly string[]>>>();
  readonly targetStates: DrawerDragTargetState[] = [];
  readonly activatedSources: string[] = [];
  readonly releasedSources: string[] = [];
  readonly begunVisuals: ItemDragStart[] = [];
  readonly movedVisuals: ItemDragPoint[] = [];
  readonly finishedVisuals: DrawerDragTerminalOutcome[] = [];
  readonly finishedVisualReasons: Array<DrawerDragCancelReason | undefined> = [];
  readonly commits: Array<{ collectionId: string; locatorId: string }> = [];
  readonly unavailable: string[] = [];
  readonly successes: string[] = [];
  readonly failures: unknown[] = [];
  collectionId: string | null = "drawer-a";
  commitError: unknown | null = null;
  failureRecovery: Promise<void> | null = null;
  transientCleanupCount = 0;
  indicatorVisible = false;
  frameScheduled = false;

  lookupMembership(start: ItemDragStart): Promise<readonly string[]> {
    const request = deferred<readonly string[]>();
    this.memberships.set(start.sessionId, request);
    return request.promise;
  }

  collectionAt(_point: ItemDragPoint): string | null {
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

  beginVisual(start: ItemDragStart): void {
    this.begunVisuals.push(start);
  }

  moveVisual(nextPoint: ItemDragPoint): void {
    this.movedVisuals.push(nextPoint);
  }

  finishVisual(
    outcome: DrawerDragTerminalOutcome,
    reason?: DrawerDragCancelReason,
  ): void {
    this.finishedVisuals.push(outcome);
    this.finishedVisualReasons.push(reason);
  }

  clearTransientFeedback(): void {
    this.transientCleanupCount += 1;
    this.indicatorVisible = false;
    this.frameScheduled = false;
  }

  async commit(collectionId: string, start: ItemDragStart): Promise<void> {
    this.commits.push({ collectionId, locatorId: start.locator.id });
    if (this.commitError !== null) throw this.commitError;
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
  sessionId: number,
  ids: readonly string[],
): Promise<void> {
  adapter.memberships.get(sessionId)!.resolve(ids);
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

describe("Drawer drag lifecycle", () => {
  it("commits a History Clip once and cleans every terminal visual", async () => {
    const adapter = new MemoryDrawerDragAdapter();
    const lifecycle = createDrawerDragLifecycle(adapter);
    const start = startFact(1);

    lifecycle.start(start);
    lifecycle.move(point(start, 30, 40));
    await resolveMembership(adapter, 1, []);

    const firstEnd = lifecycle.end(point(start, 50, 60));
    const duplicateEnd = lifecycle.end(point(start, 50, 60));
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
    lifecycle.start(firstCopy);
    await resolveMembership(adapter, 11, ["drawer-a"]);
    await expect(lifecycle.end(point(firstCopy))).resolves.toBe("success");

    const secondCopy = favoriteStartFact(12, "snapshot-a");
    adapter.collectionId = "drawer-c";
    lifecycle.start(secondCopy);
    await resolveMembership(adapter, 12, ["drawer-a", "drawer-b"]);
    await expect(lifecycle.end(point(secondCopy))).resolves.toBe("success");

    expect(adapter.commits).toEqual([
      { collectionId: "drawer-b", locatorId: "snapshot-a" },
      { collectionId: "drawer-c", locatorId: "snapshot-a" },
    ]);
  });

  it("marks an existing membership unavailable without mutation", async () => {
    const adapter = new MemoryDrawerDragAdapter();
    const lifecycle = createDrawerDragLifecycle(adapter);
    const start = startFact(2);

    lifecycle.start(start);
    await resolveMembership(adapter, 2, ["drawer-a"]);
    expect(adapter.targetStates[adapter.targetStates.length - 1]).toMatchObject({
      active: true,
      membershipReady: true,
      targetId: null,
    });

    await expect(lifecycle.end(point(start))).resolves.toBe("unavailable");
    expect(adapter.commits).toEqual([]);
    expect(adapter.unavailable).toEqual(["drawer-a"]);
    expectClean(adapter, "row-2");
  });

  it("does not copy a Drawer snapshot into a collection that already contains it", async () => {
    const adapter = new MemoryDrawerDragAdapter();
    const lifecycle = createDrawerDragLifecycle(adapter);
    const start = favoriteStartFact(15, "snapshot-member");

    lifecycle.start(start);
    await resolveMembership(adapter, 15, ["drawer-a"]);

    await expect(lifecycle.end(point(start))).resolves.toBe("unavailable");
    expect(adapter.commits).toEqual([]);
    expect(adapter.unavailable).toEqual(["drawer-a"]);
    expectClean(adapter, "drawer-row-snapshot-member");
  });

  it("treats a drop outside Drawer collections as a no-op", async () => {
    const adapter = new MemoryDrawerDragAdapter();
    adapter.collectionId = null;
    const lifecycle = createDrawerDragLifecycle(adapter);
    const start = startFact(3);

    lifecycle.start(start);
    await resolveMembership(adapter, 3, []);

    await expect(lifecycle.end(point(start))).resolves.toBe("no-op");
    expect(adapter.commits).toEqual([]);
    expect(adapter.finishedVisuals).toEqual(["no-op"]);
    expectClean(adapter, "row-3");
  });

  it("invalidates late membership, move, end, and cancel from a replaced session", async () => {
    const adapter = new MemoryDrawerDragAdapter();
    const lifecycle = createDrawerDragLifecycle(adapter);
    const oldStart = startFact(4);
    const freshStart = startFact(5);

    lifecycle.start(oldStart);
    lifecycle.start(freshStart);
    const stateCountAfterReplacement = adapter.targetStates.length;
    await resolveMembership(adapter, 4, []);
    lifecycle.move(point(oldStart, 99, 99));
    await expect(lifecycle.end(point(oldStart))).resolves.toBeNull();
    expect(lifecycle.cancel(4, "explicit")).toBeNull();

    expect(adapter.targetStates).toHaveLength(stateCountAfterReplacement);
    expect(adapter.commits).toEqual([]);
    expect(adapter.finishedVisuals).toEqual(["replaced"]);

    await resolveMembership(adapter, 5, []);
    await expect(lifecycle.end(point(freshStart))).resolves.toBe("success");
    expect(adapter.commits).toEqual([{ collectionId: "drawer-a", locatorId: "clip-5" }]);
  });

  it("does not let a pending Drawer item end commit after a new session starts", async () => {
    const adapter = new MemoryDrawerDragAdapter();
    const lifecycle = createDrawerDragLifecycle(adapter);
    const staleStart = favoriteStartFact(13, "snapshot-stale");
    const currentStart = favoriteStartFact(14, "snapshot-current");

    lifecycle.start(staleStart);
    const staleEnd = lifecycle.end(point(staleStart));
    lifecycle.start(currentStart);
    await resolveMembership(adapter, 13, []);

    await expect(staleEnd).resolves.toBeNull();
    expect(adapter.commits).toEqual([]);

    await resolveMembership(adapter, 14, []);
    await expect(lifecycle.end(point(currentStart))).resolves.toBe("success");
    expect(adapter.commits).toEqual([
      { collectionId: "drawer-a", locatorId: "snapshot-current" },
    ]);
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

    lifecycle.start(start);
    expect(lifecycle.cancel(6, reason)).toBe("cancelled");
    expect(lifecycle.cancel(6, reason)).toBeNull();

    expect(adapter.transientCleanupCount).toBe(1);
    expect(adapter.finishedVisuals).toEqual(["cancelled"]);
    expect(adapter.commits).toEqual([]);
    expectClean(adapter, "row-6");
  });

  it("forwards item reorder as the visual completion reason", () => {
    const adapter = new MemoryDrawerDragAdapter();
    const lifecycle = createDrawerDragLifecycle(adapter);
    const start = startFact(7);

    lifecycle.start(start);
    expect(lifecycle.cancel(7, "item-reorder")).toBe("cancelled");

    expect(adapter.finishedVisuals).toEqual(["cancelled"]);
    expect(adapter.finishedVisualReasons).toEqual(["item-reorder"]);
    expectClean(adapter, "row-7");
  });

  it("fails closed when authoritative membership lookup fails", async () => {
    const adapter = new MemoryDrawerDragAdapter();
    const lifecycle = createDrawerDragLifecycle(adapter);
    const start = startFact(8);
    const error = new Error("membership unavailable");

    lifecycle.start(start);
    adapter.memberships.get(8)!.reject(error);

    await expect(lifecycle.end(point(start))).resolves.toBe("failed");
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

    lifecycle.start(start);
    await resolveMembership(adapter, 9, []);
    let settled = false;
    const outcome = lifecycle.end(point(start)).then((result) => {
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

  it.each<ItemDragVisual>([
    { kind: "Text", preview: "selected text", thumbnailBase64: null },
    { kind: "Image", preview: "image", thumbnailBase64: "data:image/jpeg;base64,thumb" },
    { kind: "FilePaths", preview: "C:\\notes.txt", thumbnailBase64: null },
  ])("passes the $kind visual once while moves stay lightweight", (visual) => {
    const adapter = new MemoryDrawerDragAdapter();
    const lifecycle = createDrawerDragLifecycle(adapter);
    const start = startFact(10, visual);

    lifecycle.start(start);
    lifecycle.move(point(start, 40, 50));

    expect(adapter.begunVisuals).toHaveLength(1);
    expect(adapter.begunVisuals[0].visual).toEqual(visual);
    expect(adapter.movedVisuals).toEqual([point(start, 40, 50)]);
  });
});
