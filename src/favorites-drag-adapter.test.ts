import { describe, expect, it, vi } from "vitest";
import { createDrawerItemMutationAdapter } from "./favorites";
import type { DrawerItemReorderSnapshot, DrawerMutations } from "./favorites";
import type { DrawerMutationOutcome } from "./drawer-mutations";
import type { ClipLocator } from "./types";

const snapshot: DrawerItemReorderSnapshot = {
  enabled: true,
  collectionId: "c1",
  orderedItemIds: ["snap-a", "snap-b", "snap-c"],
};

function fakeMutations(overrides: Partial<DrawerMutations> = {}): DrawerMutations {
  return {
    reorderItems: vi.fn(async (): Promise<DrawerMutationOutcome> => ({ status: "succeeded" })),
    addToCollection: vi.fn(async (): Promise<DrawerMutationOutcome> => ({ status: "succeeded" })),
    memberCollectionIds: vi.fn(async () => ["c1"]),
    ...overrides,
  };
}

function adapter(
  mutations: DrawerMutations,
  itemReorderSnapshot: () => DrawerItemReorderSnapshot = () => snapshot,
) {
  const presentation = {
    presentFailure: vi.fn(),
    presentAdded: vi.fn(),
  };
  return {
    adapter: createDrawerItemMutationAdapter({
      mutations,
      itemReorderSnapshot,
      presentFailure: presentation.presentFailure,
      presentAdded: presentation.presentAdded,
    }),
    presentation,
  };
}

function dragStart(locator: ClipLocator) {
  return {
    locator,
    visual: { kind: "Text" as const, preview: "clip", thumbnailBase64: null },
    x: 10,
    y: 20,
  };
}

describe("production drag adapter mutation wiring", () => {
  it("derives the reorder context from the eligibility data", () => {
    const { adapter: mutations } = adapter(fakeMutations());

    expect(mutations.reorder.context(dragStart({ scope: "drawer", id: "snap-b" }))).toEqual({
      collectionId: "c1",
      itemId: "snap-b",
      orderedItemIds: ["snap-a", "snap-b", "snap-c"],
    });
  });

  it("rejects reorder contexts that the eligibility data disqualifies", () => {
    const { adapter: mutations } = adapter(fakeMutations());

    expect(mutations.reorder.context(dragStart({ scope: "history", id: "snap-b" }))).toBeNull();
    expect(mutations.reorder.context(dragStart({ scope: "drawer", id: "snap-x" }))).toBeNull();
    expect(
      adapter(fakeMutations(), () => ({ ...snapshot, enabled: false })).adapter.reorder.context(
        dragStart({ scope: "drawer", id: "snap-b" }),
      ),
    ).toBeNull();
    expect(
      adapter(fakeMutations(), () => ({ ...snapshot, collectionId: null })).adapter.reorder.context(
        dragStart({ scope: "drawer", id: "snap-b" }),
      ),
    ).toBeNull();
  });

  it("routes reorder commits through the workflow module", async () => {
    const mutations = fakeMutations();
    const { adapter: wired } = adapter(mutations);

    await expect(wired.reorder.commit("c1", ["snap-b", "snap-a"])).resolves.toBeUndefined();

    expect(mutations.reorderItems).toHaveBeenCalledExactlyOnceWith({
      collectionId: "c1",
      orderedItemIds: ["snap-b", "snap-a"],
    });
  });

  it("rejects the reorder commit when the workflow reports command failure", async () => {
    const failure = new Error("reorder rejected");
    const mutations = fakeMutations({
      reorderItems: vi.fn(async (): Promise<DrawerMutationOutcome> => ({ status: "failed", error: failure })),
    });
    const { adapter: wired, presentation } = adapter(mutations);

    await expect(wired.reorder.commit("c1", ["snap-b"])).rejects.toBe(failure);

    wired.reorder.showFailure(failure);
    expect(presentation.presentFailure).toHaveBeenCalledWith(failure);
  });

  it("resolves a committed-stale reorder commit without failing the drag", async () => {
    const mutations = fakeMutations({
      reorderItems: vi.fn(async (): Promise<DrawerMutationOutcome> => ({ status: "committed-stale" })),
    });
    const { adapter: wired } = adapter(mutations);

    await expect(wired.reorder.commit("c1", ["snap-b"])).resolves.toBeUndefined();
    expect(wired.reorder.showSuccess("c1")).toBeUndefined();
  });

  it("routes membership lookup and commits through the workflow module", async () => {
    const mutations = fakeMutations();
    const { adapter: wired } = adapter(mutations);
    const start = dragStart({ scope: "drawer", id: "snap-a" });

    await expect(wired.lookupMembership(start)).resolves.toEqual(["c1"]);
    await expect(wired.commit("c2", start)).resolves.toBeUndefined();

    expect(mutations.memberCollectionIds).toHaveBeenCalledExactlyOnceWith({
      scope: "drawer",
      id: "snap-a",
    });
    expect(mutations.addToCollection).toHaveBeenCalledExactlyOnceWith({
      collectionId: "c2",
      locator: { scope: "drawer", id: "snap-a" },
    });
  });

  it("presents a membership add only when the outcome reports success", async () => {
    const { adapter: wired, presentation } = adapter(fakeMutations());

    await wired.commit("c2", dragStart({ scope: "drawer", id: "snap-a" }));
    wired.showSuccess("c2");

    expect(presentation.presentAdded).toHaveBeenCalledExactlyOnceWith("c2");
  });

  it("stays silent on a committed-stale membership add", async () => {
    const mutations = fakeMutations({
      addToCollection: vi.fn(async (): Promise<DrawerMutationOutcome> => ({ status: "committed-stale" })),
    });
    const { adapter: wired, presentation } = adapter(mutations);

    await wired.commit("c2", dragStart({ scope: "drawer", id: "snap-a" }));
    wired.showSuccess("c2");

    expect(presentation.presentAdded).not.toHaveBeenCalled();
  });

  it("rejects the membership commit on command failure and presents the failure", async () => {
    const failure = new Error("membership rejected");
    const mutations = fakeMutations({
      addToCollection: vi.fn(async (): Promise<DrawerMutationOutcome> => ({ status: "failed", error: failure })),
    });
    const { adapter: wired, presentation } = adapter(mutations);

    await expect(wired.commit("c2", dragStart({ scope: "drawer", id: "snap-a" }))).rejects.toBe(failure);

    wired.showFailure(failure);
    expect(presentation.presentFailure).toHaveBeenCalledWith(failure);
    expect(presentation.presentAdded).not.toHaveBeenCalled();
  });
});
