import { describe, expect, it, vi } from "vitest";
import type { CollectionSummary } from "./types";
import {
  TauriDrawerViewSource,
  type TauriDrawerViewDependencies,
} from "./drawer-view-tauri";

function collection(id: string): CollectionSummary {
  return {
    id,
    name: id,
    sort_order: 0,
    created_at: 1,
    item_count: 0,
  };
}

function dependencies(
  invokeCommand: TauriDrawerViewDependencies["invoke"],
  listenEvent: TauriDrawerViewDependencies["listen"] = async () => vi.fn(),
): TauriDrawerViewDependencies {
  return { invoke: invokeCommand, listen: listenEvent };
}

describe("TauriDrawerViewSource", () => {
  it("maps the canonical wire view to an owned readonly Drawer view", async () => {
    const collections = [collection("drawer-a")];
    const invokeCommand = vi.fn(async () => ({
      generation: 7,
      open: true,
      selected_collection: "drawer-a",
      collections,
      active_snapshots: [{ id: "hash-1", added_at: 5 }],
    }));
    const source = new TauriDrawerViewSource(dependencies(invokeCommand));

    const view = await source.read();
    collections.push(collection("drawer-b"));

    expect(invokeCommand).toHaveBeenCalledWith("get_drawer_view");
    expect(view).toEqual({
      generation: 7,
      open: true,
      selectedCollection: "drawer-a",
      collections: [collection("drawer-a")],
      activeSnapshots: [{ id: "hash-1", added_at: 5, origin: "favorite" }],
    });
    expect(view.collections).not.toBe(collections);
  });

  it("forwards generation invalidation and Drawer intent commands", async () => {
    const invokeCommand = vi.fn(async () => undefined);
    let emitInvalidated: (event: { readonly payload: unknown }) => void = () => {
      throw new Error("listener was not registered");
    };
    const listenEvent = vi.fn(async (
      _event: string,
      listener: (event: { readonly payload: unknown }) => void,
    ) => {
      emitInvalidated = listener;
      return vi.fn();
    });
    const source = new TauriDrawerViewSource(
      dependencies(invokeCommand, listenEvent),
    );
    const listener = vi.fn();

    await source.listenInvalidated(listener);
    emitInvalidated({ payload: { generation: 9 } });
    await source.toggle();
    await source.setOpen(false);
    await source.select("drawer-a");
    await source.select(null);

    expect(listenEvent).toHaveBeenCalledWith(
      "drawer-view-invalidated",
      expect.any(Function),
    );
    expect(listener).toHaveBeenCalledWith(9);
    expect(invokeCommand.mock.calls).toEqual([
      ["toggle_favorites_sidebar"],
      ["set_favorites_open", { open: false }],
      ["set_favorites_selected", { collectionId: "drawer-a" }],
      ["set_favorites_selected", { collectionId: null }],
    ]);
  });
});
