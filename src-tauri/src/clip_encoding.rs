//! Shared Clip SQLite encoding — the single owner of the column knowledge
//! both adapters (History `clips`, Drawer `favorite_items`) must apply
//! identically: kind ↔ stored string, file-paths ↔ JSON, common-column row
//! decoding, and idempotent schema migration. Adapter-specific semantics
//! (primary keys, pinned, upsert conflict clauses, membership) stay in the
//! adapters; this module holds only encode/decode/migrate primitives.

use rusqlite::{params, Connection, ToSql};

#[cfg(test)]
use rusqlite::types::Value;

use crate::models::{Clip, ClipKind, FavoriteItem};

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
pub(crate) const SHARED_COLUMN_COUNT: usize = 14;

/// Positional parameters matching [`SHARED_COLUMNS`]. Adapters append their
/// own fields after this stable shared span.
pub(crate) const SHARED_PARAMETER_MARKERS: &str = "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?";

macro_rules! bind_shared_clip_fields {
    ($clip:expr, $trailing:expr, $operation:expr) => {{
        let file_paths_json = file_paths_to_json($clip.file_paths.as_deref())?;
        let kind = kind_to_str(&$clip.kind);
        let truncated = $clip.truncated as i64;
        let captured_at = $clip.captured_at as i64;
        let byte_size = $clip.byte_size as i64;
        let mut parameters: Vec<&dyn ToSql> = vec![
            &kind,
            &$clip.text_content,
            &$clip.image_data,
            &$clip.thumbnail_base64,
            &$clip.content_hash,
            &$clip.preview,
            &$clip.note,
            &truncated,
            &$clip.source_exe,
            &$clip.source_title,
            &$clip.source_icon,
            &captured_at,
            &byte_size,
            &file_paths_json,
        ];
        parameters.extend_from_slice($trailing);
        $operation(&parameters)
    }};
}

/// A Clip-shaped model that can bind the shared SQLite column span. The field
/// mapping stays inside this module so adapters never enumerate it.
pub(crate) trait EncodesSharedClipColumns {
    fn with_shared_clip_column_params<T>(
        &self,
        trailing: &[&dyn ToSql],
        operation: impl FnOnce(&[&dyn ToSql]) -> Result<T, String>,
    ) -> Result<T, String>;
}

impl EncodesSharedClipColumns for Clip {
    fn with_shared_clip_column_params<T>(
        &self,
        trailing: &[&dyn ToSql],
        operation: impl FnOnce(&[&dyn ToSql]) -> Result<T, String>,
    ) -> Result<T, String> {
        bind_shared_clip_fields!(self, trailing, operation)
    }
}

impl EncodesSharedClipColumns for FavoriteItem {
    fn with_shared_clip_column_params<T>(
        &self,
        trailing: &[&dyn ToSql],
        operation: impl FnOnce(&[&dyn ToSql]) -> Result<T, String>,
    ) -> Result<T, String> {
        bind_shared_clip_fields!(self, trailing, operation)
    }
}

/// Bind [`SHARED_COLUMNS`] in canonical order for either persistent Clip
/// role, followed by any adapter-specific parameters. The callback keeps all
/// values borrowed during statement execution; raw image bytes are not cloned.
pub(crate) fn with_shared_clip_column_params<T>(
    clip: &impl EncodesSharedClipColumns,
    trailing: &[&dyn ToSql],
    operation: impl FnOnce(&[&dyn ToSql]) -> Result<T, String>,
) -> Result<T, String> {
    clip.with_shared_clip_column_params(trailing, operation)
}

