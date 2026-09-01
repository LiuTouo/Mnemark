//! Durable favorites collections, independent of the optional history
//! persistence. Favorites always live in `mnemark.db` (the same SQLite file the
//! history persistence uses when enabled) so they survive history eviction,
//! deletion, and the `persist` toggle. The history `clips` table is never
//! touched here: deleting a history entry or purging stale rows can never
//! remove a favorite.

use std::collections::HashSet;

use rusqlite::{params, Connection};

use crate::models::{BatchMutationResult, ClipKind, CollectionSummary, FavoriteItem};

pub struct FavoritesStore {
    conn: Connection,
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| format!("Failed to enable foreign keys: {}", e))?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS collections (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            name_key TEXT NOT NULL UNIQUE,
            sort_order INTEGER NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS favorite_items (
            content_hash TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            text_content TEXT,
            image_data BLOB,
            thumbnail_base64 TEXT,
            preview TEXT NOT NULL,
            note TEXT,
            truncated INTEGER NOT NULL,
            source_exe TEXT NOT NULL,
            source_title TEXT NOT NULL,
            source_icon TEXT,
            captured_at INTEGER NOT NULL,
            byte_size INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memberships (
            collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
            item_id TEXT NOT NULL REFERENCES favorite_items(content_hash) ON DELETE CASCADE,
            added_at INTEGER NOT NULL,
            sort_order INTEGER NOT NULL,
            PRIMARY KEY (collection_id, item_id)
        );
        CREATE INDEX IF NOT EXISTS idx_memberships_item ON memberships(item_id);",
    )
    .map_err(|e| format!("Failed to initialize favorites schema: {}", e))?;
    // Idempotent migration for DBs created before structured file paths:
    // ALTER only when schema introspection says the column is missing —
    // never by matching on the ALTER error string.
    if !column_exists(conn, "favorite_items", "file_paths_json")? {
        conn.execute(
            "ALTER TABLE favorite_items ADD COLUMN file_paths_json TEXT",
            [],
        )
        .map_err(|e| format!("Failed to migrate favorite_items schema: {}", e))?;
    }
    if !column_exists(conn, "favorite_items", "note")? {
        conn.execute("ALTER TABLE favorite_items ADD COLUMN note TEXT", [])
            .map_err(|e| format!("Failed to migrate favorite_items note schema: {}", e))?;
    }
    if !column_exists(conn, "memberships", "sort_order")? {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("Failed to start membership order migration: {}", e))?;
        tx.execute(
            "ALTER TABLE memberships ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| format!("Failed to migrate memberships order schema: {}", e))?;
        let collection_ids = {
            let mut stmt = tx
                .prepare("SELECT id FROM collections")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            let mut ids = Vec::new();
            for id in rows {
                ids.push(id.map_err(|e| e.to_string())?);
            }
            ids
        };
        for collection_id in collection_ids {
            compact_item_sort_orders(&tx, &collection_id)?;
        }
        tx.commit()
            .map_err(|e| format!("Failed to commit membership order migration: {}", e))?;
    }
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_memberships_order
         ON memberships(collection_id, sort_order)",
        [],
    )
    .map_err(|e| format!("Failed to initialize membership order index: {}", e))?;
    Ok(())
}

/// Does `table` have a `column`? Schema introspection via PRAGMA table_info.
fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
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

/// Trim a collection name and validate 1..=64 Unicode scalar values.
pub fn validate_collection_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    let count = trimmed.chars().count();
    if !(1..=64).contains(&count) {
        return Err("Collection name must be 1-64 characters".to_string());
    }
    Ok(trimmed.to_string())
}

fn kind_str(kind: &ClipKind) -> &'static str {
    match kind {
        ClipKind::Text => "Text",
        ClipKind::Image => "Image",
        ClipKind::FilePaths => "FilePaths",
    }
}

fn kind_from_str(s: &str) -> ClipKind {
    match s {
        "Image" => ClipKind::Image,
        "FilePaths" => ClipKind::FilePaths,
        _ => ClipKind::Text,
    }
}

