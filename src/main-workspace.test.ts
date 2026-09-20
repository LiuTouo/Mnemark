// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import panelHtml from "../index.html?raw";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  publish: (_open: boolean) => {},
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({
  currentMonitor: async () => ({ workArea: { size: { width: 1920 } } }),
  getCurrentWindow: () => ({ onFocusChanged: async () => () => {} }),
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

it("reveals the drawer only after region preparation and releases unused space after closing", async () => {
  await import("./main");
  window.dispatchEvent(new Event("DOMContentLoaded"));
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>("#favorites-toggle")!.disabled).toBe(false));
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("set_main_workspace_layout", {
    leftExtent: 0, rightExtent: 0, commit: true,
  }));
  let finish!: (geometry: { cssWidth: number; cssHeight: number }) => void;
  const pending = new Promise((resolve) => { finish = resolve; });
  native.invoke.mockImplementation(async (command: string) => {
    if (command === "set_main_workspace_layout") return pending;
    return null;
  });
  native.invoke.mockClear();
  native.publish(true);
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("set_main_workspace_layout", {
    leftExtent: 368, rightExtent: 0,
  }));
  const drawer = document.getElementById("workspace-drawer")!;
  expect(drawer.classList.contains("hidden")).toBe(true);

  finish({ cssWidth: 1216, cssHeight: 620 });
  await vi.waitFor(() => expect(drawer.classList.contains("hidden")).toBe(false));
  expect(document.getElementById("workspace")!.style.getPropertyValue("--left-extent")).toBe("368px");
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("set_main_workspace_layout", {
    leftExtent: 368, rightExtent: 0, commit: true,
  }));
  native.invoke.mockClear();
  native.publish(false);
  expect(drawer.classList.contains("hidden")).toBe(true);
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("set_main_workspace_layout", {
    leftExtent: 0, rightExtent: 0, commit: true,
  }));
  expect(window.innerWidth).toBe(1216);
});