#[cfg(test)]
pub(crate) fn shared_row_image(row: &rusqlite::Row<'_>) -> rusqlite::Result<Vec<Value>> {
    (0..SHARED_COLUMN_COUNT)
        .map(|index| row.get(index))
        .collect()
}

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
    use crate::favorites::FavoritesStore;
    use crate::models::{Clip, FavoriteItem};
    use crate::persistence::Persistence;

    fn clip(kind: ClipKind) -> Clip {
        let (text_content, file_paths, image_data, thumbnail_base64, truncated, byte_size) =
            match kind {
                ClipKind::Text => (
                    Some("truncated text".to_string()),
                    None,
                    None,
                    None,
                    true,
                    4_096,
                ),
                ClipKind::Image => (
                    None,
                    None,
                    Some(vec![0, 1, 2, 255]),
                    Some("data:image/jpeg;base64,dGh1bWI=".to_string()),
                    false,
                    4,
                ),
                ClipKind::FilePaths => (
                    Some("C:\\資料\\one.txt\r\nC:\\two;final.pdf".to_string()),
                    Some(vec![
                        "C:\\資料\\one.txt".to_string(),
                        "C:\\two;final.pdf".to_string(),
                    ]),
                    None,
                    None,
                    false,
                    52,
                ),
            };
        Clip {
            id: "history-id".to_string(),
            kind,
            text_content,
            file_paths,
            image_data,
            thumbnail_base64,
            content_hash: "content-hash".to_string(),
            preview: "preview".to_string(),
            note: Some("note".to_string()),
            truncated,
            source_exe: "source.exe".to_string(),
            source_title: "Source title".to_string(),
            source_icon: Some("source-icon".to_string()),
            captured_at: 1_725_000_000_123,
            pinned: true,
            byte_size,
            deferred: None,        }
    }

    fn assert_shared_columns_match_clip(actual: SharedClipColumns, expected: &Clip) {
        assert_eq!(actual.kind, expected.kind);
        assert_eq!(actual.text_content, expected.text_content);
        assert_eq!(actual.file_paths, expected.file_paths);
        assert_eq!(actual.image_data, expected.image_data);
        assert_eq!(actual.thumbnail_base64, expected.thumbnail_base64);
        assert_eq!(actual.content_hash, expected.content_hash);
        assert_eq!(actual.preview, expected.preview);
        assert_eq!(actual.note, expected.note);
        assert_eq!(actual.truncated, expected.truncated);
        assert_eq!(actual.source_exe, expected.source_exe);
        assert_eq!(actual.source_title, expected.source_title);
        assert_eq!(actual.source_icon, expected.source_icon);
        assert_eq!(actual.captured_at, expected.captured_at);
        assert_eq!(actual.byte_size, expected.byte_size);
    }

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
        assert_eq!(
            file_paths_from_json(json).as_deref(),
            Some(paths.as_slice())
        );
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
            .query_row("SELECT COUNT(*) FROM pragma_table_info('t')", [], |r| {
                r.get(0)
            })
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
        conn.execute_batch(&format!(
            "CREATE TABLE t ({SHARED_COLUMNS});
                 INSERT INTO t VALUES (
                    'Image', 'text', x'010203', 'thumb', 'hash', 'prev', 'note',
                    1, 'exe', 'title', 'icon', 123, 456, '[\"C:\\\\a.txt\",\"b;c.txt\"]'
                 );"
        ))
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
            Some(&["C:\\a.txt".to_string(), "b;c.txt".to_string(),][..])
        );
    }

    #[test]
    fn shared_write_encoding_round_trips_all_clip_kinds() {
        assert_eq!(SHARED_COLUMNS.split(',').count(), SHARED_COLUMN_COUNT);
        assert_eq!(
            SHARED_PARAMETER_MARKERS.split(',').count(),
            SHARED_COLUMN_COUNT
        );
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(&format!("CREATE TABLE t ({SHARED_COLUMNS});"))
            .unwrap();

        for kind in [ClipKind::Text, ClipKind::Image, ClipKind::FilePaths] {
            let expected = clip(kind);
            conn.execute("DELETE FROM t", []).unwrap();
            with_shared_clip_column_params(&expected, &[], |parameters| {
                conn.execute(
                    &format!(
                        "INSERT INTO t ({SHARED_COLUMNS}) VALUES ({SHARED_PARAMETER_MARKERS})"
                    ),
                    rusqlite::params_from_iter(parameters.iter().copied()),
                )
                .map_err(|error| error.to_string())
            })
            .unwrap();

            let actual = conn
                .query_row(&format!("SELECT {SHARED_COLUMNS} FROM t"), [], |row| {
                    decode_shared_columns(row, 0)
                })
                .unwrap();
            assert_shared_columns_match_clip(actual, &expected);
        }
    }

    #[test]
    fn history_and_drawer_store_identical_shared_row_images() {
        for kind in [ClipKind::Text, ClipKind::Image, ClipKind::FilePaths] {
            let expected = clip(kind);
            let mut history = Persistence::in_memory_for_test();
            history.dump(std::slice::from_ref(&expected)).unwrap();

            let mut drawer = FavoritesStore::from_conn(Connection::open_in_memory().unwrap());
            let collection = drawer.create_collection("Parity").unwrap();
            drawer
                .add_favorite(&collection.id, &FavoriteItem::from(expected.clone()))
                .unwrap();

            assert_eq!(
                history.shared_row_image_for_test(&expected.content_hash),
                drawer.shared_row_image_for_test(&expected.content_hash),
            );
        }
    }
}
