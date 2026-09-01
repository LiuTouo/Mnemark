// Shared locator vocabulary for History Clips and Drawer snapshots.

import type { Clip, ClipLocator, FavoriteItem } from "./types";

/** A history Clip carries a `pinned` flag; a FavoriteItem does not. */
export function isFavoriteItem(item: Clip | FavoriteItem): item is FavoriteItem {
  return !("pinned" in item);
}

/** Build the item-drop locator for a history Clip or a drawer FavoriteItem.
 * Each type's `id` is the right key for its scope: a Clip id for `history`,
 * a FavoriteItem's content hash for `favorite`. */
export function clipLocator(item: Clip | FavoriteItem): ClipLocator {
  return isFavoriteItem(item) ? { scope: "favorite", id: item.id } : { scope: "history", id: item.id };
}