/// Delete every snapshot no longer referenced by any membership. Run inside the
/// same transaction as the membership/collection removal so an orphan is never
/// left behind (and a referenced snapshot is never removed).
fn delete_orphan_items(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "DELETE FROM favorite_items WHERE content_hash NOT IN
             (SELECT DISTINCT item_id FROM memberships)",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Renumber the surviving collections' `sort_order` to a contiguous `0..n`.
/// Run inside the same transaction as a collection deletion so a removed
/// collection never leaves a gap in the ordering.
fn compact_sort_orders(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT id FROM collections ORDER BY sort_order ASC, created_at ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut ids = Vec::new();
    for id in rows {
        ids.push(id.map_err(|e| e.to_string())?);
    }
    for (i, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE collections SET sort_order = ?1 WHERE id = ?2",
            params![i as i64, id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Renumber one collection's membership order to a contiguous `0..n` while
/// preserving its current order. The timestamp/hash fallback also reconstructs
/// the historical newest-first order during the schema migration, when every
/// newly added `sort_order` initially equals zero.
fn compact_item_sort_orders(conn: &Connection, collection_id: &str) -> Result<(), String> {
    let ids = {
        let mut stmt = conn
            .prepare(
                "SELECT item_id FROM memberships
                 WHERE collection_id = ?1
                 ORDER BY sort_order ASC, added_at DESC, item_id ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![collection_id], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut ids = Vec::new();
        for id in rows {
            ids.push(id.map_err(|e| e.to_string())?);
        }
        ids
    };
    for (i, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE memberships SET sort_order = ?1
             WHERE collection_id = ?2 AND item_id = ?3",
            params![i as i64, collection_id, id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Insert-or-refresh one snapshot, deduped by content hash so the same content
/// is shared across every collection that references it.
fn upsert_favorite_item(conn: &Connection, item: &FavoriteItem) -> Result<(), String> {
    // Serialization failure must propagate, never silently drop the canonical
    // file paths to NULL.
    let file_paths_json = item
        .file_paths
        .as_ref()
        .map(|p| {
            serde_json::to_string(p).map_err(|e| format!("Failed to serialize file paths: {}", e))
        })
        .transpose()?;
    conn.execute(
        "INSERT INTO favorite_items (content_hash, kind, text_content, image_data,
                                     thumbnail_base64, preview, truncated, source_exe,
                                     source_title, source_icon, captured_at, byte_size,
                                     file_paths_json, note)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(content_hash) DO UPDATE SET
            kind = excluded.kind,
            text_content = excluded.text_content,
            image_data = excluded.image_data,
            thumbnail_base64 = excluded.thumbnail_base64,
            preview = excluded.preview,
            truncated = excluded.truncated,
            source_exe = excluded.source_exe,
            source_title = excluded.source_title,
            source_icon = excluded.source_icon,
            captured_at = excluded.captured_at,
            byte_size = excluded.byte_size,
            file_paths_json = excluded.file_paths_json,
            note = COALESCE(excluded.note, favorite_items.note)",
        params![
            item.content_hash,
            kind_str(&item.kind),
            item.text_content,
            item.image_data,
            item.thumbnail_base64,
            item.preview,
            item.truncated as i64,
            item.source_exe,
            item.source_title,
            item.source_icon,
            item.captured_at as i64,
            item.byte_size as i64,
            file_paths_json,
            item.note,
        ],
    )
    .map_err(|e| format!("Failed to persist favorite: {}", e))?;
    Ok(())
}

fn row_to_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<FavoriteItem> {
    let content_hash: String = row.get(0)?;
    // Corrupt JSON degrades to None (legacy fallback); never panics.
    let file_paths_json: Option<String> = row.get(12)?;
    let file_paths = file_paths_json.and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok());
    Ok(FavoriteItem {
        id: content_hash.clone(),
        kind: kind_from_str(&row.get::<_, String>(1)?),
        text_content: row.get(2)?,
        file_paths,
        image_data: row.get(3)?,
        thumbnail_base64: row.get(4)?,
        content_hash,
        preview: row.get(5)?,
        note: row.get(13)?,
        truncated: row.get::<_, i64>(6)? != 0,
        source_exe: row.get(7)?,
        source_title: row.get(8)?,
        source_icon: row.get(9)?,
        captured_at: row.get::<_, i64>(10)? as u64,
        byte_size: row.get::<_, i64>(11)? as u64,
        added_at: None,
    })
}

/// Like `row_to_item`, but reads the membership `added_at` from column 14 (the
/// extra column selected by `list_items`).
fn row_to_item_with_added(row: &rusqlite::Row<'_>) -> rusqlite::Result<FavoriteItem> {
    let mut item = row_to_item(row)?;
    item.added_at = Some(row.get::<_, i64>(14)? as u64);
    Ok(item)
}

const ITEM_COLS: &str = "content_hash, kind, text_content, image_data, thumbnail_base64,
        preview, truncated, source_exe, source_title, source_icon, captured_at, byte_size,
        file_paths_json, note";

impl FavoritesStore {
    /// Open (creating if necessary) the favorites tables in `mnemark.db`.
    pub fn open() -> Result<Self, String> {
        let path = crate::persistence::db_path();
        let conn = Connection::open(&path)
            .map_err(|e| format!("Failed to open {}: {}", path.display(), e))?;
        init_schema(&conn)?;
        Ok(Self { conn })
    }

    #[cfg(test)]
    fn from_conn(conn: Connection) -> Self {
        init_schema(&conn).unwrap();
        Self { conn }
    }

    fn summary_for(&self, id: &str) -> Result<CollectionSummary, String> {
        self.conn
            .query_row(
                "SELECT c.id, c.name, c.sort_order, c.created_at,
                        (SELECT COUNT(*) FROM memberships m WHERE m.collection_id = c.id)
                 FROM collections c WHERE c.id = ?1",
                params![id],
                |r| {
                    Ok(CollectionSummary {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        sort_order: r.get(2)?,
                        created_at: r.get::<_, i64>(3)? as u64,
                        item_count: r.get::<_, i64>(4)? as u64,
                    })
                },
            )
            .map_err(|e| e.to_string())
    }

    pub fn create_collection(&self, name: &str) -> Result<CollectionSummary, String> {
        let name = validate_collection_name(name)?;
        let name_key = name.to_lowercase();
        let exists: bool = self
            .conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM collections WHERE name_key = ?1)",
                params![name_key],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if exists {
            return Err("A collection with that name already exists".to_string());
        }
        let created_at = crate::now_ms();
        let id = crate::models::Clip::new_id(&name_key, created_at);
        let sort_order: i64 = self
            .conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM collections",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        self.conn
            .execute(
                "INSERT INTO collections (id, name, name_key, sort_order, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, name, name_key, sort_order, created_at as i64],
            )
            .map_err(|e| e.to_string())?;
        Ok(CollectionSummary {
            id,
            name,
            sort_order,
            created_at,
            item_count: 0,
        })
    }

    pub fn rename_collection(&self, id: &str, name: &str) -> Result<CollectionSummary, String> {
        let name = validate_collection_name(name)?;
        let name_key = name.to_lowercase();
        let conflict: bool = self
            .conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM collections WHERE name_key = ?1 AND id != ?2)",
                params![name_key, id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if conflict {
            return Err("A collection with that name already exists".to_string());
        }
        let updated = self
            .conn
            .execute(
                "UPDATE collections SET name = ?1, name_key = ?2 WHERE id = ?3",
                params![name, name_key, id],
            )
            .map_err(|e| e.to_string())?;
        if updated == 0 {
            return Err("Collection not found".to_string());
        }
        self.summary_for(id)
    }

    pub fn delete_collection(&mut self, id: &str) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        let deleted = tx
            .execute("DELETE FROM collections WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        if deleted == 0 {
            return Err("Collection not found".to_string());
        }
        // Memberships cascade on the FK; drop any now-orphaned snapshots, then
        // compact the remaining sort_order so a deleted collection never leaves
        // a gap.
        delete_orphan_items(&tx)?;
        compact_sort_orders(&tx)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// True when a collection with this id exists.
    pub fn collection_exists(&self, id: &str) -> Result<bool, String> {
        self.conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM collections WHERE id = ?1)",
                params![id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())
    }

    pub fn list_collections(&self) -> Result<Vec<CollectionSummary>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT c.id, c.name, c.sort_order, c.created_at,
                        (SELECT COUNT(*) FROM memberships m WHERE m.collection_id = c.id)
                 FROM collections c ORDER BY c.sort_order ASC, c.created_at ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(CollectionSummary {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    sort_order: r.get(2)?,
                    created_at: r.get::<_, i64>(3)? as u64,
                    item_count: r.get::<_, i64>(4)? as u64,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    /// Reorder collections to exactly the given id sequence. Rejects duplicate,
    /// unknown, or missing ids before compacting `sort_order` to `0..n` in one
    /// transaction.
    pub fn reorder_collections(&mut self, ids: &[String]) -> Result<(), String> {
        let mut current = Vec::new();
        {
            let mut stmt = self
                .conn
                .prepare("SELECT id FROM collections")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            for id in rows {
                current.push(id.map_err(|e| e.to_string())?);
            }
        }
        let current_set: HashSet<&str> = current.iter().map(|s| s.as_str()).collect();
        let mut seen = HashSet::new();
        for id in ids {
            if !seen.insert(id.as_str()) {
                return Err(format!("Duplicate collection id '{}'", id));
            }
            if !current_set.contains(id.as_str()) {
                return Err(format!("Unknown collection id '{}'", id));
            }
        }
        if ids.len() != current.len() {
            return Err("Reorder must include every collection".to_string());
        }
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        for (i, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE collections SET sort_order = ?1 WHERE id = ?2",
                params![i as i64, id],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Reorder every item in one collection to exactly the supplied id
    /// sequence. Validation happens before the transaction writes anything, so
    /// duplicate, unknown, foreign, or missing ids cannot partially reorder a
    /// drawer.
    pub fn reorder_items(&mut self, collection_id: &str, ids: &[String]) -> Result<(), String> {
        if !self.collection_exists(collection_id)? {
            return Err("Collection not found".to_string());
        }
        let current = {
            let mut stmt = self
                .conn
                .prepare("SELECT item_id FROM memberships WHERE collection_id = ?1")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![collection_id], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            let mut current = Vec::new();
            for id in rows {
                current.push(id.map_err(|e| e.to_string())?);
            }
            current
        };
        let current_set: HashSet<&str> = current.iter().map(|id| id.as_str()).collect();
        let mut seen = HashSet::new();
        for id in ids {
            if !seen.insert(id.as_str()) {
                return Err(format!("Duplicate favorite item id '{}'", id));
            }
            if !current_set.contains(id.as_str()) {
                return Err(format!("Unknown favorite item id '{}'", id));
            }
        }
        if ids.len() != current.len() {
            return Err("Reorder must include every favorite item".to_string());
        }

        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        for (i, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE memberships SET sort_order = ?1
                 WHERE collection_id = ?2 AND item_id = ?3",
                params![i as i64, collection_id, id],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Add a favorite to a collection. Idempotent: re-adding the same content
    /// shares the existing snapshot and membership.
    pub fn add_favorite(&mut self, collection_id: &str, item: &FavoriteItem) -> Result<(), String> {
        self.add_favorite_with_at(collection_id, item, crate::now_ms())
    }

    /// Add multiple snapshots to one collection in a single transaction.
    /// Existing memberships are idempotent no-ops and are reported as
    /// `unchanged`; invalid input leaves every table untouched.
    pub fn add_favorites(
        &mut self,
        collection_id: &str,
        items: &[FavoriteItem],
    ) -> Result<BatchMutationResult, String> {
        if items.is_empty() {
            return Err("Batch must include at least one favorite".to_string());
        }
        if !self.collection_exists(collection_id)? {
            return Err("Collection not found".to_string());
        }
        let mut seen = HashSet::new();
        if items
            .iter()
            .any(|item| !seen.insert(item.content_hash.as_str()))
        {
            return Err("Batch contains duplicate favorites".to_string());
        }

        let added_at = crate::now_ms() as i64;
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        let new_items = {
            let mut exists_stmt = tx
                .prepare(
                    "SELECT EXISTS(
                        SELECT 1 FROM memberships
                        WHERE collection_id = ?1 AND item_id = ?2
                     )",
                )
                .map_err(|e| e.to_string())?;
            let mut new_items = Vec::new();
            for item in items {
                upsert_favorite_item(&tx, item)?;
                let exists: bool = exists_stmt
                    .query_row(params![collection_id, item.content_hash], |r| r.get(0))
                    .map_err(|e| e.to_string())?;
                if !exists {
                    new_items.push(item);
                }
            }
            new_items
        };
        if !new_items.is_empty() {
            tx.execute(
                "UPDATE memberships SET sort_order = sort_order + ?1
                 WHERE collection_id = ?2",
                params![new_items.len() as i64, collection_id],
            )
            .map_err(|e| e.to_string())?;
        }
        for (i, item) in new_items.iter().enumerate() {
            tx.execute(
                "INSERT INTO memberships (collection_id, item_id, added_at, sort_order)
                 VALUES (?1, ?2, ?3, ?4)",
                params![collection_id, item.content_hash, added_at, i as i64],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        let requested = items.len() as u64;
        let changed = new_items.len() as u64;
        Ok(BatchMutationResult {
            requested,
            changed,
            unchanged: requested - changed,
        })
    }

    /// Add a favorite with an explicit membership timestamp (production uses the
    /// current clock; tests pin it to make ordering deterministic).
    fn add_favorite_with_at(
        &mut self,
        collection_id: &str,
        item: &FavoriteItem,
        added_at: u64,
    ) -> Result<(), String> {
        if !self.collection_exists(collection_id)? {
            return Err("Collection not found".to_string());
        }
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        upsert_favorite_item(&tx, item)?;
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM memberships
                    WHERE collection_id = ?1 AND item_id = ?2
                 )",
                params![collection_id, item.content_hash],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !exists {
            tx.execute(
                "UPDATE memberships SET sort_order = sort_order + 1
                 WHERE collection_id = ?1",
                params![collection_id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO memberships (collection_id, item_id, added_at, sort_order)
                 VALUES (?1, ?2, ?3, 0)",
                params![collection_id, item.content_hash, added_at as i64],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(test)]
    fn add_favorite_at(
        &mut self,
        collection_id: &str,
        item: &FavoriteItem,
        added_at: u64,
    ) -> Result<(), String> {
        self.add_favorite_with_at(collection_id, item, added_at)
    }

    /// Remove one membership, then delete the snapshot if nothing references it.
    pub fn remove_favorite(&mut self, collection_id: &str, item_id: &str) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM memberships WHERE collection_id = ?1 AND item_id = ?2",
            params![collection_id, item_id],
        )
        .map_err(|e| e.to_string())?;
        compact_item_sort_orders(&tx, collection_id)?;
        delete_orphan_items(&tx)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Remove multiple memberships in one transaction, then collect orphaned
    /// snapshots once after all membership changes have been applied.
    pub fn remove_favorites(
        &mut self,
        collection_id: &str,
        item_ids: &[String],
    ) -> Result<BatchMutationResult, String> {
        if item_ids.is_empty() {
            return Err("Batch must include at least one favorite".to_string());
        }
        if !self.collection_exists(collection_id)? {
            return Err("Collection not found".to_string());
        }
        let mut seen = HashSet::new();
        if item_ids.iter().any(|id| !seen.insert(id.as_str())) {
            return Err("Batch contains duplicate favorites".to_string());
        }

        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        let mut changed = 0_u64;
        for item_id in item_ids {
            changed += tx
                .execute(
                    "DELETE FROM memberships WHERE collection_id = ?1 AND item_id = ?2",
                    params![collection_id, item_id],
                )
                .map_err(|e| e.to_string())? as u64;
        }
        compact_item_sort_orders(&tx, collection_id)?;
        delete_orphan_items(&tx)?;
        tx.commit().map_err(|e| e.to_string())?;
        let requested = item_ids.len() as u64;
        Ok(BatchMutationResult {
            requested,
            changed,
            unchanged: requested - changed,
        })
    }

    /// Items of one collection in its durable custom order. Each item's
    /// `added_at` remains the original membership timestamp.
    pub fn list_items(&self, collection_id: &str) -> Result<Vec<FavoriteItem>, String> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "SELECT {ITEM_COLS}, m.added_at
                 FROM favorite_items f
                 JOIN memberships m ON m.item_id = f.content_hash
                 WHERE m.collection_id = ?1
                 ORDER BY m.sort_order ASC, m.added_at DESC, f.content_hash ASC"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![collection_id], row_to_item_with_added)
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    pub fn get_item(&self, id: &str) -> Result<Option<FavoriteItem>, String> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "SELECT {ITEM_COLS} FROM favorite_items WHERE content_hash = ?1"
            ))
            .map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query_map(params![id], row_to_item)
            .map_err(|e| e.to_string())?;
        match rows.next() {
            Some(Ok(item)) => Ok(Some(item)),
            Some(Err(e)) => Err(e.to_string()),
            None => Ok(None),
        }
    }

    pub fn set_note(&self, id: &str, note: Option<&str>) -> Result<(), String> {
        let updated = self
            .conn
            .execute(
                "UPDATE favorite_items SET note = ?1 WHERE content_hash = ?2",
                params![note, id],
            )
            .map_err(|e| e.to_string())?;
        if updated == 0 {
            return Err("Favorite item not found".to_string());
        }
        Ok(())
    }

    /// Collection ids that reference this item (by content hash).
    pub fn collection_ids_for_item(&self, item_id: &str) -> Result<Vec<String>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT collection_id FROM memberships WHERE item_id = ?1
                 ORDER BY added_at ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![item_id], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for id in rows {
            out.push(id.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Clip, ClipKind};

    fn test_store() -> FavoritesStore {
        FavoritesStore::from_conn(Connection::open_in_memory().unwrap())
    }

    fn clip(id: &str, kind: ClipKind, hash: &str) -> Clip {
        let is_image = kind == ClipKind::Image;
        Clip {
            id: id.to_string(),
            kind,
            text_content: Some(format!("content-{id}")),
            file_paths: None,
            image_data: if is_image {
                Some(vec![1u8, 2, 3, 4])
            } else {
                None
            },
            thumbnail_base64: None,
            content_hash: hash.to_string(),
            preview: format!("preview-{id}"),
            note: None,
            truncated: false,
            source_exe: "test.exe".to_string(),
            source_title: String::new(),
            source_icon: None,
            captured_at: 1,
            pinned: false,
            byte_size: 10,
        }
    }

    #[test]
    fn create_and_round_trip_item() {
        let mut store = test_store();
        let c = store.create_collection("  Work  ").unwrap();
        assert_eq!(c.name, "Work"); // trimmed
        assert_eq!(c.item_count, 0);

        let item = FavoriteItem::from(clip("h1", ClipKind::Text, "hash-a"));
        store.add_favorite(&c.id, &item).unwrap();

        let items = store.list_items(&c.id).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].content_hash, "hash-a");
        assert_eq!(items[0].text_content.as_deref(), Some("content-h1"));
    }

    #[test]
    fn image_bytes_round_trip_through_snapshot() {
        let mut store = test_store();
        let c = store.create_collection("Img").unwrap();
        let item = FavoriteItem::from(clip("i1", ClipKind::Image, "img-hash"));
        store.add_favorite(&c.id, &item).unwrap();
        let loaded = store.get_item("img-hash").unwrap().unwrap();
        assert_eq!(loaded.image_data.as_deref(), Some(&[1u8, 2, 3, 4][..]));
        assert_eq!(loaded.kind, ClipKind::Image);
    }

    #[test]
    fn file_paths_round_trip_exactly_through_snapshot() {
        let mut store = test_store();
        let c = store.create_collection("Files").unwrap();
        let mut src = clip("f1", ClipKind::FilePaths, "files-hash");
        src.file_paths = Some(vec![
            "C:\\tmp\\a;b.txt".to_string(),
            "C:\\tmp\\空白 名稱.pdf".to_string(),
        ]);
        store.add_favorite(&c.id, &FavoriteItem::from(src)).unwrap();

        let loaded = store.get_item("files-hash").unwrap().unwrap();
        assert_eq!(
            loaded.file_paths.as_deref(),
            Some(
                &[
                    "C:\\tmp\\a;b.txt".to_string(),
                    "C:\\tmp\\空白 名稱.pdf".to_string()
                ][..]
            )
        );
        // list_items (the added_at path) reads the same column set.
        let listed = store.list_items(&c.id).unwrap();
        assert_eq!(listed[0].file_paths, loaded.file_paths);
    }

    #[test]
    fn init_schema_twice_consecutively_succeeds() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        // Second init on an already-migrated schema must not error.
        init_schema(&conn).unwrap();
    }

    #[test]
    fn old_schema_favorite_rows_without_file_paths_load() {
        // Pre-migration DB shape: no file_paths_json column.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE collections (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
                sort_order INTEGER NOT NULL, created_at INTEGER NOT NULL);
             CREATE TABLE favorite_items (
                content_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, text_content TEXT,
                image_data BLOB, thumbnail_base64 TEXT, preview TEXT NOT NULL,
                truncated INTEGER NOT NULL, source_exe TEXT NOT NULL, source_title TEXT NOT NULL,
                source_icon TEXT, captured_at INTEGER NOT NULL, byte_size INTEGER NOT NULL);
             CREATE TABLE memberships (
                collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
                item_id TEXT NOT NULL REFERENCES favorite_items(content_hash) ON DELETE CASCADE,
                added_at INTEGER NOT NULL, PRIMARY KEY (collection_id, item_id));
             INSERT INTO collections VALUES ('c1', 'Old', 'old', 0, 1);
             INSERT INTO favorite_items VALUES
                ('old-hash', 'FilePaths', 'C:\\x.txt', NULL, NULL, 'old', 0,
                 'x.exe', '', NULL, 1, 10),
                ('new-hash', 'Text', 'new', NULL, NULL, 'new', 0,
                 'x.exe', '', NULL, 2, 10),
                ('mid-hash', 'Text', 'mid', NULL, NULL, 'mid', 0,
                 'x.exe', '', NULL, 3, 10);
             INSERT INTO memberships VALUES
                ('c1', 'old-hash', 5),
                ('c1', 'new-hash', 30),
                ('c1', 'mid-hash', 20);",
        )
        .unwrap();
        let store = FavoritesStore::from_conn(conn); // from_conn runs init_schema (migrates)
        let item = store.get_item("old-hash").unwrap().unwrap();
        assert_eq!(item.file_paths, None); // legacy NULL → fallback
        assert_eq!(item.text_content.as_deref(), Some("C:\\x.txt"));
        let listed = store.list_items("c1").unwrap();
        let order: Vec<(&str, u64)> = listed
            .iter()
            .map(|item| (item.content_hash.as_str(), item.added_at.unwrap()))
            .collect();
        assert_eq!(
            order,
            vec![("new-hash", 30), ("mid-hash", 20), ("old-hash", 5)]
        );
    }

    #[test]
    fn multi_membership_shares_one_snapshot_and_is_idempotent() {
        let mut store = test_store();
        let a = store.create_collection("A").unwrap();
        let b = store.create_collection("B").unwrap();
        let item = FavoriteItem::from(clip("h1", ClipKind::Text, "shared"));

        store.add_favorite(&a.id, &item).unwrap();
        store.add_favorite(&b.id, &item).unwrap();
        // Idempotent: re-adding the same item to the same collection no-ops.
        store.add_favorite(&a.id, &item).unwrap();

        assert_eq!(store.list_items(&a.id).unwrap().len(), 1);
        assert_eq!(store.list_items(&b.id).unwrap().len(), 1);
        // Both memberships reference the same snapshot.
        let ids = store.collection_ids_for_item("shared").unwrap();
        assert_eq!(ids.len(), 2);
    }

    #[test]
    fn note_follows_history_into_shared_snapshot_and_can_be_edited() {
        let mut store = test_store();
        let a = store.create_collection("A").unwrap();
        let b = store.create_collection("B").unwrap();

        let mut annotated_clip = clip("h1", ClipKind::Text, "shared-note");
        annotated_clip.note = Some("from history".to_string());
        let annotated = FavoriteItem::from(annotated_clip);
        assert_eq!(annotated.note.as_deref(), Some("from history"));
        assert_eq!(
            annotated.clone().into_clip().note.as_deref(),
            Some("from history")
        );
        store.add_favorite(&a.id, &annotated).unwrap();

        // Adding the same content from an unannotated source to another drawer
        // must not erase the note already stored in the shared snapshot.
        let unannotated = FavoriteItem::from(clip("h2", ClipKind::Text, "shared-note"));
        store.add_favorite(&b.id, &unannotated).unwrap();
        assert_eq!(
            store
                .get_item("shared-note")
                .unwrap()
                .unwrap()
                .note
                .as_deref(),
            Some("from history")
        );

        // Re-adding or dragging an annotated source refreshes the shared note,
        // including for memberships that already existed.
        let mut updated_clip = clip("h3", ClipKind::Text, "shared-note");
        updated_clip.note = Some("updated from pinned history".to_string());
        let updated = FavoriteItem::from(updated_clip);
        store.add_favorite(&b.id, &updated).unwrap();
        assert_eq!(
            store.list_items(&a.id).unwrap()[0].note.as_deref(),
            Some("updated from pinned history")
        );
        assert_eq!(
            store.list_items(&b.id).unwrap()[0].note.as_deref(),
            Some("updated from pinned history")
        );

        store.set_note("shared-note", None).unwrap();
        assert_eq!(store.list_items(&a.id).unwrap()[0].note, None);
        assert_eq!(store.list_items(&b.id).unwrap()[0].note, None);
        assert!(store.set_note("missing", Some("note")).is_err());
    }

    #[test]
    fn batch_add_is_atomic_idempotent_and_reports_counts() {
        let mut store = test_store();
        let c = store.create_collection("Batch").unwrap();
        let first = FavoriteItem::from(clip("h1", ClipKind::Text, "first"));
        let second = FavoriteItem::from(clip("h2", ClipKind::Text, "second"));
        let third = FavoriteItem::from(clip("h3", ClipKind::Text, "third"));
        store.add_favorite(&c.id, &first).unwrap();

        let result = store
            .add_favorites(&c.id, &[first.clone(), second.clone(), third])
            .unwrap();
        assert_eq!(
            result,
            BatchMutationResult {
                requested: 3,
                changed: 2,
                unchanged: 1,
            }
        );
        assert_eq!(store.list_items(&c.id).unwrap().len(), 3);
        let order: Vec<String> = store
            .list_items(&c.id)
            .unwrap()
            .into_iter()
            .map(|item| item.content_hash)
            .collect();
        assert_eq!(order, vec!["second", "third", "first"]);

        assert!(store
            .add_favorites(&c.id, &[second.clone(), second])
            .is_err());
        assert_eq!(store.list_items(&c.id).unwrap().len(), 3);
    }

    #[test]
    fn removing_last_membership_deletes_orphan_snapshot() {
        let mut store = test_store();
        let a = store.create_collection("A").unwrap();
        let b = store.create_collection("B").unwrap();
        let item = FavoriteItem::from(clip("h1", ClipKind::Text, "hash"));

        store.add_favorite(&a.id, &item).unwrap();
        store.add_favorite(&b.id, &item).unwrap();

        // Removing from A leaves the snapshot (B still references it).
        store.remove_favorite(&a.id, "hash").unwrap();
        assert!(store.get_item("hash").unwrap().is_some());

        // Removing from B orphans the snapshot.
        store.remove_favorite(&b.id, "hash").unwrap();
        assert!(store.get_item("hash").unwrap().is_none());
    }

    #[test]
    fn batch_remove_collects_only_true_orphans_and_reports_counts() {
        let mut store = test_store();
        let a = store.create_collection("A").unwrap();
        let b = store.create_collection("B").unwrap();
        let shared = FavoriteItem::from(clip("h1", ClipKind::Text, "shared"));
        let exclusive = FavoriteItem::from(clip("h2", ClipKind::Text, "exclusive"));
        store
            .add_favorites(&a.id, &[shared.clone(), exclusive])
            .unwrap();
        store.add_favorite(&b.id, &shared).unwrap();

        let result = store
            .remove_favorites(
                &a.id,
                &[
                    "shared".to_string(),
                    "exclusive".to_string(),
                    "missing".to_string(),
                ],
            )
            .unwrap();
        assert_eq!(
            result,
            BatchMutationResult {
                requested: 3,
                changed: 2,
                unchanged: 1,
            }
        );
        assert!(store.get_item("shared").unwrap().is_some());
        assert!(store.get_item("exclusive").unwrap().is_none());
        assert!(store.list_items(&a.id).unwrap().is_empty());
        assert_eq!(store.list_items(&b.id).unwrap().len(), 1);
    }

    #[test]
    fn deleting_collection_removes_memberships_and_orphans() {
        let mut store = test_store();
        let a = store.create_collection("A").unwrap();
        let item = FavoriteItem::from(clip("h1", ClipKind::Text, "hash"));
        store.add_favorite(&a.id, &item).unwrap();

        store.delete_collection(&a.id).unwrap();
        assert!(store.get_item("hash").unwrap().is_none());
        assert!(store.list_collections().unwrap().is_empty());
    }

    #[test]
    fn reorder_compacts_and_validates() {
        let mut store = test_store();
        let a = store.create_collection("A").unwrap();
        let b = store.create_collection("B").unwrap();
        let c = store.create_collection("C").unwrap();

        // Unknown id rejected.
        assert!(store
            .reorder_collections(&[a.id.clone(), "nope".into(), b.id.clone(), c.id.clone()])
            .is_err());
        // Duplicate rejected.
        assert!(store
            .reorder_collections(&[a.id.clone(), a.id.clone(), b.id.clone(), c.id.clone()])
            .is_err());
        // Missing rejected.
        assert!(store
            .reorder_collections(&[a.id.clone(), b.id.clone()])
            .is_err());

        // Valid reorder compacts sort_order to 0..n.
        store
            .reorder_collections(&[c.id.clone(), a.id.clone(), b.id.clone()])
            .unwrap();
        let cols = store.list_collections().unwrap();
        let order: Vec<(String, i64)> = cols
            .iter()
            .map(|x| (x.name.clone(), x.sort_order))
            .collect();
        assert_eq!(
            order,
            vec![
                ("C".to_string(), 0),
                ("A".to_string(), 1),
                ("B".to_string(), 2),
            ]
        );
    }

    #[test]
    fn item_reorder_is_atomic_validated_and_collection_local() {
        let mut store = test_store();
        let a = store.create_collection("A").unwrap();
        let b = store.create_collection("B").unwrap();
        for hash in ["one", "two", "three"] {
            store
                .add_favorite(&a.id, &FavoriteItem::from(clip(hash, ClipKind::Text, hash)))
                .unwrap();
        }
        store
            .add_favorite(
                &b.id,
                &FavoriteItem::from(clip("foreign", ClipKind::Text, "foreign")),
            )
            .unwrap();

        assert!(store
            .reorder_items(&a.id, &["one".into(), "one".into(), "two".into()])
            .is_err());
        assert!(store
            .reorder_items(&a.id, &["one".into(), "two".into()])
            .is_err());
        assert!(store
            .reorder_items(&a.id, &["one".into(), "two".into(), "foreign".into()])
            .is_err());
        assert!(store
            .reorder_items(&a.id, &["one".into(), "two".into(), "missing".into()])
            .is_err());

        store
            .reorder_items(&a.id, &["one".into(), "three".into(), "two".into()])
            .unwrap();
        let order: Vec<String> = store
            .list_items(&a.id)
            .unwrap()
            .into_iter()
            .map(|item| item.content_hash)
            .collect();
        assert_eq!(order, vec!["one", "three", "two"]);
        assert_eq!(store.list_items(&b.id).unwrap()[0].content_hash, "foreign");
    }

    #[test]
    fn names_are_trimmed_bounded_and_case_insensitively_unique() {
        let store = test_store();
        assert!(store.create_collection("   ").is_err()); // empty after trim
        assert!(store.create_collection(&"x".repeat(65)).is_err()); // > 64 scalars
        assert!(store.create_collection("x".repeat(64).as_str()).is_ok()); // == 64 ok

        let _ = store.create_collection("Work").unwrap();
        assert!(store.create_collection("work").is_err()); // case-insensitive dup
        assert!(store.create_collection("WORK").is_err());
        assert!(store.create_collection(" Work ").is_err());
    }

    #[test]
    fn favorite_survives_history_deletion() {
        // Favorites are independent of the HistoryStore: deleting the source
        // clip from history must not affect the snapshot.
        let mut store = test_store();
        let c = store.create_collection("Keep").unwrap();
        let item = FavoriteItem::from(clip("h1", ClipKind::Text, "hash"));
        store.add_favorite(&c.id, &item).unwrap();

        let mut history = crate::history::HistoryStore::new();
        let cfg = crate::models::AppConfig::default();
        history.insert(clip("h1", ClipKind::Text, "hash"), &cfg);
        assert!(history.delete("h1").is_some()); // history entry gone

        assert_eq!(store.list_items(&c.id).unwrap().len(), 1);
        assert!(store.get_item("hash").unwrap().is_some());
    }

    #[test]
    fn add_to_missing_collection_is_rejected() {
        let mut store = test_store();
        let item = FavoriteItem::from(clip("h1", ClipKind::Text, "hash"));
        assert!(store.add_favorite("missing", &item).is_err());
    }

    #[test]
    fn newly_added_items_start_at_top_and_keep_membership_timestamp() {
        let mut store = test_store();
        let c = store.create_collection("A").unwrap();
        store
            .add_favorite_at(
                &c.id,
                &FavoriteItem::from(clip("h1", ClipKind::Text, "hash-a")),
                100,
            )
            .unwrap();
        store
            .add_favorite_at(
                &c.id,
                &FavoriteItem::from(clip("h2", ClipKind::Text, "hash-b")),
                300,
            )
            .unwrap();
        store
            .add_favorite_at(
                &c.id,
                &FavoriteItem::from(clip("h3", ClipKind::Text, "hash-c")),
                200,
            )
            .unwrap();

        let items = store.list_items(&c.id).unwrap();
        let order: Vec<(&str, u64)> = items
            .iter()
            .map(|i| (i.content_hash.as_str(), i.added_at.unwrap()))
            .collect();
        assert_eq!(
            order,
            vec![("hash-c", 200), ("hash-b", 300), ("hash-a", 100)]
        );
        store
            .add_favorite_at(
                &c.id,
                &FavoriteItem::from(clip("h2-new", ClipKind::Text, "hash-b")),
                400,
            )
            .unwrap();
        let unchanged: Vec<(String, u64)> = store
            .list_items(&c.id)
            .unwrap()
            .into_iter()
            .map(|item| (item.content_hash, item.added_at.unwrap()))
            .collect();
        assert_eq!(
            unchanged,
            vec![
                ("hash-c".to_string(), 200),
                ("hash-b".to_string(), 300),
                ("hash-a".to_string(), 100),
            ]
        );
        // Fetched outside a collection, `added_at` is None.
        assert_eq!(store.get_item("hash-b").unwrap().unwrap().added_at, None);
    }

    #[test]
    fn removing_item_compacts_membership_sort_orders() {
        let mut store = test_store();
        let c = store.create_collection("A").unwrap();
        for hash in ["one", "two", "three"] {
            store
                .add_favorite(&c.id, &FavoriteItem::from(clip(hash, ClipKind::Text, hash)))
                .unwrap();
        }
        store.remove_favorite(&c.id, "two").unwrap();
        let sort_orders: Vec<i64> = {
            let mut stmt = store
                .conn
                .prepare(
                    "SELECT sort_order FROM memberships
                     WHERE collection_id = ?1 ORDER BY sort_order",
                )
                .unwrap();
            stmt.query_map(params![c.id], |row| row.get(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(sort_orders, vec![0, 1]);
    }

    #[test]
    fn deleting_collection_compacts_sort_orders() {
        let mut store = test_store();
        let a = store.create_collection("A").unwrap();
        let b = store.create_collection("B").unwrap();
        let c = store.create_collection("C").unwrap();
        assert_eq!((a.sort_order, b.sort_order, c.sort_order), (0, 1, 2));

        store.delete_collection(&b.id).unwrap();

        let cols = store.list_collections().unwrap();
        let order: Vec<(String, i64)> = cols
            .iter()
            .map(|x| (x.name.clone(), x.sort_order))
            .collect();
        assert_eq!(order, vec![("A".to_string(), 0), ("C".to_string(), 1)]);
    }
}
