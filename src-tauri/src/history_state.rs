//! Deep History aggregate: the single consistency owner for the clipboard
//! History domain. One mutex guards the in-memory store, the capacity policy,
//! the optional SQLite persistence and the last-delete undo entry, so every
//! mutation follows the same policy — validate the request, plan the complete
//! outcome, commit the durable change in one transaction (when persistence is
//! enabled), then publish the planned memory/undo state. Any validation or
//! durable failure leaves the previous state untouched.
//!
//! Tauri does not reach this module: adapters (commands, clipboard monitor,
//! located-clip source) call these behaviors and map the typed results onto
//! their existing wire contracts.

use std::collections::HashSet;

use crate::history::{HistoryPolicy, HistoryStore, StoreError};
use crate::models::{AppConfig, Clip};
use crate::persistence::{self, Persistence};

/// Typed History failures. Adapters map these onto the existing localized
/// wire errors; the frontend never parses SQLite detail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum HistoryError {
    NotFound,
    NothingToUndo,
    /// Batch request rejected before any mutation (empty, duplicate ids…).
    InvalidBatch(String),
    PinLimit,
    Persistence(String),
}

impl HistoryError {
    /// The user-facing message each variant maps to (wire contract preserved
    /// verbatim from the pre-aggregate commands).
    pub(crate) fn message(&self) -> String {
        match self {
            Self::NotFound => "Clip not found".to_string(),
            Self::NothingToUndo => "Nothing to undo".to_string(),
            Self::InvalidBatch(message) => message.clone(),
            Self::PinLimit => "Maximum 10 pinned Clips".to_string(),
            Self::Persistence(detail) => detail.clone(),
        }
    }
}

/// The most recent successful deletion. One entry for single AND batch
/// deletions: a newer successful delete transaction replaces it, a failed
/// delete leaves it unchanged, and capture/pin/note never touch it.
enum UndoEntry {
    Single(Box<Clip>),
    Batch(Vec<Clip>),
}

/// The History aggregate. ponytail: SQLite I/O runs while holding the
/// aggregate lock — for a local, bounded History, serializing mutations beats
/// letting one interleave; if write latency ever matters, measure first, and
/// do NOT fix it by re-splitting memory/persistence ownership across locks.
pub(crate) struct HistoryState {
    store: HistoryStore,
    policy: HistoryPolicy,
    persistence: Option<Persistence>,
    undo: Option<UndoEntry>,
}

impl HistoryState {
    /// Memory-only state (persistence disabled). A valid mode, not a
    /// degradation: every behavior works without persistence.
    pub(crate) fn new(policy: HistoryPolicy) -> Self {
        Self {
            store: HistoryStore::new(),
            policy,
            persistence: None,
            undo: None,
        }
    }

    // === Reads ===

    /// Display-order IPC projection (pinned first, then newest first; raw
    /// image bytes stripped).
    pub(crate) fn clips_for_ipc(&self) -> Vec<Clip> {
        self.store.get_all_for_ipc()
    }

    /// One full Clip by id (including raw image bytes) — the narrow read for
    /// copy/paste/preview resolution.
    pub(crate) fn clip(&self, id: &str) -> Option<Clip> {
        self.store.get_clip(id)
    }

    /// (source_exe, source_title) for a content hash — the monitor's
    /// Mnemark-self-source attribution lookup.
    pub(crate) fn source_by_hash(&self, content_hash: &str) -> Option<(String, String)> {
        self.store.source_by_hash(content_hash)
    }

    // === Mutations ===

    /// Store a captured Clip under dedup + capacity policy. Returns the
    /// stored Clip (on a dedup hit, the EXISTING clip's id) and the ids
    /// capacity evicted. Persistence enabled: the plan — including the dedup
    /// resolution — commits in one transaction BEFORE the memory state
    /// changes, so a durable failure leaves memory and undo untouched and no
    /// Clip exists that a restart would lose.
    pub(crate) fn capture(&mut self, clip: Clip) -> Result<(Clip, Vec<String>), HistoryError> {
        let mut plan = self.store.plan_insert(vec![clip], &self.policy);
        if let Some(p) = self.persistence.as_mut() {
            p.persist_insert_with_evictions(&plan.stored, &plan.evicted)
                .map_err(HistoryError::Persistence)?;
        }
        let stored = plan.stored.pop().expect("single insert stores one clip");
        let evicted = std::mem::take(&mut plan.evicted);
        self.store.publish_insert(plan);
        Ok((stored, evicted))
    }

    /// Delete one Clip. On success the undo entry becomes this Clip (any
    /// older entry is replaced); on any failure nothing changes.
    pub(crate) fn delete(&mut self, id: &str) -> Result<Clip, HistoryError> {
        let clip = self.store.get_clip(id).ok_or(HistoryError::NotFound)?;
        if let Some(p) = self.persistence.as_mut() {
            p.delete(id).map_err(HistoryError::Persistence)?;
        }
        let removed = self.store.delete(id);
        debug_assert!(removed.is_some());
        self.undo = Some(UndoEntry::Single(Box::new(clip.clone())));
        Ok(clip)
    }

    /// Delete a validated group of Clips in one durable transaction — all
    /// requested ids or none. Empty, duplicate-id or missing-member requests
    /// are rejected before any mutation. The undo entry keeps the deleted
    /// Clips in requested order.
    pub(crate) fn delete_many(&mut self, ids: &[String]) -> Result<Vec<Clip>, HistoryError> {
        if ids.is_empty() {
            return Err(HistoryError::InvalidBatch(
                "Batch must include at least one Clip".to_string(),
            ));
        }
        let mut seen = HashSet::new();
        if ids.iter().any(|id| !seen.insert(id.as_str())) {
            return Err(HistoryError::InvalidBatch(
                "Batch contains duplicate Clips".to_string(),
            ));
        }
        let deleted = ids
            .iter()
            .map(|id| self.store.get_clip(id).ok_or(HistoryError::NotFound))
            .collect::<Result<Vec<_>, _>>()?;
        if let Some(p) = self.persistence.as_mut() {
            p.delete_many(ids).map_err(HistoryError::Persistence)?;
        }
        for id in ids {
            let removed = self.store.delete(id);
            debug_assert!(removed.is_some());
        }
        self.undo = Some(UndoEntry::Batch(deleted.clone()));
        Ok(deleted)
    }

