# 0004 — Publish one generation-tracked Drawer view

Date: 2026-09-01 · Status: accepted

## Context

`main.ts` and `favorites.ts` independently load and retain Drawer collections,
selection, and active items. Their separate Tauri commands and event listeners
can complete out of order or render fields from different authoritative points
in time. A shared request token would suppress some late completions but would
not make the multi-command read coherent.

## Decision

The Rust backend owns one `DrawerState` aggregate containing the favorites
store, session-only UI state, and a process-local `u64` mutation generation,
protected by one mutex. Every successful mutating command advances the
generation, including an idempotent no-op; failed commands do not. One canonical
read returns a coherent `DrawerViewState` containing the generation, open state,
ordered Collection summaries, selected Collection, and its active Drawer
snapshots.

`DrawerState` behavior methods return `DrawerMutation<T> { value, generation }`.
One Tauri adapter executes the mutation and generation advance under the
aggregate lock, releases the lock, and only then emits invalidation. The
aggregate and its tests do not depend on Tauri. If its favorites store is
unavailable, canonical reads and all mutations—including open and selection
intents—return an error without advancing the generation.

The canonical command is `get_drawer_view`. Its wire contract names the fields
`generation`, `open`, `selected_collection`, `collections`, and
`active_snapshots`; the Tauri adapter maps them to camelCase for frontend
callers. The existing `FavoriteItem` type may temporarily carry each active
snapshot's shape, but the new contract does not introduce more "favorite"
terminology. Renaming that legacy type is a separate change.

Mutations emit one invalidation event carrying only the generation. Events are
not authoritative data: the frontend reloads through the canonical read. One
app-lifetime `DrawerViewProjection` owns that reload policy and current view for
the Panel. It subscribes before its initial read, accepts only monotonic
generations, runs at most one read at a time, and performs a trailing read when
invalidated while busy. It owns Drawer toggle and selection intents but leaves
Collection CRUD, membership, note, drag, and reorder workflows in their
behavioral modules.

The published view is not updated optimistically. A failed refresh preserves
the last valid view rather than publishing a partial state. Before the first
valid view, History remains available while Drawer controls are disabled and a
localized error is shown; invalidation or a later Panel focus retries the read.

Every local Drawer mutation workflow explicitly awaits a projection refresh
after its command succeeds. `refresh()` is a barrier: it resolves with a
published view only after a canonical read that started after that refresh
request. An older in-flight read therefore forces a trailing read. Event emit is
best-effort and cannot turn an already committed mutation into a reported
failure.

The projection is built against a small injected `DrawerViewSource` seam. The
production Tauri adapter and deferred test fake both satisfy it; tests exercise
freshness only through the projection's public interface. New subscribers
immediately receive the current view with `previous = null` and are notified
with `(next, previous)` for every accepted higher generation. Transport failure
is tracked internally as stale rather than mixed into authoritative
`DrawerViewState`; `retryIfStale()` reads only when stale or no current view
exists. Initial and explicit reads reject on transport failure, while background
invalidation failures go to an injected diagnostic reporter.

The pure interfaces and Projection live in `drawer-view.ts`; the production
source and singleton live in `drawer-view-tauri.ts`. The pure module imports
neither Tauri nor DOM code.

`main.ts` is the sole composition root. `favorites.ts` exports an explicit
mount function instead of starting itself from `DOMContentLoaded`. One
composition-root subscription cancels any active Drawer drag before separately
invoking the Panel and Drawer renderers; renderer failures are isolated from one
another. This preserves the existing cancellation on every accepted higher
generation without making Projection depend on DOM.

Drawer renderer DOM lookup, rename/drag adapter construction, and listeners all
move inside `mountDrawerRenderer`; importing the module has no DOM side effects.
The Drawer toggle starts disabled in HTML. The composition root mounts
synchronously before its first await and enables Drawer controls only after the
first valid view.

Projection startup is idempotent, and `refresh`, `toggle`, `setOpen`, and
`select` ensure startup internally so callers cannot read before the
invalidation listener exists. These view intents run through one FIFO queue and
each resolves only after its barrier refresh. A failed intent rejects only
itself and cannot poison the queue. Published state is readonly and owns its
arrays.

The same-realm `favorites-create-request` event is replaced by a direct
`requestCreate` method returned from the Drawer renderer mount. Reorder recovery
no longer reads or patches Panel rows from `favorites.ts`; it awaits the
projection barrier and lets the coordinated render apply active snapshots.

If initial startup cannot read the favorites store, startup rejects but leaves
the invalidation listener registered and the projection retryable with no
current view. A read at the same generation satisfies a barrier without
republishing. Command failure rejects normally; if a toggle, explicit open, or
selection intent was committed but its barrier refresh failed, the projection
instead returns a `committed-stale` outcome so the caller cannot misreport the
mutation as failed. An unavailable favorites store is an error, never an
authoritative empty Drawer.

## Considered options

- Separate backend locks plus a coordinator lock were rejected because lock
  ordering and coherence would remain knowledge every caller must preserve.
- Read-before/read-after generation checks were rejected because they add retry
  complexity around multiple independently locked values.
- Full-state events were rejected because events may be missed, duplicated, or
  reordered and active Drawer snapshots can be large.
- Parallel frontend reloads guarded by request tokens were rejected because
  they waste IPC work and still need a coherent backend read.
- Routing every Drawer mutation through the projection was rejected because it
  would create a broad, shallow interface unrelated to freshness.
- Independent renderer subscriptions were rejected after caller audit showed
  that both renderers share drag cleanup and item-row lifecycle ordering.

## Consequences

- Open and selection operations may briefly wait behind local SQLite work on
  the aggregate mutex; this is accepted for the current local, small-data use
  case and should be measured if Drawer data volume grows materially.
- A successful no-op may cause an extra canonical read, but event coalescing
  bounds the redundant work.
- The existing duplicate frontend caches, loaders, and split favorites events
  are obsolete once both renderers migrate. The new and old contracts may
  coexist while the two renderers are migrated within one pull request, but the
  old contract is removed before that pull request is complete; no release-level
  compatibility period is required.
- Once no callers remain, the granular `list_collections`,
  `get_favorites_ui_state`, and `list_favorite_items` commands are removed so
  callers cannot bypass the coherent read. Behaviorally distinct queries such
  as membership lookup remain.
- A stale projection with a previously valid view remains interactive; backend
  validation and existing localized errors protect mutations. Drawer controls
  are disabled only before the first valid view.
- The backend aggregate lives in a new `src-tauri/src/drawer.rs` module. Its
  crate-visible interface keeps fields private; the existing in-memory
  `FavoritesStore::from_conn` factory becomes `#[cfg(test)] pub(crate)` so
  aggregate tests use the real SQLite adapter without exposing its connection
  in production.
- Regression coverage spans both seams. Rust tests verify coherent reads,
  delete-selected behavior, generation changes for success/no-op/failure, and
  active snapshots. TypeScript tests use deferred source reads to verify
  listener-before-read startup, stale completion rejection, event coalescing,
  trailing barriers, FIFO recovery, committed-stale outcomes, subscriber
  isolation, startup retry, and no republish at an equal generation.
