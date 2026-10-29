import { describe, expect, it, vi } from "vitest";
import { WorkspaceLayoutCoordinator } from "./workspace-layout";
import { decideWorkspaceLayout } from "./workspace-state";
import type { WorkspaceLayout } from "./workspace-state";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const closed = decideWorkspaceLayout(1920, false, false, "drawer");
const drawer = decideWorkspaceLayout(1920, true, false, "drawer");
const both = decideWorkspaceLayout(1920, true, true, "drawer");
function setup() {
  const host = {
    stage: vi.fn(),
    resize: vi.fn(async (_layout: WorkspaceLayout) => ({ cssWidth: 480, cssHeight: 620 })),
    waitForViewport: vi.fn(async () => {}),
    commit: vi.fn(), finish: vi.fn(async (_layout: WorkspaceLayout) => {}), report: vi.fn(),
  };
  return { host, coordinator: new WorkspaceLayoutCoordinator(host) };
}

describe("workspace presentation", () => {
  it("expands the region before commit and finishes it after paint, serially", async () => {
    const { host, coordinator } = setup();
    const painted = deferred<void>();
    host.finish.mockReturnValueOnce(painted.promise);
    const done = coordinator.request(drawer, "screen");
    await vi.waitFor(() => expect(host.finish).toHaveBeenCalledWith(drawer));
    expect(host.stage.mock.invocationCallOrder[0]).toBeLessThan(host.resize.mock.invocationCallOrder[0]);
    expect(host.commit.mock.invocationCallOrder[0]).toBeLessThan(host.finish.mock.invocationCallOrder[0]);
    void coordinator.request(closed, "screen");
    expect(host.resize).toHaveBeenCalledTimes(1);
    painted.resolve();
    await done;
    expect(host.commit).toHaveBeenLastCalledWith(closed);
    expect(host.finish).toHaveBeenLastCalledWith(closed);
  });
  it("republishes a quick reopen after synchronous hiding without another resize", async () => {
    const { host, coordinator } = setup();
    await coordinator.request(drawer, "screen");
    coordinator.invalidate();
    coordinator.invalidate();
    await coordinator.request(drawer, "screen");
    expect(host.resize).toHaveBeenCalledTimes(1);
    expect(host.commit).toHaveBeenCalledTimes(2);
    expect(host.commit).toHaveBeenLastCalledWith(drawer);
  });
  it("invalidates an open before the next intent has finished its monitor lookup", async () => {
    const { host, coordinator } = setup();
    const viewport = deferred<void>();
    host.waitForViewport.mockReturnValueOnce(viewport.promise);
    const done = coordinator.request(drawer, "screen");
    await Promise.resolve();
    coordinator.invalidate();
    viewport.resolve();
    await done;
    expect(host.commit).not.toHaveBeenCalled();
    await coordinator.request(closed, "screen");
    expect(host.commit).toHaveBeenCalledExactlyOnceWith(closed);
  });
  it("waits for both native bounds and viewport before revealing panes", async () => {
    const { host, coordinator } = setup();
    const native = deferred<{ cssWidth: number; cssHeight: number }>();
    const viewport = deferred<void>();
    host.resize.mockReturnValueOnce(native.promise);
    host.waitForViewport.mockReturnValueOnce(viewport.promise);
    const done = coordinator.request(drawer, "screen");
    await Promise.resolve();
    expect(host.stage).toHaveBeenCalledWith(drawer);
    expect(host.commit).not.toHaveBeenCalled();
    native.resolve({ cssWidth: 848, cssHeight: 620 });
    await Promise.resolve();
    expect(host.commit).not.toHaveBeenCalled();
    viewport.resolve();
    await done;
    expect(host.commit).toHaveBeenCalledWith(drawer);
  });

  it("serializes native work and never reveals an obsolete open intent", async () => {
    const { host, coordinator } = setup();
    await coordinator.request(closed, "screen");
    host.resize.mockClear();
    host.commit.mockClear();
    const pending = deferred<{ cssWidth: number; cssHeight: number }>();
    host.resize.mockReturnValueOnce(pending.promise);
    const done = coordinator.request(drawer, "screen");
    await Promise.resolve();
    void coordinator.request(both, "screen");
    void coordinator.request(closed, "screen");
    expect(host.resize).toHaveBeenCalledTimes(1);
    pending.resolve({ cssWidth: 848, cssHeight: 620 });
    await done;
    expect(host.resize.mock.calls.map(([layout]) => layout)).toEqual([drawer, closed]);
    expect(host.commit).toHaveBeenCalledExactlyOnceWith(closed);
  });

  it("coalesces identical requests but revalidates a changed scale or monitor", async () => {
    const { host, coordinator } = setup();
    await coordinator.request(drawer, "1920:1");
    await coordinator.request({ ...drawer }, "1920:1");
    expect(host.resize).toHaveBeenCalledTimes(1);
    expect(host.commit).toHaveBeenCalledTimes(1);
    await coordinator.request(drawer, "1280:1.5");
    expect(host.resize).toHaveBeenCalledTimes(2);
  });

  it("switches compact tabs without resizing the native window", async () => {
    const { host, coordinator } = setup();
    await coordinator.request(decideWorkspaceLayout(900, true, true, "drawer"), "screen");
    const preview = decideWorkspaceLayout(900, true, true, "preview");
    await coordinator.request(preview, "screen");
    expect(host.resize).toHaveBeenCalledTimes(1);
    expect(host.commit).toHaveBeenLastCalledWith(preview);
  });

  it("keeps failed geometry unpublished and retries the same intent", async () => {
    const { host, coordinator } = setup();
    host.resize.mockRejectedValueOnce(new Error("native failure"));
    await coordinator.request(drawer, "screen");
    expect(host.commit).not.toHaveBeenCalled();
    expect(host.report).toHaveBeenCalledTimes(1);
    await coordinator.request(drawer, "screen");
    expect(host.resize).toHaveBeenCalledTimes(2);
    expect(host.commit).toHaveBeenCalledWith(drawer);
  });

  it("does not strand a newer intent after a viewport failure", async () => {
    const { host, coordinator } = setup();
    const viewport = deferred<void>();
    host.waitForViewport.mockReturnValueOnce(viewport.promise);
    const done = coordinator.request(drawer, "screen");
    await Promise.resolve();
    await Promise.resolve();
    void coordinator.request(closed, "screen");
    viewport.reject(new Error("viewport failure"));
    await done;
    expect(host.commit).toHaveBeenCalledExactlyOnceWith(closed);
    expect(host.report).toHaveBeenCalledTimes(1);
  });
});

