import { describe, expect, it, vi } from "vitest";
import type { CollectionSummary } from "./types";
import {
  DrawerViewProjection,
  type DrawerView,
  type DrawerViewSource,
} from "./drawer-view";

class Deferred<T> {
  readonly promise: Promise<T>;
  private resolvePromise!: (value: T) => void;
  private rejectPromise!: (reason: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
    });
  }

  resolve(value: T): void {
    this.resolvePromise(value);
  }

  reject(reason: unknown): void {
    this.rejectPromise(reason);
  }
}

class DeferredDrawerViewSource implements DrawerViewSource {
  readonly calls: string[] = [];
  readonly reads: Deferred<DrawerView>[] = [];
  readonly mutations: Array<{
    readonly name: "toggle" | "setOpen" | "select";
    readonly value?: boolean | string | null;
    readonly completion: Deferred<void>;
  }> = [];
  activeReads = 0;
  maxConcurrentReads = 0;
  onRead: (() => void) | null = null;
  private invalidated: ((generation: number) => void) | null = null;

  async listenInvalidated(listener: (generation: number) => void): Promise<void> {
    this.calls.push("listen");
    this.invalidated = listener;
  }

  read(): Promise<DrawerView> {
    this.calls.push("read");
    const read = new Deferred<DrawerView>();
    this.reads.push(read);
    this.activeReads += 1;
    this.maxConcurrentReads = Math.max(this.maxConcurrentReads, this.activeReads);
    const onRead = this.onRead;
    this.onRead = null;
    onRead?.();
    return read.promise.finally(() => {
      this.activeReads -= 1;
    });
  }

  toggle(): Promise<void> {
    return this.mutate("toggle");
  }

  setOpen(open: boolean): Promise<void> {
    return this.mutate("setOpen", open);
  }

  select(collectionId: string | null): Promise<void> {
    return this.mutate("select", collectionId);
  }

  emitInvalidated(generation: number): void {
    if (!this.invalidated) throw new Error("invalidation listener is not registered");
    this.invalidated(generation);
  }

  private mutate(
    name: "toggle" | "setOpen" | "select",
    value?: boolean | string | null,
  ): Promise<void> {
    this.calls.push(name);
    const completion = new Deferred<void>();
    this.mutations.push({ name, value, completion });
    return completion.promise;
  }
}

function drawerView(generation: number): DrawerView {
  return {
    generation,
    open: false,
    selectedCollection: null,
    collections: [],
    activeSnapshots: [],
  };
}

function collection(id: string): CollectionSummary {
  return {
    id,
    name: id,
    sort_order: 0,
    created_at: 1,
    item_count: 0,
  };
}

describe("DrawerViewProjection startup", () => {
  it("registers invalidation before starting the initial read", async () => {
    const source = new DeferredDrawerViewSource();
    const projection = new DrawerViewProjection(source, vi.fn());

    const startup = projection.startup();

    await vi.waitFor(() => expect(source.calls).toEqual(["listen", "read"]));
    source.reads[0].resolve(drawerView(1));

    await expect(startup).resolves.toEqual(drawerView(1));
    expect(projection.currentView).toEqual(drawerView(1));
  });

  it("retries a failed initial read through the stale path without another listener", async () => {
    const source = new DeferredDrawerViewSource();
    const projection = new DrawerViewProjection(source, vi.fn());
    const failure = new Error("drawer unavailable");

    const firstStartup = projection.startup();
    await vi.waitFor(() => expect(source.reads).toHaveLength(1));
    source.reads[0].reject(failure);

    await expect(firstStartup).rejects.toBe(failure);
    expect(projection.currentView).toBeNull();

    const retry = projection.retryIfStale();
    await vi.waitFor(() => expect(source.reads).toHaveLength(2));
    source.reads[1].resolve(drawerView(2));

    await expect(retry).resolves.toEqual(drawerView(2));
    expect(source.calls.filter((call) => call === "listen")).toHaveLength(1);
  });

  it("retries listener registration when registration itself did not complete", async () => {
    const read = new Deferred<DrawerView>();
    const failure = new Error("listener registration failed");
    let listenerAttempts = 0;
    let reads = 0;
    const source: DrawerViewSource = {
      listenInvalidated() {
        listenerAttempts += 1;
        if (listenerAttempts === 1) throw failure;
        return Promise.resolve();
      },
      read() {
        reads += 1;
        return read.promise;
      },
      toggle() {
        return Promise.resolve();
      },
      setOpen() {
        return Promise.resolve();
      },
      select() {
        return Promise.resolve();
      },
    };
    const projection = new DrawerViewProjection(source, vi.fn());

    await expect(projection.startup()).rejects.toBe(failure);
    const retry = projection.startup();
    await vi.waitFor(() => expect(reads).toBe(1));
    read.resolve(drawerView(1));

    await expect(retry).resolves.toEqual(drawerView(1));
    expect(listenerAttempts).toBe(2);
  });
});

