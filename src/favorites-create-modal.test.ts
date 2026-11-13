// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import panelHtml from "../index.html?raw";
import { mountDrawerRenderer } from "./favorites";
import type { DrawerView } from "./drawer-view";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

const view: DrawerView = {
  generation: 1,
  open: true,
  selectedCollection: null,
  collections: [],
  activeSnapshots: [],
};

function mount(
  createCollection = vi.fn(async () => ({ status: "succeeded" as const })),
) {
  const controller = mountDrawerRenderer(
    { currentView: view, select: vi.fn(async () => undefined) },
    {
      mutations: {
        reorderItems: vi.fn(async () => ({ status: "succeeded" as const })),
        addToCollection: vi.fn(async () => ({ status: "succeeded" as const })),
        addBatchToCollection: vi.fn(async () => ({ status: "succeeded" as const, changed: 1, unchanged: 0 })),
        memberCollectionIds: vi.fn(async () => []),
        createCollection,
        renameCollection: vi.fn(async () => ({ status: "succeeded" as const })),
        deleteCollection: vi.fn(async () => ({ status: "succeeded" as const })),
        reorderCollections: vi.fn(async () => ({ status: "succeeded" as const })),
      },
      itemReorderSnapshot: () => ({
        enabled: false,
        collectionId: null,
        orderedItemIds: [],
      }),
    },
  );
  return { controller, createCollection };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("drawer create modal", () => {
  beforeEach(() => {
    document.documentElement.innerHTML = panelHtml;
    HTMLElement.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
  });

  it("opens an anchored modal instead of the old inline create row", () => {
    mount();
    document.getElementById("favorites-add")!.click();
    const modal = document.getElementById("create-modal")!;
    expect(modal.classList.contains("hidden")).toBe(false);
    expect(document.getElementById("favorites-create-row")).toBeNull();
    expect(document.activeElement).toBe(document.getElementById("create-modal-input"));
  });

  it("creates the collection from the modal input", async () => {
    const { createCollection } = mount();
    document.getElementById("favorites-add")!.click();
    const input = document.getElementById("create-modal-input")!;
    input.textContent = "Work";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flush();
    expect(createCollection).toHaveBeenCalledWith("Work");
    expect(document.getElementById("create-modal")!.classList.contains("hidden")).toBe(true);
  });

  it("closes without creating when the name is empty", async () => {
    const { createCollection } = mount();
    document.getElementById("favorites-add")!.click();
    document.getElementById("create-modal-create")!.click();
    await flush();
    expect(createCollection).not.toHaveBeenCalled();
    expect(document.getElementById("create-modal")!.classList.contains("hidden")).toBe(true);
  });

  it("reports as an open overlay and closes through the shared overlay path", () => {
    const { controller } = mount();
    expect(controller.isAnyOverlayOpen()).toBe(false);
    document.getElementById("favorites-add")!.click();
    expect(controller.isAnyOverlayOpen()).toBe(true);
    expect(controller.closeOverlays()).toBe(true);
    expect(document.getElementById("create-modal")!.classList.contains("hidden")).toBe(true);
    expect(controller.isAnyOverlayOpen()).toBe(false);
  });
});
