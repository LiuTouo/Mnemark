// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { waitForWorkspacePaint, waitForWorkspaceViewport } from "./workspace-layout";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("finishes region cleanup while hidden without waiting for throttled animation frames", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await waitForWorkspacePaint();
  expect(vi.getTimerCount()).toBe(0);
});

it("cannot strand queued layout intents when WebView stops delivering animation frames", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
  const waiting = waitForWorkspacePaint();
  await vi.advanceTimersByTimeAsync(250);
  await waiting;
  expect(vi.getTimerCount()).toBe(0);
});

it("accepts rounded CSS dimensions after a real viewport resize event", async () => {
  vi.useFakeTimers();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 480 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 620 });
  const ready = vi.fn();
  const waiting = waitForWorkspaceViewport({ cssWidth: 848.4, cssHeight: 620.2 }).then(ready);
  await vi.advanceTimersByTimeAsync(32);
  expect(ready).not.toHaveBeenCalled();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 848 });
  window.dispatchEvent(new Event("resize"));
  await waiting;
  expect(ready).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("fails a missing viewport acknowledgement without leaving timers or listeners", async () => {
  vi.useFakeTimers();
  const remove = vi.spyOn(window, "removeEventListener");
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 480 });
  const waiting = waitForWorkspaceViewport({ cssWidth: 848, cssHeight: 620 });
  const rejected = expect(waiting).rejects.toThrow("Workspace viewport did not reach the native bounds");
  await vi.advanceTimersByTimeAsync(1000);
  await rejected;
  expect(remove).toHaveBeenCalledWith("resize", expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
  remove.mockRestore();
});
