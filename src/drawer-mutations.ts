// Pure Drawer mutation workflow: commit the mutation command, await the
// projection refresh barrier, and report the outcome. Imports neither Tauri
// nor DOM, so vitest runs it headless. The menu path and the drag path both
// hand it intents; callers only present the returned outcomes, so
// recovery-semantics fixes land once and apply to both.

import type { BatchMutationResult, ClipLocator } from "./types";

export type DrawerMutationOutcome =
  | { readonly status: "succeeded" }
  | { readonly status: "committed-stale" }
  | { readonly status: "failed"; readonly error: unknown };

export type DrawerMembershipBatchOutcome =
  | { readonly status: "succeeded"; readonly changed: number; readonly unchanged: number }
  | { readonly status: "committed-stale" }
  | { readonly status: "failed"; readonly error: unknown };

export interface DrawerItemReorderIntent {
  readonly collectionId: string;
  readonly orderedItemIds: readonly string[];
}

export interface DrawerMembershipAddIntent {
  readonly collectionId: string;
  readonly locator: ClipLocator;
}

export interface DrawerMembershipBatchIntent {
  readonly collectionId: string;
  readonly locators: readonly ClipLocator[];
}

export interface DrawerMutationDependencies {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  refreshAfterMutation(context: string): Promise<boolean>;
  retryAfterFailure(context: string): Promise<void>;
}

// Each Drawer mutation diagnostic is defined exactly once, here; wording
// changes cannot drift between the menu and drag copies.
const DIAGNOSTIC = {
  itemReorderRefresh: "Drawer item reorder refresh failed",
  itemReorderRecovery: "Drawer item reorder recovery failed",
  membershipRefresh: "Drawer membership refresh failed",
  membershipRecovery: "Drawer membership recovery failed",
  batchMembershipRefresh: "Drawer batch membership refresh failed",
  batchMembershipRecovery: "Drawer batch membership recovery failed",
} as const;

export class DrawerMutationWorkflow {
  constructor(private readonly dependencies: DrawerMutationDependencies) {}

  /** The single membership-lookup path, shared by the chooser and the drag. */
  memberCollectionIds(locator: ClipLocator): Promise<readonly string[]> {
    return this.dependencies.invoke("favorite_collection_ids", { locator }) as Promise<readonly string[]>;
  }

  async reorderItems(intent: DrawerItemReorderIntent): Promise<DrawerMutationOutcome> {
    return this.commitThenRefresh(
      () => this.dependencies.invoke("reorder_favorite_items", {
        collectionId: intent.collectionId,
        ids: [...intent.orderedItemIds],
      }),
      DIAGNOSTIC.itemReorderRefresh,
      DIAGNOSTIC.itemReorderRecovery,
    );
  }

  async addToCollection(intent: DrawerMembershipAddIntent): Promise<DrawerMutationOutcome> {
    return this.commitThenRefresh(
      () => this.dependencies.invoke("add_favorite", {
        collectionId: intent.collectionId,
        locator: intent.locator,
      }),
      DIAGNOSTIC.membershipRefresh,
      DIAGNOSTIC.membershipRecovery,
    );
  }

  async addBatchToCollection(
    intent: DrawerMembershipBatchIntent,
  ): Promise<DrawerMembershipBatchOutcome> {
    try {
      const result = await this.dependencies.invoke("add_favorites", {
        collectionId: intent.collectionId,
        locators: [...intent.locators],
      }) as BatchMutationResult;
      const refreshed = await this.dependencies.refreshAfterMutation(DIAGNOSTIC.batchMembershipRefresh);
      return refreshed
        ? { status: "succeeded", changed: result.changed, unchanged: result.unchanged }
        : { status: "committed-stale" };
    } catch (error) {
      await this.dependencies.retryAfterFailure(DIAGNOSTIC.batchMembershipRecovery);
      return { status: "failed", error };
    }
  }

  private async commitThenRefresh(
    commit: () => Promise<unknown>,
    refreshContext: string,
    recoveryContext: string,
  ): Promise<DrawerMutationOutcome> {
    try {
      await commit();
    } catch (error) {
      await this.dependencies.retryAfterFailure(recoveryContext);
      return { status: "failed", error };
    }
    const refreshed = await this.dependencies.refreshAfterMutation(refreshContext);
    return refreshed ? { status: "succeeded" } : { status: "committed-stale" };
  }
}
