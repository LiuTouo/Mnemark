use serde::Serialize;

use crate::favorites::FavoritesStore;
use crate::models::{BatchMutationResult, CollectionSummary, FavoriteItem};

#[derive(Default)]
struct DrawerUiState {
    open: bool,
    selected_collection: Option<String>,
}

pub(crate) struct DrawerState {
    favorites: Option<FavoritesStore>,
    ui: DrawerUiState,
    generation: u64,
}

#[derive(Clone, Serialize)]
pub(crate) struct DrawerViewState {
    pub(crate) generation: u64,
    pub(crate) open: bool,
    pub(crate) selected_collection: Option<String>,
    pub(crate) collections: Vec<CollectionSummary>,
    pub(crate) active_snapshots: Vec<FavoriteItem>,
}

pub(crate) struct DrawerMutation<T> {
    pub(crate) value: T,
    pub(crate) generation: u64,
}

#[derive(Clone, Serialize)]
pub(crate) struct DrawerViewInvalidation {
    pub(crate) generation: u64,
}

impl DrawerState {
    pub(crate) fn new(favorites: Option<FavoritesStore>) -> Self {
        Self {
            favorites,
            ui: DrawerUiState::default(),
            generation: 0,
        }
    }

    pub(crate) fn has_favorites_store(&self) -> bool {
        self.favorites.is_some()
    }

    pub(crate) fn view(&self) -> Result<DrawerViewState, String> {
        let favorites = self
            .favorites
            .as_ref()
            .ok_or_else(|| "Favorites unavailable".to_string())?;
        let collections = favorites.list_collections()?;
        let active_snapshots = match &self.ui.selected_collection {
            Some(collection_id) => favorites.list_items(collection_id)?,
            None => Vec::new(),
        };
        Ok(DrawerViewState {
            generation: self.generation,
            open: self.ui.open,
            selected_collection: self.ui.selected_collection.clone(),
            collections,
            active_snapshots,
        })
    }

    fn favorites(&self) -> Result<&FavoritesStore, String> {
        self.favorites
            .as_ref()
            .ok_or_else(|| "Favorites unavailable".to_string())
    }

    pub(crate) fn get_item(&self, id: &str) -> Result<Option<FavoriteItem>, String> {
        self.favorites()?.get_item(id)
    }

    pub(crate) fn collection_ids_for_item(&self, id: &str) -> Result<Vec<String>, String> {
        self.favorites()?.collection_ids_for_item(id)
    }

    fn mutate<T>(
        &mut self,
        operation: impl FnOnce(&mut FavoritesStore, &mut DrawerUiState) -> Result<T, String>,
    ) -> Result<DrawerMutation<T>, String> {
        let next_generation = self
            .generation
            .checked_add(1)
            .ok_or_else(|| "Drawer generation exhausted".to_string())?;
        let favorites = self
            .favorites
            .as_mut()
            .ok_or_else(|| "Favorites unavailable".to_string())?;
        let value = operation(favorites, &mut self.ui)?;
        self.generation = next_generation;
        Ok(DrawerMutation {
            value,
            generation: next_generation,
        })
    }

    pub(crate) fn set_selected(
        &mut self,
        collection_id: Option<String>,
    ) -> Result<DrawerMutation<()>, String> {
        self.mutate(|favorites, ui| {
            if let Some(id) = &collection_id {
                if !favorites.collection_exists(id)? {
                    return Err("Collection not found".to_string());
                }
            }
            ui.selected_collection = collection_id;
            Ok(())
        })
    }

    pub(crate) fn set_open(&mut self, open: bool) -> Result<DrawerMutation<()>, String> {
        self.mutate(|_, ui| {
            Self::apply_open(ui, open);
            Ok(())
        })
    }

    pub(crate) fn delete_collection(&mut self, id: &str) -> Result<DrawerMutation<()>, String> {
        self.mutate(|favorites, ui| {
            favorites.delete_collection(id)?;
            if ui.selected_collection.as_deref() == Some(id) {
                ui.selected_collection = None;
            }
            Ok(())
        })
    }

    pub(crate) fn create_collection(
        &mut self,
        name: &str,
    ) -> Result<DrawerMutation<CollectionSummary>, String> {
        self.mutate(|favorites, _| favorites.create_collection(name))
    }

    pub(crate) fn add_snapshot(
        &mut self,
        collection_id: &str,
        item: &FavoriteItem,
    ) -> Result<DrawerMutation<()>, String> {
        self.mutate(|favorites, _| favorites.add_favorite(collection_id, item))
    }

    pub(crate) fn rename_collection(
        &mut self,
        id: &str,
        name: &str,
    ) -> Result<DrawerMutation<CollectionSummary>, String> {
        self.mutate(|favorites, _| favorites.rename_collection(id, name))
    }

