// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import panelHtml from "../index.html?raw";

const native = vi.hoisted(() => {
  interface View {
    generation: number;
    open: boolean;
    selectedCollection: null;
    collections: never[];
    activeSnapshots: never[];
  }
  return {
    invoke: vi.fn(),
    publish: (_open: boolean) => {},
    focusHandlers: [] as ((event: { payload: boolean }) => void)[],
    monitor: null as { workArea: { size: { width: number } }; scaleFactor?: number } | null,
    events: new Map<string, (payload?: unknown) => void>(),
    // Drawer projection state: vi.resetModules() re-runs main.ts but not
    // mock factories, so all per-test state must live here and be reset in
    // beforeEach.
    drawer: {
      view: {
        generation: 1, open: false, selectedCollection: null,
        collections: [], activeSnapshots: [],
      } as View,
      listener: null as ((next: View, previous: View | null) => void) | null,
      announced: false,
      // Every projection read fails while true (transiently unavailable
      // backend).
      failReads: false,
      // Every drawer open/close write fails while true (the read path uses
      // failReads).
      failAllSetOpen: false,
    },
  };
});
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
    onFocusChanged: async (handler: (event: { payload: boolean }) => void) => {
      native.focusHandlers.push(handler);
      return () => {};
    },
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
  const drawer = native.drawer;
  const fail = async () => {
    throw new Error("drawer unavailable");
  };
  const read = async () => {
    if (drawer.failReads) await fail();
  };
  const republish = (): void => {
    const previous = drawer.view;
    drawer.view = { ...drawer.view, generation: drawer.view.generation + 1 };
    drawer.listener?.(drawer.view, previous);
  };
  const transition = (open: boolean) => {
    const previous = drawer.view;
    drawer.view = { ...drawer.view, generation: drawer.view.generation + 1, open };
    drawer.listener?.(drawer.view, previous);
    return drawer.view;
  };
  const projection = {
    get currentView() { return drawer.view; },
    subscribe(callback: typeof drawer.listener) { drawer.listener = callback; return () => {}; },
    async startup() {
      await read();
      if (!drawer.announced) {
        drawer.announced = true;
        drawer.listener?.(drawer.view, null);
      }
      return drawer.view;
    },
    async retryIfStale() {
      // A successful refresh republishes the view under a new generation.
      await read();
      republish();
      return drawer.view;
    },
    async refresh() {
      await read();
      republish();
      return drawer.view;
    },
    async setOpen(open: boolean) {
      if (drawer.failAllSetOpen) await fail();
      await read();
      return { status: "published" as const, view: transition(open) };
    },
    async toggle() {
      await read();
      return { status: "published" as const, view: transition(!drawer.view.open) };
    },
    async select() {
      await read();
      return { status: "published" as const, view: drawer.view };
    },
  };
  native.publish = (open) => { transition(open); };
  return { drawerViewProjection: projection };
});

beforeEach(() => {
  vi.resetModules();
  native.invoke.mockReset();
  native.events.clear();
  native.focusHandlers.length = 0;
  native.monitor = { workArea: { size: { width: 1920 } } };
  native.drawer.view = {
    generation: 1, open: false, selectedCollection: null,
    collections: [], activeSnapshots: [],
  };
  native.drawer.listener = null;
  native.drawer.announced = false;
  native.drawer.failReads = false;
  native.drawer.failAllSetOpen = false;
  document.documentElement.innerHTML = panelHtml;
  // Drawer restore suppressed by default: the pane-transition tests below
  // drive open/close manually through native.publish.
  localStorage.setItem("mnemark.drawer-open", "0");
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

it("decides the layout from the monitor scale factor, not a stale devicePixelRatio", async () => {
  // 1080p monitor at 100% while WebView2 still reports the 4K monitor's
  // ratio (1.875 = 150% display × 125% UI zoom): the old dpr-based math
  // computed 1024 CSS px, collapsed the drawer to compact/overlay and the
  // panes never came back after the acknowledgement timed out.
  native.monitor = { workArea: { size: { width: 1920 } }, scaleFactor: 1 };
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1.875 });
  await import("./main");
  window.dispatchEvent(new Event("DOMContentLoaded"));
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("set_main_workspace_layout", {
    leftExtent: 0, rightExtent: 0, commit: true,
  }));
  native.publish(true);
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("set_main_workspace_layout", {
    leftExtent: 368, rightExtent: 0,
  }));
  // Drain the coordinator's pending commit before the test ends: a leaked
  // finish chain would fire inside the next test's settle window.
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("set_main_workspace_layout", {
    leftExtent: 368, rightExtent: 0, commit: true,
  }));
});