describe("DrawerViewProjection subscriptions", () => {
  it("immediately replays the current view with a null previous view", async () => {
    const source = new DeferredDrawerViewSource();
    const projection = new DrawerViewProjection(source, vi.fn());
    const current = drawerView(3);
    const subscriber = vi.fn();
    const startup = projection.startup();
    await vi.waitFor(() => expect(source.reads).toHaveLength(1));
    source.reads[0].resolve(current);
    await startup;

    projection.subscribe(subscriber);

    expect(subscriber).toHaveBeenCalledOnce();
    expect(subscriber).toHaveBeenCalledWith(current, null);
  });

  it("owns the arrays exposed by the current view", async () => {
    const source = new DeferredDrawerViewSource();
    const projection = new DrawerViewProjection(source, vi.fn());
    const collections = [collection("drawer-a")];
    const supplied = { ...drawerView(1), collections };
    const startup = projection.startup();
    await vi.waitFor(() => expect(source.reads).toHaveLength(1));
    source.reads[0].resolve(supplied);
    await startup;

    collections.push(collection("drawer-b"));

    expect(projection.currentView?.collections).toEqual([collection("drawer-a")]);
    expect(projection.currentView?.collections).not.toBe(supplied.collections);
    expect(projection.currentView?.activeSnapshots).not.toBe(supplied.activeSnapshots);
  });

  it("publishes a higher invalidated generation with its coherent previous view", async () => {
    const source = new DeferredDrawerViewSource();
    const projection = new DrawerViewProjection(source, vi.fn());
    const first = drawerView(1);
    const second = { ...drawerView(2), open: true };
    const startup = projection.startup();
    await vi.waitFor(() => expect(source.reads).toHaveLength(1));
    source.reads[0].resolve(first);
    await startup;
    const subscriber = vi.fn();
    projection.subscribe(subscriber);
    subscriber.mockClear();

    source.emitInvalidated(2);
    await vi.waitFor(() => expect(source.reads).toHaveLength(2));
    source.reads[1].resolve(second);
    await vi.waitFor(() => expect(subscriber).toHaveBeenCalledOnce());

    expect(subscriber).toHaveBeenCalledWith(second, first);
    expect(projection.currentView).toEqual(second);
  });

  it("isolates a failing subscriber from later subscribers", async () => {
    const source = new DeferredDrawerViewSource();
    const projection = new DrawerViewProjection(source, vi.fn());
    const startup = projection.startup();
    await vi.waitFor(() => expect(source.reads).toHaveLength(1));
    source.reads[0].resolve(drawerView(1));
    await startup;
    const failing = vi.fn(() => {
      throw new Error("renderer failed");
    });
    const succeeding = vi.fn();
    projection.subscribe(failing);
    projection.subscribe(succeeding);
    failing.mockClear();
    succeeding.mockClear();

    source.emitInvalidated(2);
    await vi.waitFor(() => expect(source.reads).toHaveLength(2));
    source.reads[1].resolve(drawerView(2));
    await vi.waitFor(() => expect(succeeding).toHaveBeenCalledOnce());

    expect(failing).toHaveBeenCalledOnce();
    expect(succeeding).toHaveBeenCalledWith(drawerView(2), drawerView(1));
  });
});

describe("DrawerViewProjection invalidation freshness", () => {
  it("prevents synchronous invalidation from reentering the read pump", async () => {
    const source = new DeferredDrawerViewSource();
    const projection = new DrawerViewProjection(source, vi.fn());
    source.onRead = () => source.emitInvalidated(2);

    const startup = projection.startup();
    await vi.waitFor(() => expect(source.calls).toContain("read"));

    expect(source.reads).toHaveLength(1);
    expect(source.maxConcurrentReads).toBe(1);

    source.reads[0].resolve(drawerView(1));
    await expect(startup).resolves.toEqual(drawerView(1));
    await vi.waitFor(() => expect(source.reads).toHaveLength(2));
    expect(source.maxConcurrentReads).toBe(1);
    source.reads[1].resolve(drawerView(2));
    await vi.waitFor(() => expect(projection.currentView).toEqual(drawerView(2)));
  });

  it("coalesces a burst and rejects an older completion with one trailing read", async () => {
    const source = new DeferredDrawerViewSource();
    const projection = new DrawerViewProjection(source, vi.fn());
    const startup = projection.startup();
    await vi.waitFor(() => expect(source.reads).toHaveLength(1));
    source.reads[0].resolve(drawerView(1));
    await startup;
    const subscriber = vi.fn();
    projection.subscribe(subscriber);
    subscriber.mockClear();

    source.emitInvalidated(2);
    await vi.waitFor(() => expect(source.reads).toHaveLength(2));
    source.emitInvalidated(3);
    source.emitInvalidated(4);
    expect(source.reads).toHaveLength(2);

    source.reads[1].resolve(drawerView(0));
    await vi.waitFor(() => expect(source.reads).toHaveLength(3));
    expect(projection.currentView).toEqual(drawerView(1));
    expect(subscriber).not.toHaveBeenCalled();
    expect(source.maxConcurrentReads).toBe(1);

    source.reads[2].resolve(drawerView(4));
    await vi.waitFor(() => expect(projection.currentView).toEqual(drawerView(4)));

    expect(source.reads).toHaveLength(3);
    expect(subscriber).toHaveBeenCalledOnce();
    expect(subscriber).toHaveBeenCalledWith(drawerView(4), drawerView(1));
  });
});

