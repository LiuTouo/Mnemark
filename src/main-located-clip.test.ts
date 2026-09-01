// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import panelHtml from "../index.html?raw";
import type { Clip } from "./types";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(async () => () => {}),
  onFocusChanged: vi.fn(async () => () => {}),
  currentMonitor: vi.fn(async () => null),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));
vi.mock("@tauri-apps/api/window", () => ({
  currentMonitor: tauri.currentMonitor,
  getCurrentWindow: () => ({ onFocusChanged: tauri.onFocusChanged }),
}));
vi.mock("./preview", () => ({ mountPreview: vi.fn(async () => {}) }));
vi.mock("./favorites", () => ({
  mountDrawerRenderer: () => ({
    cancel: () => null,
    render: vi.fn(),
    requestCreate: vi.fn(),
  }),
}));
vi.mock("./drawer-view-tauri", () => {
  const view = {
    generation: 1,
    open: false,
    selectedCollection: null,
    collections: [],
    activeSnapshots: [],
  };
  let subscriber: ((next: typeof view, previous: typeof view | null) => void) | null = null;
  const projection = {
    currentView: null as typeof view | null,
    subscribe(listener: typeof subscriber) {
      subscriber = listener;
      return () => {};
    },
    async startup() {
      projection.currentView = view;
      subscriber?.(view, null);
      return view;
    },
    async retryIfStale() {
      return view;
    },
    async refresh() {
      return view;
    },
    async toggle() {
      return { status: "published", view };
    },
    async setOpen() {
      return { status: "published", view };
    },
    async select() {
      return { status: "published", view };
    },
  };
  return { drawerViewProjection: projection };
});

function clip(id: string, preview: string): Clip {
  return {
    id,
    kind: "Text",
    text_content: preview,
    file_paths: null,
    thumbnail_base64: null,
    content_hash: `hash-${id}`,
    preview,
    note: null,
    truncated: false,
    source_exe: "test.exe",
    source_title: "Test",
    source_icon: null,
    captured_at: 1,
    pinned: false,
    byte_size: preview.length,
  };
}

function commandCalls(command: string) {
  return tauri.invoke.mock.calls.filter(([called]) => called === command);
}

describe("Panel located Clip callers", () => {
  beforeEach(() => {
    vi.resetModules();
    tauri.invoke.mockReset();
    tauri.listen.mockClear();
    tauri.onFocusChanged.mockClear();
    tauri.currentMonitor.mockClear();
    document.documentElement.innerHTML = panelHtml;
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
    HTMLElement.prototype.scrollIntoView = vi.fn();

    const clips = [clip("clip-a", "First"), clip("clip-b", "Second")];
    tauri.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      switch (command) {
        case "get_config":
          return { language: "zh-TW", preview_enabled: true };
        case "get_clips":
          return clips;
        case "copy_located_clip":
          return "copied";
        case "set_located_clip_note":
          return String(args?.note ?? "") || null;
        case "get_active_clip_preview":
          return null;
        default:
          return undefined;
      }
    });
  });

  it("keeps row, keyboard, menu, preview, note, resync, and render wired to locators", async () => {
    await import("./main");
    window.dispatchEvent(new Event("DOMContentLoaded"));

    await vi.waitFor(() => {
      expect(document.querySelectorAll("#clip-list .clip-item")).toHaveLength(2);
      expect(commandCalls("show_located_clip_preview").length).toBeGreaterThan(0);
    });

    const firstRow = document.querySelector<HTMLElement>("#clip-list .clip-item")!;
    firstRow.click();
    await vi.waitFor(() => {
      expect(commandCalls("paste_located_clip")).toContainEqual([
        "paste_located_clip",
        { locator: { scope: "history", id: "clip-a" } },
      ]);
    });

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(commandCalls("paste_located_clip")).toHaveLength(2));

    const copyButton = document.querySelector<HTMLButtonElement>(
      "#clip-list .clip-item .clip-action-btn:not(.pin-btn):not(.more-btn)",
    )!;
    copyButton.click();
    await vi.waitFor(() => {
      expect(commandCalls("copy_located_clip")).toContainEqual([
        "copy_located_clip",
        { locator: { scope: "history", id: "clip-a" } },
      ]);
    });

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#clip-list .clip-item.selected")?.dataset.clipId)
        .toBe("clip-b");
      expect(commandCalls("show_located_clip_preview")).toContainEqual([
        "show_located_clip_preview",
        { locator: { scope: "history", id: "clip-b" } },
      ]);
    });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => {
      expect(commandCalls("paste_located_clip")).toContainEqual([
        "paste_located_clip",
        { locator: { scope: "history", id: "clip-b" } },
      ]);
    });

    document.querySelector<HTMLButtonElement>("#clip-list .clip-item.selected .more-btn")!.click();
    document.querySelector<HTMLButtonElement>("#clip-action-menu button")!.click();
    const noteInput = document.getElementById("note-input") as HTMLTextAreaElement;
    noteInput.value = "memo";
    (document.getElementById("note-save") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(commandCalls("set_located_clip_note")).toContainEqual([
        "set_located_clip_note",
        { locator: { scope: "history", id: "clip-b" }, note: "memo" },
      ]);
    });

    await vi.waitFor(() => expect(tauri.onFocusChanged).toHaveBeenCalledOnce());
    const focusCalls = tauri.onFocusChanged.mock.calls as unknown as Array<[
      (event: { payload: boolean }) => void,
    ]>;
    const focusListener = focusCalls[0][0];
    focusListener({ payload: true });
    await vi.waitFor(() => expect(commandCalls("get_active_clip_preview").length).toBeGreaterThan(0));
  });
});