it("retries a failed layout until the viewport acknowledges", async () => {
  vi.useFakeTimers();
  const { host, coordinator } = setup();
  host.resize.mockResolvedValue({ cssWidth: 848, cssHeight: 620 });
  host.waitForViewport.mockRejectedValueOnce(new Error("viewport"));
  const done = coordinator.request(drawer, "screen");
  await vi.advanceTimersByTimeAsync(1);
  expect(host.report).toHaveBeenCalledTimes(1);
  expect(host.commit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(400);
  await done;
  expect(host.resize).toHaveBeenCalledTimes(2);
  expect(host.commit).toHaveBeenCalledWith(drawer);
});

it("stops retrying after the failure cap", async () => {
  vi.useFakeTimers();
  const { host, coordinator } = setup();
  host.resize.mockResolvedValue({ cssWidth: 848, cssHeight: 620 });
  host.waitForViewport.mockRejectedValue(new Error("viewport"));
  const done = coordinator.request(drawer, "screen");
  await vi.advanceTimersByTimeAsync(400 * 3);
  await done;
  // 1 initial attempt + 2 bounded retries, then it gives up quietly.
  expect(host.report).toHaveBeenCalledTimes(3);
  expect(host.resize).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(400 * 5);
  expect(host.report).toHaveBeenCalledTimes(3);
});

it("drops the retry of an invalidated intent", async () => {
  vi.useFakeTimers();
  const { host, coordinator } = setup();
  host.resize.mockResolvedValue({ cssWidth: 848, cssHeight: 620 });
  host.waitForViewport.mockRejectedValue(new Error("viewport"));
  const done = coordinator.request(drawer, "screen");
  await vi.advanceTimersByTimeAsync(1);
  coordinator.invalidate();
  await vi.advanceTimersByTimeAsync(400);
  await done;
  expect(host.resize).toHaveBeenCalledTimes(1);
});

it("does not resurrect a failed intent that newer requests replaced", async () => {
  vi.useFakeTimers();
  const { host, coordinator } = setup();
  host.resize.mockResolvedValue({ cssWidth: 848, cssHeight: 620 });
  host.waitForViewport.mockRejectedValueOnce(new Error("viewport"));
  const done = coordinator.request(drawer, "screen");
  await vi.advanceTimersByTimeAsync(1);
  await coordinator.request(closed, "screen");
  await vi.advanceTimersByTimeAsync(400);
  await done;
  expect(host.commit).toHaveBeenLastCalledWith(closed);
});