    /// Undo a single delete. The request must match the undo entry's identity
    /// exactly (stale-toast protection); success consumes the entry, failure
    /// preserves it for a retry after persistence recovers. Restoration uses
    /// the same plan/persist/publish path as batch undo, so a dedup collision
    /// with recaptured content resolves identically in memory and SQLite.
    pub(crate) fn undo_delete(&mut self, id: &str) -> Result<Clip, HistoryError> {
        let clip = match self.undo.as_ref() {
            Some(UndoEntry::Single(c)) if c.id == id => c.as_ref().clone(),
            _ => return Err(HistoryError::NothingToUndo),
        };
        let mut plan = self.store.plan_insert(vec![clip], &self.policy);
        if let Some(p) = self.persistence.as_mut() {
            p.persist_insert_with_evictions(&plan.stored, &plan.evicted)
                .map_err(HistoryError::Persistence)?;
        }
        let restored = plan.stored.pop().expect("single restore stores one clip");
        self.store.publish_insert(plan);
        self.undo = None;
        Ok(restored)
    }

    /// Undo a batch delete. The request must match the entry's ids in count,
    /// value and order. Restoration applies the existing dedup + capacity
    /// semantics to build ONE final planned state, which is committed
    /// durably (restores + resulting evictions in one transaction) and then
    /// published atomically — no intermediate state escapes.
    pub(crate) fn undo_delete_batch(&mut self, ids: &[String]) -> Result<(), HistoryError> {
        if ids.is_empty() {
            return Err(HistoryError::NothingToUndo);
        }
        let deleted = match self.undo.as_ref() {
            Some(UndoEntry::Batch(clips))
                if clips.len() == ids.len()
                    && clips.iter().zip(ids).all(|(clip, id)| clip.id == *id) =>
            {
                clips.clone()
            }
            _ => return Err(HistoryError::NothingToUndo),
        };
        let plan = self.store.plan_insert(deleted, &self.policy);
        if let Some(p) = self.persistence.as_mut() {
            p.persist_insert_with_evictions(&plan.stored, &plan.evicted)
                .map_err(HistoryError::Persistence)?;
        }
        self.store.publish_insert(plan);
        self.undo = None;
        Ok(())
    }

    /// Pin or unpin. Limit (max 10) and existence are validated before any
    /// write, so a rejected pin has no durable side effect and a persistence
    /// failure never leaves memory ahead of the database.
    pub(crate) fn set_pinned(&mut self, id: &str, pinned: bool) -> Result<(), HistoryError> {
        self.store
            .validate_pinned(id, pinned)
            .map_err(|e| match e {
                StoreError::PinLimit => HistoryError::PinLimit,
                StoreError::NotFound => HistoryError::NotFound,
            })?;
        if let Some(p) = self.persistence.as_mut() {
            p.set_pinned(id, pinned)
                .map_err(HistoryError::Persistence)?;
        }
        self.store.apply_pinned(id, pinned);
        Ok(())
    }

    /// Set or clear a Clip's note. Validated before the durable write; a
    /// persistence failure leaves the old note in place.
    pub(crate) fn set_note(&mut self, id: &str, note: Option<String>) -> Result<(), HistoryError> {
        if self.store.get_clip(id).is_none() {
            return Err(HistoryError::NotFound);
        }
        if let Some(p) = self.persistence.as_mut() {
            p.set_note(id, note.as_deref())
                .map_err(HistoryError::Persistence)?;
        }
        let applied = self.store.set_note(id, note);
        debug_assert_eq!(applied, Ok(()));
        Ok(())
    }

    // === Capacity policy ===

    /// Pure policy update after a successful config save. New limits apply
    /// from the next capture/restore only; existing Clips are not re-trimmed
    /// (existing observable semantics).
    pub(crate) fn set_policy(&mut self, policy: HistoryPolicy) {
        self.policy = policy;
    }

    // === Persistence lifecycle ===

    /// Enable write-through: dump the current in-memory History into the
    /// freshly opened database in one transaction, then install the
    /// connection. Any failure keeps disabled mode and the memory state.
    pub(crate) fn enable_persistence(
        &mut self,
        open: impl FnOnce() -> Result<Persistence, String>,
    ) -> Result<(), HistoryError> {
        let mut p = open().map_err(HistoryError::Persistence)?;
        p.dump(&self.store.get_all())
            .map_err(HistoryError::Persistence)?;
        self.persistence = Some(p);
        Ok(())
    }

    /// Disable write-through: record the durable last-cleanup gate, then drop
    /// the live connection. A gate failure keeps the connection installed —
    /// the error propagates instead of reporting success without a stored
    /// 72-hour cleanup baseline.
    pub(crate) fn disable_persistence(&mut self, now: u64) -> Result<(), HistoryError> {
        persistence::disable(&mut self.persistence, now).map_err(HistoryError::Persistence)
    }

    // === Startup ===