    pub(crate) fn reorder_collections(
        &mut self,
        ids: &[String],
    ) -> Result<DrawerMutation<()>, String> {
        self.mutate(|favorites, _| favorites.reorder_collections(ids))
    }

    pub(crate) fn reorder_items(
        &mut self,
        collection_id: &str,
        ids: &[String],
    ) -> Result<DrawerMutation<()>, String> {
        self.mutate(|favorites, _| favorites.reorder_items(collection_id, ids))
    }

    pub(crate) fn add_snapshots(
        &mut self,
        collection_id: &str,
        items: &[FavoriteItem],
    ) -> Result<DrawerMutation<BatchMutationResult>, String> {
        self.mutate(|favorites, _| favorites.add_favorites(collection_id, items))
    }

    pub(crate) fn remove_snapshot(
        &mut self,
        collection_id: &str,
        item_id: &str,
    ) -> Result<DrawerMutation<()>, String> {
        self.mutate(|favorites, _| favorites.remove_favorite(collection_id, item_id))
    }

    pub(crate) fn remove_snapshots(
        &mut self,
        collection_id: &str,
        item_ids: &[String],
    ) -> Result<DrawerMutation<BatchMutationResult>, String> {
        self.mutate(|favorites, _| favorites.remove_favorites(collection_id, item_ids))
    }

    pub(crate) fn set_note(
        &mut self,
        id: &str,
        note: Option<&str>,
    ) -> Result<DrawerMutation<()>, String> {
        self.mutate(|favorites, _| favorites.set_note(id, note))
    }

    pub(crate) fn toggle_open(&mut self) -> Result<DrawerMutation<()>, String> {
        self.mutate(|_, ui| {
            let open = !ui.open;
            Self::apply_open(ui, open);
            Ok(())
        })
    }

