// @vitest-environment jsdom
// Runs in its own file on purpose: the panel boots from a DOMContentLoaded
// listener that cannot be unregistered, so sharing an environment with other
// panel-boot tests would re-run earlier inits on every dispatch.
import { beforeEach, expect, it, vi } from "vitest";
import panelHtml from "../index.html?raw";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  publish: (_open: boolean) => {},
  monitor: null as { workArea: { size: { width: number } }; scaleFactor?: number } | null,
  events: new Map<string, (payload?: unknown) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (e: { payload?: unknown }) => void) => {
    native.events.set(event, (payload) => handler({ payload }));
    return () => {};
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  currentMonitor: async () => native.monitor,
  getCurrentWindow: () => ({
    onFocusChanged: async () => () => {},
    onScaleChanged: async () => () => {},
  }),
}));
vi.mock("./preview", () => ({ mountPreview: async () => {} }));
vi.mock("./favorites", () => ({
  mountDrawerRenderer: () => ({
    isAnyOverlayOpen: () => false, closeOverlays: () => false,
    cancel: () => null, render: () => {}, requestCreate: () => {},
  }),
}));
vi.mock("./drawer-view-tauri", () => {
  let view = {
    generation: 1, open: false, selectedCollection: null,
    collections: [], activeSnapshots: [],
  };
  let listener: ((next: typeof view, previous: typeof view | null) => void) | null = null;
  const projection = {
    currentView: view,
    subscribe(callback: typeof listener) { listener = callback; return () => {}; },
    async startup() { listener?.(view, null); return view; },
    async retryIfStale() { return view; },
  };
  native.publish = (open) => {
    const previous = view;
    view = { ...view, generation: view.generation + 1, open };
    projection.currentView = view;
    listener?.(view, previous);
  };
  return { drawerViewProjection: projection };
});

beforeEach(() => {
  vi.resetModules();
  native.invoke.mockReset();
  native.events.clear();
  native.monitor = { workArea: { size: { width: 1920 } } };
  document.documentElement.innerHTML = panelHtml;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1216 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 620 });
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  native.invoke.mockImplementation(async (command: string) => {
    if (command === "get_config") return { language: "zh-TW", preview_enabled: false };
    if (command === "get_clips") return [];
    if (command === "set_main_workspace_layout") return { cssWidth: 1216, cssHeight: 620 };
    return null;
  });
});

it("re-checks the workspace layout every time the panel is re-shown", async () => {
  await import("./main");
  window.dispatchEvent(new Event("DOMContentLoaded"));
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("set_main_workspace_layout", {
    viewportScale: 1,
    leftExtent: 0, rightExtent: 0, commit: true,
  }));
  native.invoke.mockClear();
  // A layout that failed while hidden heals on the next show: the backend
  // emits main-panel-reset right before every show_panel.
  native.events.get("main-panel-reset")?.();
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("set_main_workspace_layout", {
    viewportScale: 1,
    leftExtent: 0, rightExtent: 0, commit: true,
  }));
});
