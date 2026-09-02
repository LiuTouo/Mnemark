//! Optional SQLite write-through persistence for the clipboard History.
//! Enabled via the `persist` config option; the database lives next to the
//! executable (`mnemark.db`) so portable installs stay self-contained.

use std::collections::HashSet;

use rusqlite::{params, Connection};

use crate::clip_encoding::{
    decode_shared_columns, ensure_column, with_shared_clip_column_params, SHARED_COLUMNS,
    SHARED_COLUMN_COUNT, SHARED_PARAMETER_MARKERS,
};
use crate::models::Clip;

/// Minimum time between stale-row reconciliations: 72 hours, in milliseconds
/// (the same unit as `Clip::captured_at` and the monitor's clock).
pub const CLEANUP_INTERVAL_MS: u64 = 72 * 60 * 60 * 1000;

/// Metadata key holding the last cleanup timestamp (ms since Unix epoch).
const LAST_CLEANUP_KEY: &str = "last_cleanup";

pub struct Persistence {
    conn: Connection,
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS clips (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            text_content TEXT,
            image_data BLOB,
            thumbnail_base64 TEXT,
            content_hash TEXT NOT NULL UNIQUE,
            preview TEXT NOT NULL,
            note TEXT,
            truncated INTEGER NOT NULL,
            source_exe TEXT NOT NULL,
            source_title TEXT NOT NULL,
            source_icon TEXT,
            captured_at INTEGER NOT NULL,
            pinned INTEGER NOT NULL,
            byte_size INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value INTEGER NOT NULL
        );",
    )
    .map_err(|e| format!("Failed to initialize database schema: {}", e))?;
    // Idempotent migrations for DBs created before structured file paths and
    // before notes — delegated to the shared encoding module.
    ensure_column(conn, "clips", "file_paths_json", "TEXT")?;
    ensure_column(conn, "clips", "note", "TEXT")?;
    Ok(())
}

impl Persistence {
    /// Open (creating if necessary) the database next to the executable.
    pub fn open() -> Result<Self, String> {
        let path = db_path();
        let conn = Connection::open(&path)
            .map_err(|e| format!("Failed to open {}: {}", path.display(), e))?;
        init_schema(&conn)?;
        Ok(Self { conn })
    }

    #[cfg(test)]
    fn from_conn(conn: Connection) -> Self {
        Self { conn }
    }

    /// Healthy in-memory store for lib-level consistency tests.
    #[cfg(test)]
    pub(crate) fn in_memory_for_test() -> Self {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        Self { conn }
    }

    #[cfg(test)]
    pub(crate) fn shared_row_image_for_test(
        &self,
        content_hash: &str,
    ) -> Vec<rusqlite::types::Value> {
        self.conn
            .query_row(
                &format!("SELECT {SHARED_COLUMNS} FROM clips WHERE content_hash = ?1"),
                params![content_hash],
                crate::clip_encoding::shared_row_image,
            )
            .unwrap()
    }

    /// Fault injection: schema initialized, then the clips table dropped, so
    /// every history write fails deterministically.
    #[cfg(test)]
    pub(crate) fn broken_for_test() -> Self {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn.execute_batch("DROP TABLE clips").unwrap();
        Self { conn }
    }

    /// Fault injection: schema initialized, then the meta table dropped, so
    /// the 72-hour cleanup gate write fails deterministically.
    #[cfg(test)]
    pub(crate) fn meta_dropped_for_test() -> Self {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn.execute_batch("DROP TABLE meta").unwrap();
        Self { conn }
    }

    /// Fault injection: reads still work, but every clips write aborts via
    /// trigger, so tests can assert durable rows stayed unchanged after a
    /// failed write. Seed rows BEFORE the triggers are installed (DELETE and
    /// UPDATE triggers only fire for rows that actually match).
    #[cfg(test)]
    pub(crate) fn writes_fail_for_test() -> Self {
        Self::writes_fail_seeded_for_test(&[])
    }

