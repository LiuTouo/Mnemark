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
