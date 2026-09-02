// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import panelHtml from "../index.html?raw";
import { mountDrawerRenderer } from "./favorites";
import type { DrawerView } from "./drawer-view";
import type { Clip } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

const view: DrawerView = {
  generation: 1,
  open: true,
  selectedCollection: null,
  collections: [{
    id: "collection-1",
    name: "Work",
    sort_order: 0,
    created_at: 1,
    item_count: 2,
  }],
  activeSnapshots: [],
};

const item: Clip = {
  id: "clip-1",
  kind: "Text",
  text_content: "text",
  file_paths: null,
  thumbnail_base64: null,
  content_hash: "hash",
  preview: "text",
  note: null,
  truncated: false,
  source_exe: "app.exe",
  source_title: "App",
  source_icon: null,
  captured_at: 1,
  pinned: false,
  byte_size: 4,
};

describe("Drawer overlay controller", () => {
  beforeEach(() => {
    document.documentElement.innerHTML = panelHtml;
    HTMLElement.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
  });

  it("closes exactly one Drawer-owned overlay layer through its public interface", () => {
    const controller = mountDrawerRenderer({
      currentView: view,
      select: vi.fn(async () => undefined),
    }, {
      mutations: {
        reorderItems: vi.fn(async () => ({ status: "succeeded" as const })),
        addToCollection: vi.fn(async () => ({ status: "succeeded" as const })),
        memberCollectionIds: vi.fn(async () => []),
        createCollection: vi.fn(async () => ({ status: "succeeded" as const })),
        renameCollection: vi.fn(async () => ({ status: "succeeded" as const })),
        deleteCollection: vi.fn(async () => ({ status: "succeeded" as const })),
        reorderCollections: vi.fn(async () => ({ status: "succeeded" as const })),
      },
      itemReorderSnapshot: () => ({
        enabled: false,
        collectionId: null,
        orderedItemIds: [],
      }),
    });
    controller.render(view);

    document.querySelector<HTMLButtonElement>(".favorites-more-btn")!.click();
    expect(controller.isAnyOverlayOpen()).toBe(true);
    expect(controller.closeOverlays()).toBe(true);
    expect(document.getElementById("favorites-more-menu")!.classList).toContain("hidden");

    document.querySelector<HTMLButtonElement>(".favorites-more-btn")!.click();
    document.querySelector<HTMLButtonElement>("#favorites-more-menu .menu-item-delete")!.click();
    expect(controller.isAnyOverlayOpen()).toBe(true);
    expect(controller.closeOverlays()).toBe(true);
    expect(document.getElementById("remove-modal")!.classList).toContain("hidden");

    const source = document.createElement("div");
    controller.start(item, source, { x: 0, y: 0 });
    expect(controller.isAnyOverlayOpen()).toBe(true);
    expect(controller.closeOverlays()).toBe(true);
    expect(controller.isAnyOverlayOpen()).toBe(false);
    expect(controller.closeOverlays()).toBe(false);

    document.querySelector<HTMLButtonElement>(".favorites-more-btn")!.click();
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(controller.isAnyOverlayOpen()).toBe(false);
  });
});
