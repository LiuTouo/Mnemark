// Shared locator vocabulary for History Clips and Drawer snapshots.

import type { Clip, ClipLocator, FavoriteItem } from "./types";

/** A FavoriteItem carries the explicit `origin: "favorite"` discriminant,
 * stamped at the single wire entrance; a history Clip never does. */
export function isFavoriteItem(item: Clip | FavoriteItem): item is FavoriteItem {
  return (item as { origin?: unknown }).origin === "favorite";
}

/** Build the item-drop locator for a history Clip or a drawer FavoriteItem.
 * Each type's `id` is the right key for its scope: a Clip id for `history`,
 * a FavoriteItem's content hash for `drawer`. */
export function clipLocator(item: Clip | FavoriteItem): ClipLocator {
  return isFavoriteItem(item) ? { scope: "drawer", id: item.id } : { scope: "history", id: item.id };
}