describe("DrawerViewProjection refresh barriers", () => {
  it("starts a trailing read when refresh is requested during an older read", async () => {
    const source = new DeferredDrawerViewSource();
    const projection = new DrawerViewProjection(source, vi.fn());
    const startup = projection.startup();
    await vi.waitFor(() => expect(source.reads).toHaveLength(1));
    source.reads[0].resolve(drawerView(1));
    await startup;
    const subscriber = vi.fn();
    projection.subscribe(subscriber);
    subscriber.mockClear();

    source.emitInvalidated(2);
    await vi.waitFor(() => expect(source.reads).toHaveLength(2));
    const refresh = projection.refresh();
    let refreshSettled = false;
    void refresh.finally(() => {
      refreshSettled = true;
    });

    source.reads[1].resolve(drawerView(2));
    await vi.waitFor(() => expect(source.reads).toHaveLength(3));
    expect(refreshSettled).toBe(false);

    source.reads[2].resolve(drawerView(2));
    await expect(refresh).resolves.toEqual(drawerView(2));
    expect(subscriber).toHaveBeenCalledOnce();
    expect(subscriber).toHaveBeenCalledWith(drawerView(2), drawerView(1));
  });

  it("preserves the last view after failure and retries only while stale", async () => {
    const source = new DeferredDrawerViewSource();
    const reportDiagnostic = vi.fn();
    const projection = new DrawerViewProjection(source, reportDiagnostic);
    const startup = projection.startup();
    await vi.waitFor(() => expect(source.reads).toHaveLength(1));
    source.reads[0].resolve(drawerView(1));
    await startup;
    const failure = new Error("refresh failed");

    const failedRefresh = projection.refresh();
    await vi.waitFor(() => expect(source.reads).toHaveLength(2));
    source.reads[1].reject(failure);

    await expect(failedRefresh).rejects.toBe(failure);
    expect(projection.currentView).toEqual(drawerView(1));
    expect(reportDiagnostic).not.toHaveBeenCalled();

    const retry = projection.retryIfStale();
    await vi.waitFor(() => expect(source.reads).toHaveLength(3));
    source.reads[2].resolve(drawerView(1));
    await expect(retry).resolves.toEqual(drawerView(1));

    await expect(projection.retryIfStale()).resolves.toEqual(drawerView(1));
    expect(source.reads).toHaveLength(3);
  });

  it("reports background failures and leaves the stale view retryable", async () => {
    const source = new DeferredDrawerViewSource();
    const reportDiagnostic = vi.fn();
    const projection = new DrawerViewProjection(source, reportDiagnostic);
    const startup = projection.startup();
    await vi.waitFor(() => expect(source.reads).toHaveLength(1));
    source.reads[0].resolve(drawerView(1));
    await startup;
    const failure = new Error("background read failed");

    source.emitInvalidated(2);
    await vi.waitFor(() => expect(source.reads).toHaveLength(2));
    source.reads[1].reject(failure);
    await vi.waitFor(() => expect(reportDiagnostic).toHaveBeenCalledWith(failure));

    expect(projection.currentView).toEqual(drawerView(1));
    const retry = projection.retryIfStale();
    await vi.waitFor(() => expect(source.reads).toHaveLength(3));
    source.reads[2].resolve(drawerView(2));

    await expect(retry).resolves.toEqual(drawerView(2));
  });
});

