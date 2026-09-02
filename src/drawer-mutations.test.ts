import { describe, expect, it, vi } from "vitest";
import { DrawerMutationWorkflow } from "./drawer-mutations";
import type { DrawerMutationDependencies } from "./drawer-mutations";

const locator = { scope: "history" as const, id: "clip-1" };

function dependencies(overrides: Partial<DrawerMutationDependencies> = {}) {
  const deps: DrawerMutationDependencies = {
    invoke: vi.fn(async () => undefined),
    refreshAfterMutation: vi.fn(async () => true),
    retryAfterFailure: vi.fn(async () => undefined),
    ...overrides,
  };
  return { deps, workflow: new DrawerMutationWorkflow(deps) };
}

describe("DrawerMutationWorkflow", () => {
  it("answers membership lookup through the single lookup command", async () => {
    const { deps, workflow } = dependencies({ invoke: vi.fn(async () => ["c1", "c2"]) });

    await expect(workflow.memberCollectionIds(locator)).resolves.toEqual(["c1", "c2"]);

    expect(deps.invoke).toHaveBeenCalledExactlyOnceWith("favorite_collection_ids", { locator });
  });

  const mutationCases = [
    {
      name: "item reorder",
      command: "reorder_favorite_items",
      run: (workflow: DrawerMutationWorkflow) => workflow.reorderItems({
        collectionId: "c1",
        orderedItemIds: ["b", "a"],
      }),
    },
    {
      name: "single membership add",
      command: "add_favorite",
      run: (workflow: DrawerMutationWorkflow) => workflow.addToCollection({ collectionId: "c1", locator }),
    },
    {
      name: "batch membership add",
      command: "add_favorites",
      run: (workflow: DrawerMutationWorkflow) => workflow.addBatchToCollection({
        collectionId: "c1",
        locators: [locator],
      }),
    },
    {
      name: "single membership removal",
      command: "remove_favorite",
      run: (workflow: DrawerMutationWorkflow) => workflow.removeFromCollection({
        collectionId: "c1",
        itemId: "item-1",
      }),
    },
    {
      name: "batch membership removal",
      command: "remove_favorites",
      run: (workflow: DrawerMutationWorkflow) => workflow.removeBatchFromCollection({
        collectionId: "c1",
        itemIds: ["item-1"],
      }),
    },
    {
      name: "Collection creation",
      command: "create_collection",
      run: (workflow: DrawerMutationWorkflow) => workflow.createCollection("Work"),
    },
    {
      name: "Collection rename",
      command: "rename_collection",
      run: (workflow: DrawerMutationWorkflow) => workflow.renameCollection("c1", "Renamed"),
    },
    {
      name: "Collection deletion",
      command: "delete_collection",
      run: (workflow: DrawerMutationWorkflow) => workflow.deleteCollection("c1"),
    },
    {
      name: "Collection reorder",
      command: "reorder_collections",
      run: (workflow: DrawerMutationWorkflow) => workflow.reorderCollections(["c2", "c1"]),
    },
  ];

  describe.each(mutationCases)("$name outcome", ({ command, run }) => {
    it("reports succeeded after commit and refresh", async () => {
      const { deps, workflow } = dependencies({
        invoke: vi.fn(async () => ({ requested: 1, changed: 1, unchanged: 0 })),
      });

      await expect(run(workflow)).resolves.toMatchObject({ status: "succeeded" });
      expect(deps.invoke).toHaveBeenCalledWith(command, expect.anything());
      expect(deps.refreshAfterMutation).toHaveBeenCalledOnce();
      expect(deps.retryAfterFailure).not.toHaveBeenCalled();
    });

    it("reports committed-stale after a successful commit and failed refresh", async () => {
      const { workflow } = dependencies({
        invoke: vi.fn(async () => ({ requested: 1, changed: 1, unchanged: 0 })),
        refreshAfterMutation: vi.fn(async () => false),
      });

      await expect(run(workflow)).resolves.toMatchObject({ status: "committed-stale" });
    });

    it("reports failed and attempts recovery after command rejection", async () => {
      const failure = new Error("rejected");
      const { deps, workflow } = dependencies({
        invoke: vi.fn(async () => { throw failure; }),
      });

      await expect(run(workflow)).resolves.toEqual({ status: "failed", error: failure });
      expect(deps.refreshAfterMutation).not.toHaveBeenCalled();
      expect(deps.retryAfterFailure).toHaveBeenCalledOnce();
    });
  });

  describe("reorderItems", () => {
    it("commits the reorder, awaits the refresh barrier, and reports success", async () => {
      const { deps, workflow } = dependencies();

      await expect(workflow.reorderItems({ collectionId: "c1", orderedItemIds: ["b", "a"] }))
        .resolves.toEqual({ status: "succeeded" });

      expect(deps.invoke).toHaveBeenCalledExactlyOnceWith("reorder_favorite_items", {
        collectionId: "c1",
        ids: ["b", "a"],
      });
      expect(deps.refreshAfterMutation).toHaveBeenCalledExactlyOnceWith("Drawer item reorder refresh failed");
      expect(deps.retryAfterFailure).not.toHaveBeenCalled();
    });

    it("reports command failure and attempts recovery without a refresh", async () => {
      const failure = new Error("reorder rejected");
      const { deps, workflow } = dependencies({
        invoke: vi.fn(async () => {
          throw failure;
        }),
      });

      await expect(workflow.reorderItems({ collectionId: "c1", orderedItemIds: ["b", "a"] }))
        .resolves.toEqual({ status: "failed", error: failure });

      expect(deps.retryAfterFailure).toHaveBeenCalledExactlyOnceWith("Drawer item reorder recovery failed");
      expect(deps.refreshAfterMutation).not.toHaveBeenCalled();
    });

    it("reports committed-stale when the barrier refresh fails after the commit", async () => {
      const { deps, workflow } = dependencies({ refreshAfterMutation: vi.fn(async () => false) });

      await expect(workflow.reorderItems({ collectionId: "c1", orderedItemIds: ["b", "a"] }))
        .resolves.toEqual({ status: "committed-stale" });

      expect(deps.retryAfterFailure).not.toHaveBeenCalled();
    });
  });

  describe("addToCollection", () => {
    it("commits the membership add, awaits the refresh barrier, and reports success", async () => {
      const { deps, workflow } = dependencies();

      await expect(workflow.addToCollection({ collectionId: "c1", locator }))
        .resolves.toEqual({ status: "succeeded" });

      expect(deps.invoke).toHaveBeenCalledExactlyOnceWith("add_favorite", { collectionId: "c1", locator });
      expect(deps.refreshAfterMutation).toHaveBeenCalledExactlyOnceWith("Drawer membership refresh failed");
      expect(deps.retryAfterFailure).not.toHaveBeenCalled();
    });

    it("reports command failure and attempts recovery without a refresh", async () => {
      const failure = new Error("membership rejected");
      const { deps, workflow } = dependencies({
        invoke: vi.fn(async () => {
          throw failure;
        }),
      });

      await expect(workflow.addToCollection({ collectionId: "c1", locator }))
        .resolves.toEqual({ status: "failed", error: failure });

      expect(deps.retryAfterFailure).toHaveBeenCalledExactlyOnceWith("Drawer membership recovery failed");
      expect(deps.refreshAfterMutation).not.toHaveBeenCalled();
    });

    it("reports committed-stale when the barrier refresh fails after the commit", async () => {
      const { deps, workflow } = dependencies({ refreshAfterMutation: vi.fn(async () => false) });

      await expect(workflow.addToCollection({ collectionId: "c1", locator }))
        .resolves.toEqual({ status: "committed-stale" });

      expect(deps.retryAfterFailure).not.toHaveBeenCalled();
    });
  });

  describe("addBatchToCollection", () => {
    it("commits the batch and reports the changed and unchanged counts", async () => {
      const { deps, workflow } = dependencies({
        invoke: vi.fn(async () => ({ requested: 3, changed: 2, unchanged: 1 })),
      });

      await expect(workflow.addBatchToCollection({ collectionId: "c1", locators: [locator] }))
        .resolves.toEqual({ status: "succeeded", changed: 2, unchanged: 1 });

      expect(deps.invoke).toHaveBeenCalledExactlyOnceWith("add_favorites", {
        collectionId: "c1",
        locators: [locator],
      });
      expect(deps.refreshAfterMutation).toHaveBeenCalledExactlyOnceWith("Drawer batch membership refresh failed");
      expect(deps.retryAfterFailure).not.toHaveBeenCalled();
    });

    it("reports committed-stale when the barrier refresh fails after the commit", async () => {
      const { deps, workflow } = dependencies({ refreshAfterMutation: vi.fn(async () => false) });

      await expect(workflow.addBatchToCollection({ collectionId: "c1", locators: [locator] }))
        .resolves.toEqual({ status: "committed-stale" });

      expect(deps.retryAfterFailure).not.toHaveBeenCalled();
    });

    it("reports command failure and attempts recovery without a refresh", async () => {
      const failure = new Error("batch rejected");
      const { deps, workflow } = dependencies({
        invoke: vi.fn(async () => {
          throw failure;
        }),
      });

      await expect(workflow.addBatchToCollection({ collectionId: "c1", locators: [locator] }))
        .resolves.toEqual({ status: "failed", error: failure });

      expect(deps.retryAfterFailure).toHaveBeenCalledExactlyOnceWith("Drawer batch membership recovery failed");
      expect(deps.refreshAfterMutation).not.toHaveBeenCalled();
    });
  });
});