    #[cfg(test)]
    pub(crate) fn writes_fail_seeded_for_test(seed: &[Clip]) -> Self {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        let mut p = Self { conn };
        if !seed.is_empty() {
            p.dump(seed).unwrap();
        }
        p.conn
            .execute_batch(
                "CREATE TRIGGER fail_insert BEFORE INSERT ON clips
                 BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;
                 CREATE TRIGGER fail_update BEFORE UPDATE ON clips
                 BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;
                 CREATE TRIGGER fail_delete BEFORE DELETE ON clips
                 BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;",
            )
            .unwrap();
        p
    }

    /// Record the current time as the last-cleanup gate. Disabling persistence
    /// calls this so the leftover DB survives a 72-hour grace before a later
    /// startup reconciliation purges its now-stale rows.
    pub fn record_last_cleanup(&self, now_ms: u64) -> Result<(), String> {
        set_meta(&self.conn, LAST_CLEANUP_KEY, now_ms as i64)
    }

    /// Reconcile only when due. Returns `true` when a cleanup ran.
    pub fn reconcile_if_due(&mut self, active_ids: &[&str], now_ms: u64) -> Result<bool, String> {
        reconcile_if_due(&mut self.conn, active_ids, now_ms)
    }

    /// Load every Clip, oldest first, so in-memory insertion order and
    /// capacity eviction produce the correct final state.
    pub fn load_all(&self) -> Result<Vec<Clip>, String> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "SELECT id, {SHARED_COLUMNS}, pinned
                 FROM clips ORDER BY captured_at ASC"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let shared = decode_shared_columns(row, 1)?;
                Ok(Clip {
                    id: row.get(0)?,
                    pinned: row.get::<_, i64>(1 + SHARED_COLUMN_COUNT)? != 0,
                    kind: shared.kind,
                    text_content: shared.text_content,
                    file_paths: shared.file_paths,
                    image_data: shared.image_data,
                    thumbnail_base64: shared.thumbnail_base64,
                    content_hash: shared.content_hash,
                    preview: shared.preview,
                    note: shared.note,
                    truncated: shared.truncated,
                    source_exe: shared.source_exe,
                    source_title: shared.source_title,
                    source_icon: shared.source_icon,
                    captured_at: shared.captured_at,
                    byte_size: shared.byte_size,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut clips = Vec::new();
        for clip in rows {
            clips.push(clip.map_err(|e| e.to_string())?);
        }
        Ok(clips)
    }

    /// Atomically apply a planned insert (capture, undo restore, batch
    /// restore): upsert every stored Clip — a dedup collision resolves to the
    /// existing row, keeping the database's id in sync with memory — and
    /// delete every capacity-evicted id in one transaction, so the database
    /// ends holding exactly the planned active set (a partial write would
    /// resurrect deleted Clips on the next startup load).
    pub fn persist_insert_with_evictions(
        &mut self,
        stored: &[Clip],
        evicted: &[String],
    ) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        for clip in stored {
            upsert_on(&tx, clip)?;
        }
        for id in evicted {
            tx.execute("DELETE FROM clips WHERE id = ?1", params![id])
                .map_err(|e| format!("Failed to delete evicted clip: {}", e))?;
        }
        tx.commit()
            .map_err(|e| format!("Failed to commit clip insert: {}", e))
    }

    /// Replace the entire table contents with the given Clips. Transactional:
    /// a crash mid-dump must not leave the database with a partial history.
    pub fn dump(&mut self, clips: &[Clip]) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM clips", [])
            .map_err(|e| e.to_string())?;
        for clip in clips {
            upsert_on(&tx, clip)?;
        }
        tx.commit()
            .map_err(|e| format!("Failed to commit history dump: {}", e))?;
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM clips WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Delete a validated group of history rows atomically.
    pub fn delete_many(&mut self, ids: &[String]) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        for id in ids {
            tx.execute("DELETE FROM clips WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;
        }
        tx.commit()
            .map_err(|e| format!("Failed to commit batch delete: {}", e))
    }