describe("DrawerViewProjection intents", () => {
  it("runs toggle, explicit open, and selection through one FIFO queue", async () => {
    const source = new DeferredDrawerViewSource();
    const projection = new DrawerViewProjection(source, vi.fn());

    const toggle = projection.toggle();
    const setOpen = projection.setOpen(true);
    const select = projection.select("drawer-a");

    await vi.waitFor(() => expect(source.reads).toHaveLength(1));
    expect(source.mutations).toHaveLength(0);
    source.reads[0].resolve(drawerView(1));

    await vi.waitFor(() => expect(source.mutations).toHaveLength(1));
    expect(source.mutations[0]).toMatchObject({ name: "toggle" });
    source.mutations[0].completion.resolve();
    await vi.waitFor(() => expect(source.reads).toHaveLength(2));
    expect(source.mutations).toHaveLength(1);
    source.reads[1].resolve({ ...drawerView(2), open: true });
    await expect(toggle).resolves.toEqual({
      status: "published",
      view: { ...drawerView(2), open: true },
    });

    await vi.waitFor(() => expect(source.mutations).toHaveLength(2));
    expect(source.mutations[1]).toMatchObject({ name: "setOpen", value: true });
    source.mutations[1].completion.resolve();
    await vi.waitFor(() => expect(source.reads).toHaveLength(3));
    source.reads[2].resolve({ ...drawerView(3), open: true });
    await expect(setOpen).resolves.toEqual({
      status: "published",
      view: { ...drawerView(3), open: true },
    });

    await vi.waitFor(() => expect(source.mutations).toHaveLength(3));
    expect(source.mutations[2]).toMatchObject({ name: "select", value: "drawer-a" });
    source.mutations[2].completion.resolve();
    await vi.waitFor(() => expect(source.reads).toHaveLength(4));
    const selected = {
      ...drawerView(4),
      open: true,
      selectedCollection: "drawer-a",
    };
    source.reads[3].resolve(selected);

    await expect(select).resolves.toEqual({ status: "published", view: selected });
    expect(source.calls).toEqual([
      "listen",
      "read",
      "toggle",
      "read",
      "setOpen",
      "read",
      "select",
      "read",
    ]);
  });

  it("continues after a rejected command without retrying that mutation", async () => {
    const source = new DeferredDrawerViewSource();
    const projection = new DrawerViewProjection(source, vi.fn());
    const startup = projection.startup();
    await vi.waitFor(() => expect(source.reads).toHaveLength(1));
    source.reads[0].resolve(drawerView(1));
    await startup;
    const failure = new Error("Collection not found");

    const rejected = projection.select("missing");
    const rejectedAssertion = expect(rejected).rejects.toBe(failure);
    const recovered = projection.toggle();
    await vi.waitFor(() => expect(source.mutations).toHaveLength(1));
    source.mutations[0].completion.reject(failure);

    await rejectedAssertion;
    await vi.waitFor(() => expect(source.mutations).toHaveLength(2));
    expect(source.mutations.map(({ name }) => name)).toEqual(["select", "toggle"]);
    source.mutations[1].completion.resolve();
    await vi.waitFor(() => expect(source.reads).toHaveLength(2));
    source.reads[1].resolve({ ...drawerView(2), open: true });

    await expect(recovered).resolves.toEqual({
      status: "published",
      view: { ...drawerView(2), open: true },
    });
    expect(source.mutations).toHaveLength(2);
  });

  it("returns committed-stale when the command commits but its barrier refresh fails", async () => {
    const source = new DeferredDrawerViewSource();
    const projection = new DrawerViewProjection(source, vi.fn());
    const initial = drawerView(1);
    const startup = projection.startup();
    await vi.waitFor(() => expect(source.reads).toHaveLength(1));
    source.reads[0].resolve(initial);
    await startup;
    const refreshFailure = new Error("refresh failed after commit");

    const intent = projection.setOpen(true);
    await vi.waitFor(() => expect(source.mutations).toHaveLength(1));
    source.mutations[0].completion.resolve();
    await vi.waitFor(() => expect(source.reads).toHaveLength(2));
    source.reads[1].reject(refreshFailure);

    await expect(intent).resolves.toEqual({
      status: "committed-stale",
      view: initial,
      error: refreshFailure,
    });
    expect(projection.currentView).toEqual(initial);
  });

  it("rejects an unavailable backend before mutation and remains retryable", async () => {
    const source = new DeferredDrawerViewSource();
    const projection = new DrawerViewProjection(source, vi.fn());
    const unavailable = new Error("Favorites unavailable");

    const failed = projection.toggle();
    const failedAssertion = expect(failed).rejects.toBe(unavailable);
    await vi.waitFor(() => expect(source.reads).toHaveLength(1));
    source.reads[0].reject(unavailable);

    await failedAssertion;
    expect(source.mutations).toHaveLength(0);

    const retry = projection.toggle();
    await vi.waitFor(() => expect(source.reads).toHaveLength(2));
    source.reads[1].resolve(drawerView(1));
    await vi.waitFor(() => expect(source.mutations).toHaveLength(1));
    source.mutations[0].completion.resolve();
    await vi.waitFor(() => expect(source.reads).toHaveLength(3));
    source.reads[2].resolve({ ...drawerView(2), open: true });

    await expect(retry).resolves.toEqual({
      status: "published",
      view: { ...drawerView(2), open: true },
    });
    expect(source.calls.filter((call) => call === "listen")).toHaveLength(1);
  });
});
