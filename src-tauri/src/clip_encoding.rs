//! Shared Clip SQLite encoding — the single owner of the column knowledge
//! both adapters (History `clips`, Drawer `favorite_items`) must apply
//! identically: kind ↔ stored string, file-paths ↔ JSON, common-column row
//! decoding, and idempotent schema migration. Adapter-specific semantics
//! (primary keys, pinned, upsert conflict clauses, membership) stay in the
//! adapters; this module holds only encode/decode/migrate primitives.

use rusqlite::{params, Connection};

use crate::models::ClipKind;

/// Stored-string form of a [`ClipKind`].
pub(crate) fn kind_to_str(kind: &ClipKind) -> &'static str {
    match kind {
        ClipKind::Text => "Text",
        ClipKind::Image => "Image",
        ClipKind::FilePaths => "FilePaths",
    }
}

/// Inverse of [`kind_to_str`]. Unknown stored strings decode back to Text
/// (the legacy fallback) — a hand-edited row must never panic the loader.
fn kind_from_str(s: &str) -> ClipKind {
    match s {
        "Image" => ClipKind::Image,
        "FilePaths" => ClipKind::FilePaths,
        _ => ClipKind::Text,
    }
}

/// Serialize canonical file paths for storage. Serialization failure is an
/// error that propagates — canonical paths must never be silently dropped to
/// NULL by a failed write.
pub(crate) fn file_paths_to_json(file_paths: Option<&[String]>) -> Result<Option<String>, String> {
    file_paths
        .map(|paths| {
            serde_json::to_string(paths)
                .map_err(|e| format!("Failed to serialize file paths: {}", e))
        })
        .transpose()
}

/// Inverse of [`file_paths_to_json`]. Corrupt JSON degrades to `None` (the
/// legacy-row fallback, never a panic).
fn file_paths_from_json(file_paths_json: Option<String>) -> Option<Vec<String>> {
    file_paths_json.and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
}

/// The common column span both adapters select, in one canonical order, so a
/// single decode function serves both tables. Adapters put their own columns
/// around this core (History: `id` + `pinned`; Drawer: membership `added_at`)
/// and pass the span's first index to [`decode_shared_columns`].
pub(crate) const SHARED_COLUMNS: &str = "kind, text_content, image_data, thumbnail_base64,
        content_hash, preview, note, truncated, source_exe, source_title, source_icon,
        captured_at, byte_size, file_paths_json";

/// The decoded common column span (see [`SHARED_COLUMNS`]) — the in-memory
/// representation each adapter embeds into its own row type.
pub(crate) struct SharedClipColumns {
    pub kind: ClipKind,
    pub text_content: Option<String>,
    pub file_paths: Option<Vec<String>>,
    pub image_data: Option<Vec<u8>>,
    pub thumbnail_base64: Option<String>,
    pub content_hash: String,
    pub preview: String,
    pub note: Option<String>,
    pub truncated: bool,
    pub source_exe: String,
    pub source_title: String,
    pub source_icon: Option<String>,
    pub captured_at: u64,
    pub byte_size: u64,
}

/// Decode the shared column span starting at row index `first`. Timestamps
/// and byte sizes decode i64→u64, flags i64→bool; corrupt file-paths JSON
/// degrades to `None`.
pub(crate) fn decode_shared_columns(
    row: &rusqlite::Row<'_>,
    first: usize,
) -> rusqlite::Result<SharedClipColumns> {
    Ok(SharedClipColumns {
        kind: kind_from_str(&row.get::<_, String>(first)?),
        text_content: row.get(first + 1)?,
        image_data: row.get(first + 2)?,
        thumbnail_base64: row.get(first + 3)?,
        content_hash: row.get(first + 4)?,
        preview: row.get(first + 5)?,
        note: row.get(first + 6)?,
        truncated: row.get::<_, i64>(first + 7)? != 0,
        source_exe: row.get(first + 8)?,
        source_title: row.get(first + 9)?,
        source_icon: row.get(first + 10)?,
        captured_at: row.get::<_, i64>(first + 11)? as u64,
        byte_size: row.get::<_, i64>(first + 12)? as u64,
        file_paths: file_paths_from_json(row.get(first + 13)?),
    })
}

/// Does `table` have a `column`? Schema introspection via PRAGMA table_info.
pub(crate) fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let sql = format!(
        "SELECT 1 FROM pragma_table_info('{}') WHERE name = ?1",
        table
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Failed to inspect {} schema: {}", table, e))?;
    stmt.exists(params![column])
        .map_err(|e| format!("Failed to inspect {} schema: {}", table, e))
}