    /// Startup: load persisted history under the current policy, reconcile
    /// stale rows when due, and establish the active mode. Any open/load/
    /// reconcile failure degrades to (or continues as) memory-only operation
    /// and is reported as a diagnostic for the startup adapter to log.
    /// `db_present` says whether a database file from a prior persist-enabled
    /// run exists (drives the disabled-mode stale-row cleanup).
    pub(crate) fn bootstrap(
        config: &AppConfig,
        now: u64,
        db_present: bool,
        open: impl FnOnce() -> Result<Persistence, String>,
    ) -> (HistoryState, Vec<String>) {
        let mut state = HistoryState::new(HistoryPolicy::from(config));
        let mut diagnostics = Vec::new();
        if config.persist {
            match open() {
                Ok(mut p) => {
                    match p.load_all() {
                        Ok(clips) => {
                            for clip in clips {
                                state.store.insert(clip, &state.policy);
                            }
                        }
                        Err(e) => {
                            diagnostics.push(format!("failed to load persisted history: {}", e))
                        }
                    }
                    // Reconcile against the loaded history (already trimmed by
                    // the current limits), so rows evicted by limits leave the
                    // DB too.
                    let ids = state.store.ids();
                    let active: Vec<&str> = ids.iter().map(String::as_str).collect();
                    if let Err(e) = p.reconcile_if_due(&active, now) {
                        diagnostics.push(format!("persistence reconciliation failed: {}", e));
                    }
                    state.persistence = Some(p);
                }
                Err(e) => diagnostics.push(format!("failed to open persistence database: {}", e)),
            }
        } else if db_present {
            match open() {
                Ok(mut p) => {
                    // Empty active set: with persistence off, nothing is
                    // "live", so every leftover row is stale and is purged
                    // once due. No connection is installed — the mode stays
                    // memory-only.
                    if let Err(e) = p.reconcile_if_due(&[], now) {
                        diagnostics.push(format!("disabled-persistence cleanup failed: {}", e));
                    }
                }
                Err(e) => diagnostics.push(format!("failed to open persistence database: {}", e)),
            }
        }
        (state, diagnostics)
    }

    // === Test observation (real in-memory SQLite reload) ===

    #[cfg(test)]
    pub(crate) fn durable_ids(&self) -> Option<Vec<String>> {
        self.persistence.as_ref().map(|p| {
            let mut ids: Vec<String> = p.load_all().unwrap().into_iter().map(|c| c.id).collect();
            ids.sort();
            ids
        })
    }

    #[cfg(test)]
    pub(crate) fn durable_clips(&self) -> Option<Vec<Clip>> {
        self.persistence.as_ref().map(|p| p.load_all().unwrap())
    }