function fireFocus(): void {
  for (const handler of native.focusHandlers) handler({ payload: true });
}

it("restores the stored drawer-open state even when the first boot read failed", async () => {
  localStorage.removeItem("mnemark.drawer-open");
  // The backend is unavailable at boot: the restore attempt fails alongside
  // the first read instead of being skipped.
  native.drawer.failReads = true;
  await import("./main");
  window.dispatchEvent(new Event("DOMContentLoaded"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(native.invoke).not.toHaveBeenCalledWith("set_main_workspace_layout", {
    leftExtent: 368, rightExtent: 0,
  });

  // The backend comes back: the next focus heals the read and the pending
  // restore re-opens the drawer through the normal layout flow.
  native.drawer.failReads = false;
  fireFocus();

  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("set_main_workspace_layout", {
    leftExtent: 368, rightExtent: 0,
  }));
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("set_main_workspace_layout", {
    leftExtent: 368, rightExtent: 0, commit: true,
  }));
  expect(localStorage.getItem("mnemark.drawer-open")).toBe("1");
});

it("heals a failed boot restore on the next focus instead of staying closed", async () => {
  localStorage.removeItem("mnemark.drawer-open");
  // Boot reads fail AND the boot restore's own write fails.
  native.drawer.failReads = true;
  native.drawer.failAllSetOpen = true;
  await import("./main");
  window.dispatchEvent(new Event("DOMContentLoaded"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(native.invoke).not.toHaveBeenCalledWith("set_main_workspace_layout", {
    leftExtent: 368, rightExtent: 0,
  });

  // First focus: reads heal but the restore's write keeps failing.
  native.drawer.failReads = false;
  fireFocus();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(native.invoke).not.toHaveBeenCalledWith("set_main_workspace_layout", {
    leftExtent: 368, rightExtent: 0,
  });
  // The healed read republished the closed drawer without clobbering the
  // stored "1" (which the failed boot never got to rewrite; the old code
  // would have written "0" here).
  expect(localStorage.getItem("mnemark.drawer-open")).toBeNull();

  // The next focus retries the restore without any user interaction.
  native.drawer.failAllSetOpen = false;
  fireFocus();

  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("set_main_workspace_layout", {
    leftExtent: 368, rightExtent: 0,
  }));
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("set_main_workspace_layout", {
    leftExtent: 368, rightExtent: 0, commit: true,
  }));
  expect(localStorage.getItem("mnemark.drawer-open")).toBe("1");
});

it("keeps the stored open preference when a restore attempt fails after a healed read", async () => {
  localStorage.setItem("mnemark.drawer-open", "1");
  native.drawer.failReads = true;
  await import("./main");
  window.dispatchEvent(new Event("DOMContentLoaded"));
  await new Promise((resolve) => setTimeout(resolve, 20));

  // The focus-time refresh succeeds (republishing the closed drawer under a
  // new generation) but every restore write keeps failing.
  native.drawer.failReads = false;
  native.drawer.failAllSetOpen = true;
  fireFocus();
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Republishing the unchanged closed state must not clobber the stored
  // "1": the next boot would otherwise skip the restore forever.
  expect(localStorage.getItem("mnemark.drawer-open")).toBe("1");
});