/// Idempotent column migration: add `column` (declared as `decl`, e.g.
/// "TEXT") only when introspection says it is missing — never by matching the
/// ALTER error string.
pub(crate) fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    decl: &str,
) -> Result<(), String> {
    if column_exists(conn, table, column)? {
        return Ok(());
    }
    conn.execute(
        &format!("ALTER TABLE {} ADD COLUMN {} {}", table, column, decl),
        [],
    )
    .map_err(|e| format!("Failed to migrate {} schema: {}", table, e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_round_trips_all_variants() {
        for kind in [ClipKind::Text, ClipKind::Image, ClipKind::FilePaths] {
            assert_eq!(kind_from_str(kind_to_str(&kind)), kind);
        }
    }

    #[test]
    fn unknown_kind_string_falls_back_to_text() {
        assert_eq!(kind_from_str("SomethingElse"), ClipKind::Text);
        assert_eq!(kind_from_str(""), ClipKind::Text);
    }

    #[test]
    fn file_paths_round_trip_exactly_including_semicolons_and_unicode() {
        let paths = vec![
            "C:\\tmp\\report;final.pdf".to_string(),
            "C:\\tmp\\  spaced  name.txt".to_string(),
            "C:\\tmp\\資料\\繁體檔名.txt".to_string(),
        ];
        let json = file_paths_to_json(Some(&paths)).unwrap();
        assert_eq!(file_paths_from_json(json).as_deref(), Some(paths.as_slice()));
    }

    #[test]
    fn file_paths_none_passes_through_both_directions() {
        assert_eq!(file_paths_to_json(None).unwrap(), None);
        assert_eq!(file_paths_from_json(None), None);
    }

    #[test]
    fn corrupt_file_paths_json_degrades_to_none() {
        assert_eq!(file_paths_from_json(Some("{not json".to_string())), None);
        assert_eq!(file_paths_from_json(Some("42".to_string())), None);
    }

    #[test]
    fn ensure_column_adds_missing_column_and_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (id TEXT PRIMARY KEY);")
            .unwrap();
        assert!(!column_exists(&conn, "t", "note").unwrap());

        ensure_column(&conn, "t", "note", "TEXT").unwrap();
        assert!(column_exists(&conn, "t", "note").unwrap());

        // Second run on the already-migrated schema must not error and must
        // not add the column twice.
        ensure_column(&conn, "t", "note", "TEXT").unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM pragma_table_info('t')", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }

    /// Locks `SHARED_COLUMNS` (column order) and `decode_shared_columns`
    /// (positional offsets) together: a row stored in the const's order must
    /// decode to exactly these fields. Without this test, adding a column to
    /// the const without shifting every offset would compile and silently
    /// misread fields.
    #[test]
    fn shared_columns_order_and_decode_offsets_stay_locked() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            &format!(
                "CREATE TABLE t ({SHARED_COLUMNS});
                 INSERT INTO t VALUES (
                    'Image', 'text', x'010203', 'thumb', 'hash', 'prev', 'note',
                    1, 'exe', 'title', 'icon', 123, 456, '[\"C:\\\\a.txt\",\"b;c.txt\"]'
                 );"
            ),
        )
        .unwrap();
        let shared = conn
            .query_row(&format!("SELECT {SHARED_COLUMNS} FROM t"), [], |row| {
                decode_shared_columns(row, 0)
            })
            .unwrap();
        assert_eq!(shared.kind, ClipKind::Image);
        assert_eq!(shared.text_content.as_deref(), Some("text"));
        assert_eq!(shared.image_data.as_deref(), Some(&[1u8, 2, 3][..]));
        assert_eq!(shared.thumbnail_base64.as_deref(), Some("thumb"));
        assert_eq!(shared.content_hash, "hash");
        assert_eq!(shared.preview, "prev");
        assert_eq!(shared.note.as_deref(), Some("note"));
        assert!(shared.truncated);
        assert_eq!(shared.source_exe, "exe");
        assert_eq!(shared.source_title, "title");
        assert_eq!(shared.source_icon.as_deref(), Some("icon"));
        assert_eq!(shared.captured_at, 123);
        assert_eq!(shared.byte_size, 456);
        assert_eq!(
            shared.file_paths.as_deref(),
            Some(
                &[
                    "C:\\a.txt".to_string(),
                    "b;c.txt".to_string(),
                ][..]
            )
        );
    }
}