    fn apply_open(ui: &mut DrawerUiState, open: bool) {
        ui.open = open;
        if !open {
            ui.selected_collection = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::DrawerState;
    use crate::favorites::FavoritesStore;
    use crate::models::{ClipKind, FavoriteItem};

    fn available_state() -> DrawerState {
        DrawerState::new(Some(FavoritesStore::from_conn(
            Connection::open_in_memory().unwrap(),
        )))
    }

    fn snapshot(id: &str) -> FavoriteItem {
        FavoriteItem {
            id: id.to_string(),
            kind: ClipKind::Text,
            text_content: Some(id.to_string()),
            file_paths: None,
            image_data: None,
            thumbnail_base64: None,
            content_hash: id.to_string(),
            preview: id.to_string(),
            note: None,
            truncated: false,
            source_exe: "test.exe".to_string(),
            source_title: "Test".to_string(),
            source_icon: None,
            captured_at: 1,
            byte_size: id.len() as u64,
            added_at: None,
        }
    }

    #[test]
    fn canonical_view_starts_from_one_authoritative_empty_state() {
        let state = available_state();

        let view = state.view().unwrap();

        assert_eq!(view.generation, 0);
        assert!(!view.open);
        assert_eq!(view.selected_collection, None);
        assert!(view.collections.is_empty());
        assert!(view.active_snapshots.is_empty());
    }

    #[test]
    fn selecting_a_collection_exposes_its_snapshots_without_opening_drawer() {
        let mut store = FavoritesStore::from_conn(Connection::open_in_memory().unwrap());
        let collection = store.create_collection("Work").unwrap();
        store
            .add_favorite(&collection.id, &snapshot("selected-item"))
            .unwrap();
        let mut state = DrawerState::new(Some(store));

        let mutation = state.set_selected(Some(collection.id.clone())).unwrap();
        let view = state.view().unwrap();

        assert_eq!(mutation.generation, 1);
        assert!(!view.open);
        assert_eq!(view.selected_collection, Some(collection.id));
        assert_eq!(view.active_snapshots.len(), 1);
        assert_eq!(view.active_snapshots[0].id, "selected-item");
    }

    #[test]
    fn closing_drawer_clears_selection_and_active_snapshots() {
        let mut store = FavoritesStore::from_conn(Connection::open_in_memory().unwrap());
        let collection = store.create_collection("Work").unwrap();
        store
            .add_favorite(&collection.id, &snapshot("selected-item"))
            .unwrap();
        let mut state = DrawerState::new(Some(store));
        state.set_selected(Some(collection.id)).unwrap();
        state.set_open(true).unwrap();

        let mutation = state.set_open(false).unwrap();
        let view = state.view().unwrap();

        assert_eq!(mutation.generation, 3);
        assert!(!view.open);
        assert_eq!(view.selected_collection, None);
        assert!(view.active_snapshots.is_empty());
    }

    #[test]
    fn deleting_selected_collection_returns_to_history_without_closing_drawer() {
        let store = FavoritesStore::from_conn(Connection::open_in_memory().unwrap());
        let collection = store.create_collection("Work").unwrap();
        let mut state = DrawerState::new(Some(store));
        state.set_open(true).unwrap();
        state.set_selected(Some(collection.id.clone())).unwrap();

        let mutation = state.delete_collection(&collection.id).unwrap();
        let view = state.view().unwrap();

        assert_eq!(mutation.generation, 3);
        assert!(view.open);
        assert_eq!(view.selected_collection, None);
        assert!(view.collections.is_empty());
        assert!(view.active_snapshots.is_empty());
    }

    #[test]
    fn successful_idempotent_no_op_advances_generation_but_failure_does_not() {
        let mut state = available_state();
        let collection = state.create_collection("Work").unwrap();
        assert_eq!(collection.generation, 1);

        let item = snapshot("same-item");
        assert_eq!(
            state
                .add_snapshot(&collection.value.id, &item)
                .unwrap()
                .generation,
            2
        );
        assert_eq!(
            state
                .add_snapshot(&collection.value.id, &item)
                .unwrap()
                .generation,
            3
        );

        assert!(state.add_snapshot("missing", &item).is_err());
        assert_eq!(state.set_open(true).unwrap().generation, 4);

        let view = state.view().unwrap();
        assert_eq!(view.generation, 4);
        assert_eq!(view.collections[0].item_count, 1);
    }

    #[test]
    fn every_drawer_mutation_uses_the_same_generation_sequence() {
        let mut state = available_state();
        let first_collection = state.create_collection("First").unwrap();
        let second_collection = state.create_collection("Second").unwrap();
        assert_eq!(second_collection.generation, 2);
        assert_eq!(
            state
                .rename_collection(&first_collection.value.id, "Renamed")
                .unwrap()
                .generation,
            3
        );

        let first_item = snapshot("first-item");
        let second_item = snapshot("second-item");
        assert_eq!(
            state
                .add_snapshots(
                    &first_collection.value.id,
                    &[first_item.clone(), second_item.clone()],
                )
                .unwrap()
                .generation,
            4
        );
        assert_eq!(
            state
                .reorder_items(
                    &first_collection.value.id,
                    &[second_item.id.clone(), first_item.id.clone()],
                )
                .unwrap()
                .generation,
            5
        );
        assert_eq!(
            state
                .set_note(&first_item.id, Some("note"))
                .unwrap()
                .generation,
            6
        );
        assert_eq!(
            state
                .remove_snapshot(&first_collection.value.id, &first_item.id)
                .unwrap()
                .generation,
            7
        );
        assert_eq!(
            state
                .remove_snapshots(
                    &first_collection.value.id,
                    std::slice::from_ref(&second_item.id),
                )
                .unwrap()
                .generation,
            8
        );
        assert_eq!(
            state
                .reorder_collections(&[
                    second_collection.value.id.clone(),
                    first_collection.value.id.clone(),
                ])
                .unwrap()
                .generation,
            9
        );
        assert_eq!(state.toggle_open().unwrap().generation, 10);

        let view = state.view().unwrap();
        assert_eq!(view.generation, 10);
        assert!(view.open);
        assert_eq!(view.collections[0].id, second_collection.value.id);
        assert_eq!(view.collections[1].name, "Renamed");
        assert_eq!(view.collections[1].item_count, 0);
    }

    #[test]
    fn unavailable_store_rejects_canonical_read_and_every_mutation() {
        fn assert_unavailable<T>(result: Result<T, String>) {
            assert_eq!(result.err().as_deref(), Some("Favorites unavailable"));
        }

        let mut state = DrawerState::new(None);
        let item = snapshot("item");
        let ids = vec!["id".to_string()];

        assert_unavailable(state.view());
        assert_unavailable(state.create_collection("Work"));
        assert_unavailable(state.rename_collection("id", "Renamed"));
        assert_unavailable(state.delete_collection("id"));
        assert_unavailable(state.reorder_collections(&ids));
        assert_unavailable(state.reorder_items("id", &ids));
        assert_unavailable(state.add_snapshot("id", &item));
        assert_unavailable(state.add_snapshots("id", std::slice::from_ref(&item)));
        assert_unavailable(state.remove_snapshot("id", "item"));
        assert_unavailable(state.remove_snapshots("id", &ids));
        assert_unavailable(state.set_note("item", Some("note")));
        assert_unavailable(state.set_open(true));
        assert_unavailable(state.toggle_open());
        assert_unavailable(state.set_selected(Some("id".to_string())));
    }
}
