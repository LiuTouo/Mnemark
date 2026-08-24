// Pure state for automatic preview synchronization. No DOM, no Tauri:
// main.ts feeds it UI decisions and backend results; tests drive it directly.

export type PreviewSyncAction =
  | { type: "show"; id: string }
  | { type: "hide" }
  | { type: "none" };

/** Decide how automatic preview should follow the keyboard-selected row. */
export function decidePreviewSync(
  enabled: boolean,
  panelFocused: boolean,
  selectedId: string | null,
  currentId: string | null,
): PreviewSyncAction {
  if (!enabled) {
    return currentId === null ? { type: "none" } : { type: "hide" };
  }
  if (!panelFocused || selectedId === null || selectedId === currentId) return { type: "none" };
  return { type: "show", id: selectedId };
}

/**
 * Owns two things:
 *  1. The visibility flag (`previewId`): which clip the UI believes is shown,
 *     or null when closed. Backend `get_active_clip_preview` is the authority;
 *     this flag is only ever a mirror of it (optimistic on show, confirmed on
 *     hide/resync/show-commit).
 *  2. A monotonic mutation token, bumped only by show/hide intents (real
 *     changes the frontend requested). A resync is a read, not a mutation: it
 *     captures the token and applies its result only if no newer mutation
 *     superseded the read. This is what lets a backend show commit that lands
 *     after an earlier resync-null still re-open the preview.
 */
export class PreviewController {
  private previewId: string | null = null;
  private mutation = 0;

  get currentId(): string | null {
    return this.previewId;
  }

  get isOpen(): boolean {
    return this.previewId !== null;
  }

  /** Begin a show intent. Optimistically marks the preview open so rapid row
   * changes immediately target the latest item. Returns the mutation token
   * guarding this intent. */
  beginShow(id: string): number {
    this.mutation += 1;
    this.previewId = id;
    return this.mutation;
  }

  /** Begin a hide intent. Does NOT clear the flag: the preview stays "open"
   * until the backend confirms, so a concurrent newer show/hide wins by token.
   * Returns the mutation token guarding this intent. */
  beginHide(): number {
    this.mutation += 1;
    return this.mutation;
  }

  /** Capture the current mutation token for a backend-authoritative read. The
   * read does not bump it: a show whose commit lands after this read must
   * still be able to re-open, and only a newer show/hide makes the read stale. */
  beginResync(): number {
    return this.mutation;
  }

  /** A show committed on the backend. Re-opens `id` unless a newer show/hide
   * superseded this intent. This reconciles a resync read that ran before the
   * backend commit: the commit is newer truth, so it wins over that read. */
  resolveShow(token: number, id: string): void {
    if (token !== this.mutation) return;
    this.previewId = id;
  }

  /** A hide resolved. No-op when a newer mutation superseded this token. */
  resolveHide(token: number): void {
    if (token !== this.mutation) return;
    this.previewId = null;
  }

  /** A resync read the backend: adopt its truth. No-op when a newer show/hide
   * superseded the read. */
  resolveResync(token: number, activeId: string | null): void {
    if (token !== this.mutation) return;
    this.previewId = activeId;
  }

  /** True when `token` is still the newest mutation. A show/hide whose token is
   * still current failed while it owned the state — the caller must resync. */
  isCurrent(token: number): boolean {
    return token === this.mutation;
  }
}