    /// Test-only: install a persistence connection directly (bypassing the
    /// enable dump) so failure-injection connections can be used.
    #[cfg(test)]
    pub(crate) fn install_persistence_for_test(&mut self, persistence: Persistence) {
        self.persistence = Some(persistence);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ClipKind;
    use std::sync::{Arc, Mutex};

    fn clip(id: &str, captured_at: u64) -> Clip {
        Clip {
            id: id.to_string(),
            kind: ClipKind::Text,
            text_content: Some(format!("content-{id}")),
            file_paths: None,
            image_data: None,
            thumbnail_base64: None,
            content_hash: format!("hash-{id}"),
            preview: id.to_string(),
            note: None,
            truncated: false,
            source_exe: "test.exe".to_string(),
            source_title: String::new(),
            source_icon: None,
            captured_at,
            pinned: false,
            byte_size: 10,
            deferred: None,        }
    }

    fn image_clip(id: &str, captured_at: u64, byte_size: u64) -> Clip {
        let mut c = clip(id, captured_at);
        c.kind = ClipKind::Image;
        c.text_content = None;
        c.image_data = Some(vec![7u8; 32]);
        c.byte_size = byte_size;
        c
    }

    fn state(policy: HistoryPolicy) -> HistoryState {
        HistoryState::new(policy)
    }

    fn persistent_state(policy: HistoryPolicy) -> HistoryState {
        let mut s = state(policy);
        s.enable_persistence(|| Ok(Persistence::in_memory_for_test()))
            .unwrap();
        s
    }

    fn memory_ids(s: &HistoryState) -> Vec<String> {
        let mut ids: Vec<String> = s.clips_for_ipc().into_iter().map(|c| c.id).collect();
        ids.sort();
        ids
    }

    fn with_limits(text_count_limit: usize, image_count_limit: usize) -> HistoryPolicy {
        HistoryPolicy {
            text_count_limit,
            image_count_limit,
            ..HistoryPolicy::default()
        }
    }

    // === Capture ===

    #[test]
    fn capture_persistence_disabled_is_pure_memory_success() {
        let mut s = state(HistoryPolicy::default());
        let (stored, evicted) = s.capture(clip("c1", 1)).unwrap();
        assert_eq!(stored.id, "c1");
        assert!(evicted.is_empty());
        assert_eq!(memory_ids(&s), vec!["c1".to_string()]);
        assert_eq!(s.durable_ids(), None);
    }

    #[test]
    fn capture_persistence_enabled_commits_memory_and_db_together() {
        let mut s = persistent_state(HistoryPolicy::default());
        s.capture(clip("c1", 1)).unwrap();
        assert_eq!(memory_ids(&s), s.durable_ids().unwrap());
        assert_eq!(s.durable_ids().unwrap(), vec!["c1".to_string()]);
    }

    #[test]
    fn capture_durable_failure_keeps_memory_undo_and_db_unchanged() {
        // Regression for the phantom-Clip bug: a failed durable write must
        // not leave a Clip that exists only for this session.
        let mut s = persistent_state(HistoryPolicy::default());
        s.capture(clip("c1", 1)).unwrap();
        s.delete("c1").unwrap(); // undo entry now holds c1; memory and DB empty
        s.persistence = Some(Persistence::writes_fail_for_test());

        assert!(matches!(
            s.capture(clip("c2", 2)),
            Err(HistoryError::Persistence(_))
        ));

        // The candidate never entered memory, and no phantom row exists.
        assert!(memory_ids(&s).is_empty());
        assert_eq!(s.durable_ids().unwrap(), Vec::<String>::new());
        // The failed capture did not disturb the undo entry.
        s.persistence = Some(Persistence::in_memory_for_test());
        assert!(s.undo_delete("c1").is_ok());
    }

    #[test]
    fn capture_dedup_under_persistence_keeps_one_row_in_memory_and_db() {
        // Dedup hit: the DB must resolve to the EXISTING clip's id too, or a
        // later delete of the visible clip leaves a ghost row that resurrects
        // after restart.
        let mut s = persistent_state(HistoryPolicy::default());
        s.capture(clip("c1", 1)).unwrap();

        let mut recapture = clip("fresh-id", 5);
        recapture.content_hash = "hash-c1".to_string();
        let (stored, evicted) = s.capture(recapture).unwrap();
        assert_eq!(stored.id, "c1");
        assert!(evicted.is_empty());
        assert_eq!(memory_ids(&s), vec!["c1".to_string()]);
        assert_eq!(s.durable_ids().unwrap(), vec!["c1".to_string()]);
        assert_eq!(s.durable_clips().unwrap()[0].captured_at, 5);

        // Deleting the visible clip removes the only row — nothing resurrects.
        s.delete("c1").unwrap();
        assert!(memory_ids(&s).is_empty());
        assert_eq!(s.durable_ids().unwrap(), Vec::<String>::new());
    }

    #[test]
    fn undo_delete_dedup_collision_keeps_recaptured_id_in_memory_and_db() {
        let mut s = persistent_state(HistoryPolicy::default());
        s.capture(clip("c1", 1)).unwrap();
        s.delete("c1").unwrap();
        let mut recapture = clip("fresh", 2);
        recapture.content_hash = "hash-c1".to_string();
        s.capture(recapture).unwrap();

        let restored = s.undo_delete("c1").unwrap();
        // The recaptured Clip wins the dedup — same id in memory AND SQLite.
        assert_eq!(restored.id, "fresh");
        assert_eq!(memory_ids(&s), vec!["fresh".to_string()]);
        assert_eq!(s.durable_ids().unwrap(), memory_ids(&s));
    }

    #[test]
    fn capture_dedup_updates_timestamp_source_keeps_note_pin() {
        let mut s = state(HistoryPolicy::default());
        s.capture(clip("c1", 1)).unwrap();
        s.set_note("c1", Some("manual note".to_string())).unwrap();
        s.set_pinned("c1", true).unwrap();

        let mut recapture = clip("fresh-id", 5);
        recapture.content_hash = "hash-c1".to_string();
        recapture.source_exe = "Other.exe".to_string();
        let (stored, evicted) = s.capture(recapture).unwrap();

        // Same Clip (the original id), refreshed recency + source.
        assert_eq!(stored.id, "c1");
        assert_eq!(stored.captured_at, 5);
        assert_eq!(stored.source_exe, "Other.exe");
        assert!(evicted.is_empty());
        assert_eq!(s.clips_for_ipc().len(), 1);
        assert_eq!(s.clip("c1").unwrap().note.as_deref(), Some("manual note"));
        assert!(s.clip("c1").unwrap().pinned);
    }

    #[test]
    fn text_count_eviction_matches_memory_and_db() {
        let mut s = persistent_state(with_limits(2, 10));
        s.capture(clip("c1", 1)).unwrap();
        s.capture(clip("c2", 2)).unwrap();
        let (_, evicted) = s.capture(clip("c3", 3)).unwrap();
        assert_eq!(evicted, vec!["c1".to_string()]);
        assert_eq!(memory_ids(&s), s.durable_ids().unwrap());
    }

    #[test]
    fn image_count_eviction_matches_memory_and_db() {
        let mut s = persistent_state(with_limits(100, 1));
        s.capture(image_clip("i1", 1, 100)).unwrap();
        let (_, evicted) = s.capture(image_clip("i2", 2, 100)).unwrap();
        assert_eq!(evicted, vec!["i1".to_string()]);
        assert_eq!(memory_ids(&s), s.durable_ids().unwrap());
        // The evicted image's bytes are gone after a reload too.
        assert!(s.durable_clips().unwrap().into_iter().all(|c| c.id != "i1"));
    }

    #[test]
    fn image_memory_budget_eviction_matches_memory_and_db() {
        let policy = HistoryPolicy {
            image_memory_budget_bytes: 1024 * 1024,
            ..HistoryPolicy::default()
        };
        let mut s = persistent_state(policy);
        s.capture(image_clip("i1", 1, 600_000)).unwrap();
        let (_, evicted) = s.capture(image_clip("i2", 2, 600_000)).unwrap();
        assert_eq!(evicted, vec!["i1".to_string()]);
        assert_eq!(memory_ids(&s), s.durable_ids().unwrap());
    }

    #[test]
    fn pinned_clips_exempt_from_capacity_in_memory_and_db() {
        let mut s = persistent_state(with_limits(2, 10));
        s.capture(clip("c1", 1)).unwrap();
        s.capture(clip("c2", 2)).unwrap();
        s.capture(clip("c3", 3)).unwrap(); // evicts c1
        s.set_pinned("c2", true).unwrap();

        let (_, evicted) = s.capture(clip("c4", 4)).unwrap();
        assert_eq!(evicted, vec!["c3".to_string()], "pinned c2 survives");
        assert!(s.clip("c2").unwrap().pinned);
        assert_eq!(memory_ids(&s), s.durable_ids().unwrap());
    }

    // === Single delete ===

    #[test]
    fn delete_success_updates_memory_db_and_undo() {
        let mut s = persistent_state(HistoryPolicy::default());
        s.capture(clip("c1", 1)).unwrap();
        let deleted = s.delete("c1").unwrap();
        assert_eq!(deleted.id, "c1");
        assert!(memory_ids(&s).is_empty());
        assert_eq!(s.durable_ids().unwrap(), Vec::<String>::new());
        assert!(s.undo_delete("c1").is_ok(), "delete made c1 undoable");
    }

    #[test]
    fn delete_missing_id_rejected_without_side_effects() {
        let mut s = state(HistoryPolicy::default());
        s.capture(clip("c1", 1)).unwrap();
        assert_eq!(s.delete("nope").unwrap_err(), HistoryError::NotFound);
        assert_eq!(memory_ids(&s), vec!["c1".to_string()]);
    }

    #[test]
    fn delete_durable_failure_preserves_clip_and_previous_undo() {
        let mut s = persistent_state(HistoryPolicy::default());
        s.capture(clip("c1", 1)).unwrap();
        s.capture(clip("c2", 2)).unwrap();
        s.delete("c1").unwrap(); // previous successful delete set the undo entry
                                 // A live connection whose deletes abort (c2's row present, so the
                                 // trigger fires).
        s.persistence = Some(Persistence::writes_fail_seeded_for_test(&[clip("c2", 2)]));

        assert!(matches!(s.delete("c2"), Err(HistoryError::Persistence(_))));
        assert_eq!(memory_ids(&s), vec!["c2".to_string()]);
        assert_eq!(s.durable_ids().unwrap(), vec!["c2".to_string()]);
        // The failed newer delete did not touch c1's undo eligibility.
        s.persistence = Some(Persistence::in_memory_for_test());
        assert!(s.undo_delete("c1").is_ok());
    }

    // === Batch delete ===

    #[test]
    fn delete_many_success_all_or_nothing_in_requested_order() {
        let mut s = persistent_state(HistoryPolicy::default());
        for (id, at) in [("c1", 1), ("c2", 2), ("c3", 3)] {
            s.capture(clip(id, at)).unwrap();
        }
        let ids = vec!["c3".to_string(), "c1".to_string()];
        let deleted = s.delete_many(&ids).unwrap();
        assert_eq!(
            deleted.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            vec!["c3", "c1"],
            "requested order preserved"
        );
        assert_eq!(memory_ids(&s), vec!["c2".to_string()]);
        assert_eq!(s.durable_ids().unwrap(), vec!["c2".to_string()]);
        assert!(s.undo_delete_batch(&ids).is_ok());
    }

    #[test]
    fn delete_many_invalid_requests_rejected_before_any_mutation() {
        let mut s = state(HistoryPolicy::default());
        s.capture(clip("c1", 1)).unwrap();
        s.capture(clip("c2", 2)).unwrap();

        assert_eq!(
            s.delete_many(&[]).unwrap_err(),
            HistoryError::InvalidBatch("Batch must include at least one Clip".to_string())
        );
        assert_eq!(
            s.delete_many(&["c1".to_string(), "c1".to_string()])
                .unwrap_err(),
            HistoryError::InvalidBatch("Batch contains duplicate Clips".to_string())
        );
        assert_eq!(
            s.delete_many(&["c1".to_string(), "gone".to_string()])
                .unwrap_err(),
            HistoryError::NotFound
        );
        assert_eq!(memory_ids(&s), vec!["c1".to_string(), "c2".to_string()]);
        // No undo eligibility was created by any rejected request.
        assert_eq!(
            s.undo_delete("c1").unwrap_err(),
            HistoryError::NothingToUndo
        );
        assert_eq!(
            s.undo_delete_batch(&["c1".to_string()]).unwrap_err(),
            HistoryError::NothingToUndo
        );
    }

    #[test]
    fn delete_many_durable_failure_leaves_nothing_deleted() {
        let mut s = state(HistoryPolicy::default());
        s.capture(clip("c1", 1)).unwrap();
        s.capture(clip("c2", 2)).unwrap();
        s.persistence = Some(Persistence::writes_fail_seeded_for_test(&[
            clip("c1", 1),
            clip("c2", 2),
        ]));

        assert!(matches!(
            s.delete_many(&["c1".to_string(), "c2".to_string()]),
            Err(HistoryError::Persistence(_))
        ));
        assert_eq!(memory_ids(&s), vec!["c1".to_string(), "c2".to_string()]);
        assert_eq!(
            s.durable_ids().unwrap(),
            vec!["c1".to_string(), "c2".to_string()]
        );
    }

    // === Undo: single and batch ===

    #[test]
    fn undo_matches_identity_and_consumes_entry() {
        let mut s = state(HistoryPolicy::default());
        s.capture(clip("c1", 1)).unwrap();
        s.delete("c1").unwrap();

        // Stale toast id: rejected, entry kept.
        assert_eq!(
            s.undo_delete("other").unwrap_err(),
            HistoryError::NothingToUndo
        );
        assert!(s.undo_delete("c1").is_ok());
        // Successful undo consumes the entry: no double-undo.
        assert_eq!(
            s.undo_delete("c1").unwrap_err(),
            HistoryError::NothingToUndo
        );
    }

    #[test]
    fn undo_batch_matches_ids_count_value_and_order() {
        let mut s = state(HistoryPolicy::default());
        for (id, at) in [("c1", 1), ("c2", 2)] {
            s.capture(clip(id, at)).unwrap();
        }
        let ids = vec!["c1".to_string(), "c2".to_string()];
        s.delete_many(&ids).unwrap();

        // Wrong order is a stale request.
        assert_eq!(
            s.undo_delete_batch(&["c2".to_string(), "c1".to_string()])
                .unwrap_err(),
            HistoryError::NothingToUndo
        );
        assert_eq!(
            s.undo_delete_batch(&["c1".to_string()]).unwrap_err(),
            HistoryError::NothingToUndo
        );
        s.undo_delete_batch(&ids).unwrap();
        assert_eq!(
            s.undo_delete_batch(&ids).unwrap_err(),
            HistoryError::NothingToUndo
        );
    }

    #[test]
    fn newer_delete_replaces_older_undo_across_single_and_batch() {
        let mut s = state(HistoryPolicy::default());
        for (id, at) in [("c1", 1), ("c2", 2), ("c3", 3)] {
            s.capture(clip(id, at)).unwrap();
        }
        let batch_ids = vec!["c1".to_string(), "c2".to_string()];

        // Batch, then single: the single wins.
        s.delete_many(&batch_ids).unwrap();
        s.delete("c3").unwrap();
        assert_eq!(
            s.undo_delete_batch(&batch_ids).unwrap_err(),
            HistoryError::NothingToUndo
        );
        assert!(s.undo_delete("c3").is_ok());

        // Single, then batch: the batch wins.
        s.capture(clip("c4", 4)).unwrap();
        s.capture(clip("c5", 5)).unwrap();
        s.delete("c3").unwrap();
        let batch2 = vec!["c4".to_string(), "c5".to_string()];
        s.delete_many(&batch2).unwrap();
        assert_eq!(
            s.undo_delete("c3").unwrap_err(),
            HistoryError::NothingToUndo
        );
        assert!(s.undo_delete_batch(&batch2).is_ok());
    }

    #[test]
    fn undo_durable_failure_preserves_entry_for_retry() {
        let mut s = persistent_state(HistoryPolicy::default());
        s.capture(clip("c1", 1)).unwrap();
        s.delete("c1").unwrap();
        s.persistence = Some(Persistence::writes_fail_for_test());

        assert!(matches!(
            s.undo_delete("c1"),
            Err(HistoryError::Persistence(_))
        ));
        assert!(
            memory_ids(&s).is_empty(),
            "history untouched by failed undo"
        );
        assert_eq!(
            s.durable_ids().unwrap(),
            Vec::<String>::new(),
            "no partial restore hit the database"
        );
        // Retry after persistence recovers succeeds.
        s.persistence = Some(Persistence::in_memory_for_test());
        let restored = s.undo_delete("c1").unwrap();
        assert_eq!(restored.id, "c1");
        assert_eq!(memory_ids(&s), vec!["c1".to_string()]);
    }

    #[test]
    fn undo_restore_and_capacity_evictions_commit_together() {
        // Capacity 1: restoring c1 must evict c2 in memory AND the DB.
        let mut s = persistent_state(with_limits(1, 10));
        s.capture(clip("c1", 3)).unwrap();
        s.delete("c1").unwrap();
        s.capture(clip("c2", 2)).unwrap();

        let restored = s.undo_delete("c1").unwrap();
        assert_eq!(restored.id, "c1");
        assert_eq!(memory_ids(&s), vec!["c1".to_string()]);
        assert_eq!(s.durable_ids().unwrap(), vec!["c1".to_string()]);
    }

    #[test]
    fn undo_batch_applies_capacity_atomically_with_reload_parity() {
        let mut s = persistent_state(with_limits(2, 10));
        for (id, at) in [("c1", 4), ("c2", 3)] {
            s.capture(clip(id, at)).unwrap();
        }
        let ids = vec!["c1".to_string(), "c2".to_string()];
        s.delete_many(&ids).unwrap();
        s.capture(clip("c3", 2)).unwrap();
        s.capture(clip("c4", 1)).unwrap();

        s.undo_delete_batch(&ids).unwrap();
        assert_eq!(memory_ids(&s), vec!["c1".to_string(), "c2".to_string()]);
        assert_eq!(s.durable_ids().unwrap(), memory_ids(&s));
    }

    #[test]
    fn undo_batch_dedup_collision_keeps_recaptured_clip_and_db_parity() {
        let mut s = persistent_state(HistoryPolicy::default());
        s.capture(clip("c1", 1)).unwrap();
        let ids = vec!["c1".to_string()];
        s.delete_many(&ids).unwrap();

        // Content re-captured after the delete: a new Clip with the same hash.
        let mut recapture = clip("fresh", 2);
        recapture.content_hash = "hash-c1".to_string();
        s.capture(recapture).unwrap();

        s.undo_delete_batch(&ids).unwrap();
        // The recaptured Clip wins the dedup; the old id does not resurrect.
        assert_eq!(memory_ids(&s), vec!["fresh".to_string()]);
        assert_eq!(s.durable_ids().unwrap(), memory_ids(&s));
    }

    #[test]
    fn capture_pin_note_do_not_invalidate_undo() {
        let mut s = state(HistoryPolicy::default());
        s.capture(clip("c1", 1)).unwrap();
        s.capture(clip("c2", 2)).unwrap();
        s.delete("c1").unwrap();

        s.capture(clip("c3", 3)).unwrap();
        s.set_pinned("c2", true).unwrap();
        s.set_note("c2", Some("note".to_string())).unwrap();
        assert!(s.undo_delete("c1").is_ok());
    }

    // === Pin ===

    #[test]
    fn set_pinned_success_updates_memory_db_and_display_order() {
        let mut s = persistent_state(HistoryPolicy::default());
        s.capture(clip("c1", 1)).unwrap();
        s.capture(clip("c2", 2)).unwrap();

        s.set_pinned("c1", true).unwrap();
        assert!(s.clip("c1").unwrap().pinned);
        let ipc = s.clips_for_ipc();
        assert_eq!(ipc[0].id, "c1", "pinned sorts first despite older age");
        assert!(s.durable_clips().unwrap()[0].pinned, "pin reached the DB");

        s.set_pinned("c1", false).unwrap();
        assert!(!s.clip("c1").unwrap().pinned);
        assert_eq!(s.clips_for_ipc()[0].id, "c2");
        // Idempotent no-op state changes succeed.
        s.set_pinned("c1", false).unwrap();
    }

    #[test]
    fn set_pinned_limit_rejected_before_any_write() {
        let mut s = persistent_state(with_limits(20, 20));
        for i in 1..=11 {
            s.capture(clip(&format!("p{i}"), i as u64)).unwrap();
        }
        for i in 1..=10 {
            s.set_pinned(&format!("p{i}"), true).unwrap();
        }
        assert_eq!(s.set_pinned("p11", true), Err(HistoryError::PinLimit));
        assert!(!s.clip("p11").unwrap().pinned);
        // The durable side never saw the 11th pin.
        assert_eq!(
            s.durable_clips()
                .unwrap()
                .into_iter()
                .filter(|c| c.pinned)
                .count(),
            10
        );
    }

    #[test]
    fn set_pinned_durable_failure_keeps_memory_pin_state() {
        let mut s = state(HistoryPolicy::default());
        s.capture(clip("c1", 1)).unwrap();
        // c1's row present so the update-abort trigger fires.
        s.persistence = Some(Persistence::writes_fail_seeded_for_test(&[clip("c1", 1)]));

        assert!(matches!(
            s.set_pinned("c1", true),
            Err(HistoryError::Persistence(_))
        ));
        assert!(!s.clip("c1").unwrap().pinned);
        assert!(!s.durable_clips().unwrap()[0].pinned);
    }

    #[test]
    fn set_pinned_missing_id_is_not_found() {
        let mut s = state(HistoryPolicy::default());
        assert_eq!(s.set_pinned("nope", true), Err(HistoryError::NotFound));
    }

    // === Note ===

    #[test]
    fn set_note_update_clear_and_reload_parity() {
        let mut s = persistent_state(HistoryPolicy::default());
        s.capture(clip("c1", 1)).unwrap();

        s.set_note("c1", Some("first".to_string())).unwrap();
        assert_eq!(s.clip("c1").unwrap().note.as_deref(), Some("first"));
        s.set_note("c1", Some("second".to_string())).unwrap();
        assert_eq!(
            s.durable_clips().unwrap()[0].note.as_deref(),
            Some("second")
        );
        s.set_note("c1", None).unwrap();
        assert_eq!(s.clip("c1").unwrap().note, None);
        assert_eq!(s.durable_clips().unwrap()[0].note, None);
    }

    #[test]
    fn set_note_errors_keep_previous_note() {
        let mut s = persistent_state(HistoryPolicy::default());
        s.capture(clip("c1", 1)).unwrap();
        s.set_note("c1", Some("old".to_string())).unwrap();

        assert_eq!(
            s.set_note("missing", Some("x".to_string())),
            Err(HistoryError::NotFound)
        );

        s.persistence = Some(Persistence::writes_fail_seeded_for_test(&[clip("c1", 1)]));
        assert!(matches!(
            s.set_note("c1", Some("new".to_string())),
            Err(HistoryError::Persistence(_))
        ));
        assert_eq!(s.clip("c1").unwrap().note.as_deref(), Some("old"));
    }

    // === Persistence lifecycle ===

    #[test]
    fn enable_dumps_current_history_then_writes_through() {
        let mut s = state(HistoryPolicy::default());
        s.capture(clip("c1", 1)).unwrap();
        s.enable_persistence(|| Ok(Persistence::in_memory_for_test()))
            .unwrap();
        // Initial dump preserved the pre-existing Clip.
        assert_eq!(s.durable_ids().unwrap(), vec!["c1".to_string()]);
        s.capture(clip("c2", 2)).unwrap();
        assert_eq!(s.durable_ids().unwrap(), memory_ids(&s));
    }

    #[test]
    fn enable_failure_keeps_disabled_mode_and_memory() {
        let mut s = state(HistoryPolicy::default());
        s.capture(clip("c1", 1)).unwrap();

        // Open failure.
        assert!(matches!(
            s.enable_persistence(|| Err("cannot open".to_string())),
            Err(HistoryError::Persistence(_))
        ));
        assert_eq!(s.durable_ids(), None);

        // Dump failure (clips table gone).
        assert!(s
            .enable_persistence(|| Ok(Persistence::broken_for_test()))
            .is_err());
        assert_eq!(s.durable_ids(), None);
        // Still fully usable in-memory; nothing was lost.
        s.capture(clip("c2", 2)).unwrap();
        assert_eq!(memory_ids(&s), vec!["c1".to_string(), "c2".to_string()]);
    }

    #[test]
    fn disable_stops_write_through_and_reenable_dumps_fully() {
        let mut s = persistent_state(HistoryPolicy::default());
        s.capture(clip("c1", 1)).unwrap();

        s.disable_persistence(5_000_000).unwrap();
        s.capture(clip("c2", 2)).unwrap();
        assert_eq!(s.durable_ids(), None);
        assert_eq!(memory_ids(&s), vec!["c1".to_string(), "c2".to_string()]);

        // Re-enable dumps the full current history — the disabled-window
        // capture is not missing.
        s.enable_persistence(|| Ok(Persistence::in_memory_for_test()))
            .unwrap();
        assert_eq!(s.durable_ids().unwrap(), memory_ids(&s));
    }

    #[test]
    fn disable_gate_failure_keeps_enabled_connection() {
        let mut s = state(HistoryPolicy::default());
        s.persistence = Some(Persistence::meta_dropped_for_test());

        assert!(matches!(
            s.disable_persistence(5_000_000),
            Err(HistoryError::Persistence(_))
        ));
        // Mode stayed enabled: a capture still reaches the database.
        s.capture(clip("c1", 1)).unwrap();
        assert_eq!(s.durable_ids().unwrap(), vec!["c1".to_string()]);
    }

    // === Startup bootstrap ===

    #[test]
    fn bootstrap_no_db_is_clean_memory_only_state() {
        let config = AppConfig::default();
        let (mut s, diagnostics) = HistoryState::bootstrap(&config, 0, false, || unreachable!());
        assert!(diagnostics.is_empty());
        assert_eq!(s.durable_ids(), None);
        s.capture(clip("c1", 1)).unwrap();
        assert_eq!(memory_ids(&s), vec!["c1".to_string()]);
    }

    #[test]
    fn bootstrap_loads_persisted_history_under_limits_and_reconciles_when_due() {
        let mut p = Persistence::in_memory_for_test();
        for (id, at) in [("c1", 1), ("c2", 2), ("c3", 3)] {
            p.persist_insert_with_evictions(&[clip(id, at)], &[])
                .unwrap();
        }
        let holder = Arc::new(Mutex::new(Some(p)));
        let for_open = Arc::clone(&holder);
        let config = AppConfig {
            persist: true,
            text_count_limit: 2,
            ..Default::default()
        };

        // Never-run cleanup → due: rows evicted by the current limit leave
        // the DB in the same startup.
        let (s, diagnostics) = HistoryState::bootstrap(&config, 42_000_000, false, move || {
            for_open
                .lock()
                .unwrap()
                .take()
                .ok_or_else(|| "closed".to_string())
        });
        assert!(diagnostics.is_empty());
        assert_eq!(
            memory_ids(&s),
            vec!["c2".to_string(), "c3".to_string()],
            "oldest row evicted by the current limit"
        );
        assert_eq!(s.durable_ids().unwrap(), memory_ids(&s));
    }

    #[test]
    fn bootstrap_open_failure_degrades_to_memory_only() {
        let config = AppConfig {
            persist: true,
            ..Default::default()
        };
        let (mut s, diagnostics) =
            HistoryState::bootstrap(&config, 0, false, || Err("locked".to_string()));
        assert_eq!(
            diagnostics,
            vec!["failed to open persistence database: locked".to_string()]
        );
        assert_eq!(s.durable_ids(), None);
        // The app keeps running memory-only; captures still succeed.
        s.capture(clip("c1", 1)).unwrap();
        assert_eq!(memory_ids(&s), vec!["c1".to_string()]);
    }

    #[test]
    fn bootstrap_disabled_mode_opens_db_for_stale_row_cleanup() {
        let mut p = Persistence::in_memory_for_test();
        p.dump(&[clip("leftover", 1)]).unwrap();
        let holder = Mutex::new(Some(p));
        let (opened_tx, opened_rx) = std::sync::mpsc::channel();
        let config = AppConfig::default(); // persist = false
        let (s, diagnostics) = HistoryState::bootstrap(&config, 99_000_000, true, move || {
            let opened = holder
                .lock()
                .unwrap()
                .take()
                .ok_or_else(|| "closed".to_string())?;
            // Rows were present when the aggregate opened the database.
            let _ = opened_tx.send(opened.load_all().unwrap().len());
            Ok(opened)
        });
        assert!(diagnostics.is_empty(), "due cleanup ran without failure");
        assert_eq!(s.durable_ids(), None, "disabled mode holds no connection");
        assert_eq!(opened_rx.recv().unwrap(), 1, "leftover row seen at open");
    }

    #[test]
    fn bootstrap_not_due_keeps_rows_and_reports_nothing() {
        let mut p = Persistence::in_memory_for_test();
        p.dump(&[clip("c1", 1)]).unwrap();
        p.record_last_cleanup(10_000_000).unwrap();
        let holder = Mutex::new(Some(p));
        let config = AppConfig {
            persist: true,
            ..Default::default()
        };
        let (s, diagnostics) = HistoryState::bootstrap(
            &config,
            10_000_000 + persistence::CLEANUP_INTERVAL_MS - 1,
            false,
            move || {
                holder
                    .lock()
                    .unwrap()
                    .take()
                    .ok_or_else(|| "closed".to_string())
            },
        );
        assert!(diagnostics.is_empty());
        // The active mode kept the connection, so the durable state is
        // observable: nothing was purged before it was due.
        assert_eq!(memory_ids(&s), vec!["c1".to_string()]);
        assert_eq!(s.durable_ids().unwrap(), vec!["c1".to_string()]);
    }

    // === Capacity policy update ===

    #[test]
    fn policy_update_applies_only_to_future_capture_and_restore() {
        let mut s = persistent_state(with_limits(3, 10));
        for (id, at) in [("c1", 1), ("c2", 2), ("c3", 3)] {
            s.capture(clip(id, at)).unwrap();
        }

        // Shrinking the limit does NOT trim existing history.
        s.set_policy(with_limits(2, 10));
        assert_eq!(
            memory_ids(&s),
            vec!["c1".to_string(), "c2".to_string(), "c3".to_string()]
        );

        // The next capture applies the new limit.
        s.capture(clip("c4", 4)).unwrap();
        assert_eq!(memory_ids(&s), vec!["c3".to_string(), "c4".to_string()]);
        assert_eq!(s.durable_ids().unwrap(), memory_ids(&s));
    }

    // === Reads ===

    #[test]
    fn reads_strip_ipc_image_bytes_but_resolve_full_clips() {
        let mut s = state(HistoryPolicy::default());
        s.capture(image_clip("i1", 1, 100)).unwrap();
        s.capture(clip("t1", 2)).unwrap();

        let ipc = s.clips_for_ipc();
        assert_eq!(ipc[0].id, "t1");
        assert_eq!(ipc[1].id, "i1");
        assert_eq!(ipc[1].image_data, None);

        let full = s.clip("i1").unwrap();
        assert_eq!(full.image_data.as_deref(), Some(&[7u8; 32][..]));
        assert_eq!(
            s.source_by_hash("hash-i1").map(|(exe, _)| exe),
            Some("test.exe".to_string())
        );
        assert_eq!(s.source_by_hash("nope"), None);
    }

    // === Error contract ===

    #[test]
    fn error_messages_preserve_existing_wire_strings() {
        assert_eq!(HistoryError::NotFound.message(), "Clip not found");
        assert_eq!(HistoryError::NothingToUndo.message(), "Nothing to undo");
        assert_eq!(
            HistoryError::InvalidBatch("Batch must include at least one Clip".to_string())
                .message(),
            "Batch must include at least one Clip"
        );
        assert_eq!(HistoryError::PinLimit.message(), "Maximum 10 pinned Clips");
        assert_eq!(HistoryError::Persistence("db".to_string()).message(), "db");
    }

    // === Concurrency ===

    #[test]
    fn concurrent_delete_undo_and_capture_stay_consistent() {
        let mut s = persistent_state(HistoryPolicy::default());
        s.capture(clip("c1", 1)).unwrap();
        let s = Arc::new(Mutex::new(s));

        let contender = {
            let s = Arc::clone(&s);
            std::thread::spawn(move || {
                for _ in 0..50 {
                    let mut guard = s.lock().unwrap();
                    if guard.delete("c1").is_ok() {
                        let _ = guard.undo_delete("c1");
                    }
                }
            })
        };
        let capturer = {
            let s = Arc::clone(&s);
            std::thread::spawn(move || {
                for i in 0..50 {
                    let mut guard = s.lock().unwrap();
                    let _ = guard.capture(clip(&format!("cap{i}"), 100 + i));
                }
            })
        };
        contender.join().unwrap();
        capturer.join().unwrap();

        // Serialized outcomes: whatever the interleaving was, memory and the
        // database agree. (Test completion also proves no deadlock.)
        let guard = s.lock().unwrap();
        assert_eq!(guard.durable_ids().unwrap(), memory_ids(&guard));
    }
}