    pub fn set_pinned(&self, id: &str, pinned: bool) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE clips SET pinned = ?1 WHERE id = ?2",
                params![pinned as i64, id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_note(&self, id: &str, note: Option<&str>) -> Result<(), String> {
        let updated = self
            .conn
            .execute(
                "UPDATE clips SET note = ?1 WHERE id = ?2",
                params![note, id],
            )
            .map_err(|e| e.to_string())?;
        if updated == 0 {
            return Err("Clip not found".to_string());
        }
        Ok(())
    }
}

/// Disable persistence: record the durable last-cleanup gate, then drop the
/// live connection. If the gate write fails the connection is left installed so
/// the caller surfaces the error (and rollback stays truthful) instead of
/// reporting success without a stored 72-hour baseline.
pub fn disable(persistence: &mut Option<Persistence>, now_ms: u64) -> Result<(), String> {
    if let Some(p) = persistence.as_ref() {
        p.record_last_cleanup(now_ms)?;
    }
    *persistence = None;
    Ok(())
}

/// Pure, deterministic due check: cleanup is due when it has never run, or at
/// least `CLEANUP_INTERVAL_MS` has elapsed since the last run. `now_ms` is an
/// explicit current timestamp so tests pin the clock.
pub fn cleanup_due(last_cleanup: Option<u64>, now_ms: u64) -> bool {
    match last_cleanup {
        None => true,
        Some(t) => now_ms.saturating_sub(t) >= CLEANUP_INTERVAL_MS,
    }
}

fn get_meta(conn: &Connection, key: &str) -> Result<Option<i64>, String> {
    let mut stmt = conn
        .prepare("SELECT value FROM meta WHERE key = ?1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map(params![key], |row| row.get::<_, i64>(0))
        .map_err(|e| e.to_string())?;
    match rows.next() {
        Some(Ok(v)) => Ok(Some(v)),
        Some(Err(e)) => Err(e.to_string()),
        None => Ok(None),
    }
}

fn set_meta(conn: &Connection, key: &str, value: i64) -> Result<(), String> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn last_cleanup_ms(conn: &Connection) -> Result<Option<u64>, String> {
    get_meta(conn, LAST_CLEANUP_KEY).map(|v| v.map(|n| n as u64))
}

fn persisted_ids(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT id FROM clips")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut ids = Vec::new();
    for id in rows {
        ids.push(id.map_err(|e| e.to_string())?);
    }
    Ok(ids)
}

/// Delete every persisted clip whose id is absent from `active_ids`, then
/// record `now_ms` as the last-cleanup time — all in one transaction, so the
/// timestamp is written only after the deletions succeed (a failure rolls both
/// back). An empty `active_ids` purges the whole table (the disabled case).
pub fn reconcile_stale(
    conn: &mut Connection,
    active_ids: &[&str],
    now_ms: u64,
) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let active: HashSet<&str> = active_ids.iter().copied().collect();
    for id in persisted_ids(&tx)? {
        if !active.contains(id.as_str()) {
            tx.execute("DELETE FROM clips WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;
        }
    }
    set_meta(&tx, LAST_CLEANUP_KEY, now_ms as i64)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Reconcile only when due. Returns `true` when a cleanup ran.
pub fn reconcile_if_due(
    conn: &mut Connection,
    active_ids: &[&str],
    now_ms: u64,
) -> Result<bool, String> {
    if !cleanup_due(last_cleanup_ms(conn)?, now_ms) {
        return Ok(false);
    }
    reconcile_stale(conn, active_ids, now_ms)?;
    Ok(true)
}

/// The upsert behind captures/restores and dump, written against
/// &Connection so a transaction (which derefs to Connection) can use it.
fn upsert_on(conn: &Connection, clip: &Clip) -> Result<(), String> {
    let pinned = clip.pinned as i64;
    with_shared_clip_column_params(clip, &[&clip.id, &pinned], |parameters| {
        conn.execute(
            &format!(
                "INSERT INTO clips ({SHARED_COLUMNS}, id, pinned)
         VALUES ({SHARED_PARAMETER_MARKERS}, ?, ?)
         ON CONFLICT(content_hash) DO UPDATE SET
            captured_at = excluded.captured_at,
            source_exe = excluded.source_exe,
            source_title = excluded.source_title,
            file_paths_json = excluded.file_paths_json"
            ),
            rusqlite::params_from_iter(parameters.iter().copied()),
        )
        .map_err(|e| format!("Failed to persist clip: {}", e))
    })?;
    Ok(())
}

pub(crate) fn db_path() -> std::path::PathBuf {
    crate::models::data_dir().join("mnemark.db")
}

/// True when the database file exists on disk. Used to decide whether a
/// disabled-persistence startup should attempt stale-row reconciliation
/// without creating a new file via `Connection::open`.
pub fn db_exists() -> bool {
    db_path().exists()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Clip, ClipKind};

    fn test_persistence() -> Persistence {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        Persistence::from_conn(conn)
    }

    fn clip(id: &str, hash: &str, captured_at: u64) -> Clip {
        Clip {
            id: id.to_string(),
            kind: ClipKind::Text,
            text_content: Some(format!("content-{id}")),
            file_paths: None,
            image_data: None,
            thumbnail_base64: None,
            content_hash: hash.to_string(),
            preview: format!("preview-{id}"),
            note: None,
            truncated: false,
            source_exe: "test.exe".to_string(),
            source_title: String::new(),
            source_icon: None,
            captured_at,
            pinned: false,
            byte_size: 10,
        }
    }

    #[test]
    fn insert_with_evictions_upserts_and_deletes_together() {
        let mut p = test_persistence();
        p.dump(&[clip("a", "ha", 1), clip("b", "hb", 2)]).unwrap();
        p.persist_insert_with_evictions(&[clip("r", "hr", 3)], &["a".to_string()])
            .unwrap();
        let mut ids: Vec<String> = p.load_all().unwrap().into_iter().map(|c| c.id).collect();
        ids.sort();
        assert_eq!(ids, vec!["b".to_string(), "r".to_string()]);
    }

    #[test]
    fn dump_replaces_all_previous_rows() {
        let mut p = test_persistence();
        p.dump(&[clip("c1", "h1", 1), clip("c2", "h2", 2)]).unwrap();
        p.dump(&[clip("c3", "h3", 3)]).unwrap();
        let clips = p.load_all().unwrap();
        assert_eq!(clips.len(), 1);
        assert_eq!(clips[0].id, "c3");
    }

    #[test]
    fn dump_round_trips_clip_fields() {
        let mut p = test_persistence();
        let mut original = clip("c1", "h1", 42);
        original.pinned = true;
        original.truncated = true;
        p.dump(std::slice::from_ref(&original)).unwrap();
        let loaded = p.load_all().unwrap();
        assert_eq!(loaded.len(), 1);
        let c = &loaded[0];
        assert_eq!(c.id, original.id);
        assert_eq!(c.content_hash, original.content_hash);
        assert_eq!(c.text_content, original.text_content);
        assert_eq!(c.captured_at, original.captured_at);
        assert!(c.pinned);
        assert!(c.truncated);
        assert_eq!(c.byte_size, original.byte_size);
    }

    #[test]
    fn file_paths_round_trip_exactly_including_semicolons_and_unicode() {
        let mut p = test_persistence();
        let paths = vec![
            "C:\\tmp\\report;final.pdf".to_string(),
            "C:\\tmp\\  spaced  name.txt".to_string(),
            "C:\\tmp\\資料\\繁體檔名.txt".to_string(),
        ];
        let mut c = clip("f1", "fh1", 1);
        c.kind = ClipKind::FilePaths;
        c.file_paths = Some(paths.clone());
        p.dump(std::slice::from_ref(&c)).unwrap();
        let loaded = p.load_all().unwrap();
        assert_eq!(loaded[0].file_paths.as_deref(), Some(paths.as_slice()));
    }

    #[test]
    fn note_round_trips_updates_and_clears() {
        let mut p = test_persistence();
        let mut c = clip("c1", "h1", 1);
        c.note = Some("first line\nsecond line".to_string());
        p.dump(std::slice::from_ref(&c)).unwrap();
        assert_eq!(
            p.load_all().unwrap()[0].note.as_deref(),
            Some("first line\nsecond line")
        );

        p.set_note("c1", Some("updated")).unwrap();
        assert_eq!(p.load_all().unwrap()[0].note.as_deref(), Some("updated"));

        p.set_note("c1", None).unwrap();
        assert_eq!(p.load_all().unwrap()[0].note, None);
    }

    #[test]
    fn duplicate_capture_preserves_existing_note() {
        let mut p = test_persistence();
        let mut original = clip("c1", "same-hash", 1);
        original.note = Some("keep me".to_string());
        p.dump(std::slice::from_ref(&original)).unwrap();

        let duplicate = clip("c2", "same-hash", 2);
        p.persist_insert_with_evictions(std::slice::from_ref(&duplicate), &[])
            .unwrap();
        assert_eq!(p.load_all().unwrap()[0].note.as_deref(), Some("keep me"));
    }

    #[test]
    fn init_schema_twice_consecutively_succeeds() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        // Second init on an already-migrated schema must not error.
        init_schema(&conn).unwrap();
    }

    #[test]
    fn old_schema_rows_without_file_paths_column_load() {
        // Simulate a pre-migration DB: create the old table shape, insert a
        // row without file_paths_json, then let init_schema migrate it.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE clips (
                id TEXT PRIMARY KEY, kind TEXT NOT NULL, text_content TEXT,
                image_data BLOB, thumbnail_base64 TEXT, content_hash TEXT NOT NULL UNIQUE,
                preview TEXT NOT NULL, truncated INTEGER NOT NULL, source_exe TEXT NOT NULL,
                source_title TEXT NOT NULL, source_icon TEXT, captured_at INTEGER NOT NULL,
                pinned INTEGER NOT NULL, byte_size INTEGER NOT NULL
            );
            CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
            INSERT INTO clips VALUES ('legacy1', 'FilePaths', 'C:\\a.txt;C:\\b.txt',
                NULL, NULL, 'legacy-hash', 'legacy', 0, 'x.exe', '', NULL, 1, 0, 20);",
        )
        .unwrap();
        init_schema(&conn).unwrap(); // idempotent ALTER adds the column
        let p = Persistence::from_conn(conn);
        let clips = p.load_all().unwrap();
        assert_eq!(clips.len(), 1);
        assert_eq!(clips[0].id, "legacy1");
        assert_eq!(clips[0].file_paths, None); // NULL column → legacy fallback
        assert_eq!(
            clips[0].text_content.as_deref(),
            Some("C:\\a.txt;C:\\b.txt")
        );
    }

    #[test]
    fn corrupt_file_paths_json_degrades_to_legacy_fallback() {
        let mut p = test_persistence();
        let mut c = clip("f2", "fh2", 1);
        c.kind = ClipKind::FilePaths;
        p.dump(std::slice::from_ref(&c)).unwrap();
        p.conn
            .execute("UPDATE clips SET file_paths_json = '{not json'", [])
            .unwrap();
        let loaded = p.load_all().unwrap();
        assert_eq!(loaded[0].file_paths, None);
    }

    #[test]
    fn cleanup_due_never_run() {
        assert!(cleanup_due(None, 0));
    }

    #[test]
    fn cleanup_not_due_before_interval() {
        let last = Some(1_000_000);
        assert!(!cleanup_due(last, 1_000_000 + CLEANUP_INTERVAL_MS - 1));
    }

    #[test]
    fn cleanup_due_at_and_after_interval() {
        let last = Some(1_000_000);
        assert!(cleanup_due(last, 1_000_000 + CLEANUP_INTERVAL_MS));
        assert!(cleanup_due(last, 1_000_000 + CLEANUP_INTERVAL_MS + 1));
    }

    #[test]
    fn reconcile_deletes_stale_rows_and_preserves_active() {
        let mut p = test_persistence();
        p.dump(&[clip("a", "ha", 1), clip("b", "hb", 2), clip("c", "hc", 3)])
            .unwrap();
        let now = 42_000_000;
        reconcile_stale(&mut p.conn, &["a", "c"], now).unwrap();
        let mut ids: Vec<String> = p.load_all().unwrap().into_iter().map(|c| c.id).collect();
        ids.sort();
        assert_eq!(ids, vec!["a".to_string(), "c".to_string()]);
        assert_eq!(last_cleanup_ms(&p.conn).unwrap(), Some(now));
    }

    #[test]
    fn reconcile_empty_active_purges_everything() {
        let mut p = test_persistence();
        p.dump(&[clip("a", "ha", 1), clip("b", "hb", 2)]).unwrap();
        reconcile_stale(&mut p.conn, &[], 7_000_000).unwrap();
        assert!(p.load_all().unwrap().is_empty());
    }

    #[test]
    fn reconcile_updates_timestamp_only_after_success() {
        // Not due → no reconciliation runs, rows and timestamp stay put.
        let mut p = test_persistence();
        p.dump(&[clip("a", "ha", 1)]).unwrap();
        p.record_last_cleanup(10_000_000).unwrap();
        let ran = p
            .reconcile_if_due(&[], 10_000_000 + CLEANUP_INTERVAL_MS - 1)
            .unwrap();
        assert!(!ran);
        assert_eq!(p.load_all().unwrap().len(), 1);
        assert_eq!(last_cleanup_ms(&p.conn).unwrap(), Some(10_000_000));
    }

    #[test]
    fn reconcile_if_due_runs_after_interval() {
        let mut p = test_persistence();
        p.dump(&[clip("a", "ha", 1)]).unwrap();
        p.record_last_cleanup(10_000_000).unwrap();
        let ran = p
            .reconcile_if_due(&[], 10_000_000 + CLEANUP_INTERVAL_MS)
            .unwrap();
        assert!(ran);
        assert!(p.load_all().unwrap().is_empty());
        assert_eq!(
            last_cleanup_ms(&p.conn).unwrap(),
            Some(10_000_000 + CLEANUP_INTERVAL_MS)
        );
    }

    #[test]
    fn disable_writes_gate_then_drops_connection() {
        let mut p = test_persistence();
        p.dump(&[clip("a", "ha", 1)]).unwrap();
        let mut opt = Some(p);
        disable(&mut opt, 5_000_000).unwrap();
        assert!(opt.is_none());
    }

    #[test]
    fn disable_keeps_connection_when_gate_write_fails() {
        let mut opt = Some(Persistence::meta_dropped_for_test());
        assert!(disable(&mut opt, 5_000_000).is_err());
        assert!(
            opt.is_some(),
            "gate write failure must not drop the connection"
        );
    }

    #[test]
    fn disable_lifecycle_records_gate_then_purges_after_grace() {
        // Disable: record the gate timestamp and leave rows in place.
        let mut p = test_persistence();
        p.dump(&[clip("a", "ha", 1)]).unwrap();
        let disabled_at = 50_000_000;
        p.record_last_cleanup(disabled_at).unwrap();
        assert_eq!(p.load_all().unwrap().len(), 1);

        // Within the grace period nothing is purged.
        assert!(!p
            .reconcile_if_due(&[], disabled_at + CLEANUP_INTERVAL_MS - 1)
            .unwrap());
        assert_eq!(p.load_all().unwrap().len(), 1);

        // After 72h, startup reconciliation purges the stale rows.
        assert!(p
            .reconcile_if_due(&[], disabled_at + CLEANUP_INTERVAL_MS)
            .unwrap());
        assert!(p.load_all().unwrap().is_empty());
    }
}
