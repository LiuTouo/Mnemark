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

export interface DrawerMembershipRemoveIntent {
  readonly collectionId: string;
  readonly itemId: string;
}

export interface DrawerMembershipBatchRemoveIntent {
  readonly collectionId: string;
  readonly itemIds: readonly string[];
}

export interface DrawerMutationDependencies {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  refreshAfterMutation(context: string): Promise<boolean>;
  retryAfterFailure(context: string): Promise<void>;
}

interface MutationDiagnostic {
  readonly refresh: string;
  readonly recovery: string;
}

type DrawerMutationIncomplete =
  | { readonly status: "committed-stale" }
  | { readonly status: "failed"; readonly error: unknown };

const succeeded = () => ({ status: "succeeded" as const });

// Each Drawer mutation diagnostic is defined exactly once, here; wording
// changes cannot drift between the menu and drag copies.
const DIAGNOSTIC = {
  itemReorder: {
    refresh: "Drawer item reorder refresh failed",
    recovery: "Drawer item reorder recovery failed",
  },
  membership: {
    refresh: "Drawer membership refresh failed",
    recovery: "Drawer membership recovery failed",
  },
  batchMembership: {
    refresh: "Drawer batch membership refresh failed",
    recovery: "Drawer batch membership recovery failed",
  },
  membershipRemoval: {
    refresh: "Drawer removal refresh failed",
    recovery: "Drawer removal recovery failed",
  },
  batchRemoval: {
    refresh: "Drawer batch removal refresh failed",
    recovery: "Drawer batch removal recovery failed",
  },
  collectionCreate: {
    refresh: "Drawer create refresh failed",
    recovery: "Drawer create recovery failed",
  },
  collectionRename: {
    refresh: "Drawer rename refresh failed",
    recovery: "Drawer rename recovery failed",
  },
  collectionDelete: {
    refresh: "Drawer delete refresh failed",
    recovery: "Drawer delete recovery failed",
  },
  collectionReorder: {
    refresh: "Drawer collection reorder refresh failed",
    recovery: "Drawer collection reorder recovery failed",
  },
} as const satisfies Record<string, MutationDiagnostic>;

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
      DIAGNOSTIC.itemReorder,
      succeeded,
    );
  }

  async addToCollection(intent: DrawerMembershipAddIntent): Promise<DrawerMutationOutcome> {
    return this.commitThenRefresh(
      () => this.dependencies.invoke("add_favorite", {
        collectionId: intent.collectionId,
        locator: intent.locator,
      }),
      DIAGNOSTIC.membership,
      succeeded,
    );
  }

  async addBatchToCollection(
    intent: DrawerMembershipBatchIntent,
  ): Promise<DrawerMembershipBatchOutcome> {
    return this.commitThenRefresh(
      () => this.dependencies.invoke("add_favorites", {
        collectionId: intent.collectionId,
        locators: [...intent.locators],
      }) as Promise<BatchMutationResult>,
      DIAGNOSTIC.batchMembership,
      (result) => ({ status: "succeeded" as const, changed: result.changed, unchanged: result.unchanged }),
    );
  }

  async removeFromCollection(intent: DrawerMembershipRemoveIntent): Promise<DrawerMutationOutcome> {
    return this.commitThenRefresh(
      () => this.dependencies.invoke("remove_favorite", {
        collectionId: intent.collectionId,
        itemId: intent.itemId,
      }),
      DIAGNOSTIC.membershipRemoval,
      succeeded,
    );
  }

  async removeBatchFromCollection(
    intent: DrawerMembershipBatchRemoveIntent,
  ): Promise<DrawerMembershipBatchOutcome> {
    return this.commitThenRefresh(
      () => this.dependencies.invoke("remove_favorites", {
        collectionId: intent.collectionId,
        itemIds: [...intent.itemIds],
      }) as Promise<BatchMutationResult>,
      DIAGNOSTIC.batchRemoval,
      (result) => ({ status: "succeeded" as const, changed: result.changed, unchanged: result.unchanged }),
    );
  }

  async createCollection(name: string): Promise<DrawerMutationOutcome> {
    return this.commitThenRefresh(
      () => this.dependencies.invoke("create_collection", { name }),
      DIAGNOSTIC.collectionCreate,
      succeeded,
    );
  }

  async renameCollection(id: string, name: string): Promise<DrawerMutationOutcome> {
    return this.commitThenRefresh(
      () => this.dependencies.invoke("rename_collection", { id, name }),
      DIAGNOSTIC.collectionRename,
      succeeded,
    );
  }

  async deleteCollection(id: string): Promise<DrawerMutationOutcome> {
    return this.commitThenRefresh(
      () => this.dependencies.invoke("delete_collection", { id }),
      DIAGNOSTIC.collectionDelete,
      succeeded,
    );
  }

  async reorderCollections(orderedCollectionIds: readonly string[]): Promise<DrawerMutationOutcome> {
    return this.commitThenRefresh(
      () => this.dependencies.invoke("reorder_collections", { ids: [...orderedCollectionIds] }),
      DIAGNOSTIC.collectionReorder,
      succeeded,
    );
  }

  private async commitThenRefresh<Value, Success>(
    commit: () => Promise<Value>,
    diagnostic: MutationDiagnostic,
    success: (value: Value) => Success,
  ): Promise<Success | DrawerMutationIncomplete> {
    let value: Value;
    try {
      value = await commit();
    } catch (error) {
      await this.dependencies.retryAfterFailure(diagnostic.recovery);
      return { status: "failed", error };
    }
    const refreshed = await this.dependencies.refreshAfterMutation(diagnostic.refresh);
    return refreshed ? success(value) : { status: "committed-stale" };
  }
}
