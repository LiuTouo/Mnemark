use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;

use crate::drawer::DrawerState;
use crate::history_state::HistoryState;
use crate::lock;
use crate::models::{Clip, ClipKind, ClipLocator, ClipScope, FavoriteItem, PreviewPayload};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum CopyOutcome {
    Copied,
    MissingFilesTextFallback,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LocatedClipError {
    NotFound,
    DrawerUnavailable,
    HistoryPersistence(String),
    MissingContent,
    ClipboardWrite(String),
    PreviewDisabled,
    PreviewPublication(String),
    DrawerMutation(String),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum LocatedClipErrorCode {
    NotFound,
    DrawerUnavailable,
    HistoryPersistence,
    MissingContent,
    ClipboardWrite,
    PreviewDisabled,
    PreviewPublication,
    DrawerMutation,
}

#[derive(Debug, Serialize)]
pub(crate) struct LocatedClipWireError {
    code: LocatedClipErrorCode,
    detail: Option<String>,
}

impl From<LocatedClipError> for LocatedClipWireError {
    fn from(error: LocatedClipError) -> Self {
        let (code, detail) = match error {
            LocatedClipError::NotFound => (LocatedClipErrorCode::NotFound, None),
            LocatedClipError::DrawerUnavailable => (LocatedClipErrorCode::DrawerUnavailable, None),
            LocatedClipError::HistoryPersistence(detail) => {
                (LocatedClipErrorCode::HistoryPersistence, Some(detail))
            }
            LocatedClipError::MissingContent => (LocatedClipErrorCode::MissingContent, None),
            LocatedClipError::ClipboardWrite(detail) => {
                (LocatedClipErrorCode::ClipboardWrite, Some(detail))
            }
            LocatedClipError::PreviewDisabled => (LocatedClipErrorCode::PreviewDisabled, None),
            LocatedClipError::PreviewPublication(detail) => {
                (LocatedClipErrorCode::PreviewPublication, Some(detail))
            }
            LocatedClipError::DrawerMutation(detail) => {
                (LocatedClipErrorCode::DrawerMutation, Some(detail))
            }
        };
        Self { code, detail }
    }
}

pub(crate) struct LocatedClip {
    id: String,
    kind: ClipKind,
    text_content: Option<String>,
    file_paths: Option<Vec<String>>,
    image_data: Option<Vec<u8>>,
    note: Option<String>,
    truncated: bool,
    source_exe: String,
    source_title: String,
    captured_at: u64,
    byte_size: u64,
}

pub(crate) struct NoteCommit {
    pub(crate) note: Option<String>,
    pub(crate) drawer_generation: Option<u64>,
}

impl From<Clip> for LocatedClip {
    fn from(clip: Clip) -> Self {
        Self {
            id: clip.id,
            kind: clip.kind,
            text_content: clip.text_content,
            file_paths: clip.file_paths,
            image_data: clip.image_data,
            note: clip.note,
            truncated: clip.truncated,
            source_exe: clip.source_exe,
            source_title: clip.source_title,
            captured_at: clip.captured_at,
            byte_size: clip.byte_size,
        }
    }
}

impl From<FavoriteItem> for LocatedClip {
    fn from(item: FavoriteItem) -> Self {
        Self {
            id: item.id,
            kind: item.kind,
            text_content: item.text_content,
            file_paths: item.file_paths,
            image_data: item.image_data,
            note: item.note,
            truncated: item.truncated,
            source_exe: item.source_exe,
            source_title: item.source_title,
            captured_at: item.captured_at,
            byte_size: item.byte_size,
        }
    }
}

pub(crate) trait LocatedClipSource {
    fn resolve(&self, locator: &ClipLocator) -> Result<LocatedClip, LocatedClipError>;
    fn set_note(
        &self,
        locator: &ClipLocator,
        note: Option<String>,
    ) -> Result<NoteCommit, LocatedClipError>;
}

/// History-scope source: everything routes through the History aggregate, so
/// this adapter never coordinates memory and persistence locks itself.
struct HistoryAdapter<'a> {
    history: &'a Mutex<HistoryState>,
}

impl LocatedClipSource for HistoryAdapter<'_> {
    fn resolve(&self, locator: &ClipLocator) -> Result<LocatedClip, LocatedClipError> {
        lock(self.history)
            .clip(&locator.id)
            .map(LocatedClip::from)
            .ok_or(LocatedClipError::NotFound)
    }

    fn set_note(
        &self,
        locator: &ClipLocator,
        note: Option<String>,
    ) -> Result<NoteCommit, LocatedClipError> {
        lock(self.history)
            .set_note(&locator.id, note.clone())
            .map_err(|e| match e {
                crate::history_state::HistoryError::Persistence(detail) => {
                    LocatedClipError::HistoryPersistence(detail)
                }
                _ => LocatedClipError::NotFound,
            })?;
        Ok(NoteCommit {
            note,
            drawer_generation: None,
        })
    }
}

struct DrawerSnapshotAdapter<'a> {
    drawer: &'a Mutex<DrawerState>,
}

impl LocatedClipSource for DrawerSnapshotAdapter<'_> {
    fn resolve(&self, locator: &ClipLocator) -> Result<LocatedClip, LocatedClipError> {
        let drawer = lock(self.drawer);
        if !drawer.has_favorites_store() {
            return Err(LocatedClipError::DrawerUnavailable);
        }
        drawer
            .get_item(&locator.id)
            .map_err(LocatedClipError::DrawerMutation)?
            .map(LocatedClip::from)
            .ok_or(LocatedClipError::NotFound)
    }

    fn set_note(
        &self,
        locator: &ClipLocator,
        note: Option<String>,
    ) -> Result<NoteCommit, LocatedClipError> {
        let mut drawer = lock(self.drawer);
        if !drawer.has_favorites_store() {
            return Err(LocatedClipError::DrawerUnavailable);
        }
        if drawer
            .get_item(&locator.id)
            .map_err(LocatedClipError::DrawerMutation)?
            .is_none()
        {
            return Err(LocatedClipError::NotFound);
        }
        let mutation = drawer
            .set_note(&locator.id, note.as_deref())
            .map_err(LocatedClipError::DrawerMutation)?;
        Ok(NoteCommit {
            note,
            drawer_generation: Some(mutation.generation),
        })
    }
}

pub(crate) struct StateLocatedClipSource<'a> {
    history: HistoryAdapter<'a>,
    drawer: DrawerSnapshotAdapter<'a>,
}

impl<'a> StateLocatedClipSource<'a> {
    pub(crate) fn new(history: &'a Mutex<HistoryState>, drawer: &'a Mutex<DrawerState>) -> Self {
        Self {
            history: HistoryAdapter { history },
            drawer: DrawerSnapshotAdapter { drawer },
        }
    }
}

impl LocatedClipSource for StateLocatedClipSource<'_> {
    fn resolve(&self, locator: &ClipLocator) -> Result<LocatedClip, LocatedClipError> {
        match locator.scope {
            ClipScope::History => self.history.resolve(locator),
            ClipScope::Drawer => self.drawer.resolve(locator),
        }
    }

    fn set_note(
        &self,
        locator: &ClipLocator,
        note: Option<String>,
    ) -> Result<NoteCommit, LocatedClipError> {
        match locator.scope {
            ClipScope::History => self.history.set_note(locator, note),
            ClipScope::Drawer => self.drawer.set_note(locator, note),
        }
    }
}

pub(crate) trait LocatedClipPlatform {
    fn write_text(&self, text: &str) -> Result<(), String>;
    fn write_image(&self, data: &[u8]) -> Result<(), String>;
    fn path_exists(&self, path: &str) -> bool;
    fn write_files(&self, paths: &[String]) -> Result<(), String>;
    fn image_preview(&self, data: &[u8]) -> Result<String, String>;
}

pub(crate) struct SystemLocatedClipPlatform;

impl LocatedClipPlatform for SystemLocatedClipPlatform {
    fn write_text(&self, text: &str) -> Result<(), String> {
        crate::clipboard::write_text_to_clipboard(text)
    }

    fn write_image(&self, data: &[u8]) -> Result<(), String> {
        crate::clipboard::write_image_to_clipboard(data)
    }

    fn path_exists(&self, path: &str) -> bool {
        std::path::Path::new(path).exists()
    }

    fn write_files(&self, paths: &[String]) -> Result<(), String> {
        crate::clipboard::write_files_to_clipboard(paths)
    }

    fn image_preview(&self, data: &[u8]) -> Result<String, String> {
        crate::clipboard::generate_preview_data_url(data)
    }
}

pub(crate) struct LocatedClipModule<S, P> {
    source: S,
    platform: P,
    paste_files_as_files: bool,
    preview_enabled: bool,
}

impl<S, P> LocatedClipModule<S, P>
where
    S: LocatedClipSource,
    P: LocatedClipPlatform,
{
    pub(crate) fn new(
        source: S,
        platform: P,
        paste_files_as_files: bool,
        preview_enabled: bool,
    ) -> Self {
        Self {
            source,
            platform,
            paste_files_as_files,
            preview_enabled,
        }
    }

    pub(crate) async fn paste<Present, F>(
        &self,
        locator: &ClipLocator,
        present: Present,
    ) -> Result<CopyOutcome, LocatedClipError>
    where
        Present: FnOnce() -> F,
        F: Future<Output = ()>,
    {
        let outcome = self.write(locator)?;
        present().await;
        Ok(outcome)
    }

    pub(crate) fn copy(&self, locator: &ClipLocator) -> Result<CopyOutcome, LocatedClipError> {
        self.write(locator)
    }

    pub(crate) async fn preview<Publish, F>(
        &self,
        locator: &ClipLocator,
        generation: &AtomicU64,
        publish: Publish,
    ) -> Result<(), LocatedClipError>
    where
        Publish: FnOnce(u64, PreviewPayload) -> F,
        F: Future<Output = Result<(), String>>,
    {
        if !self.preview_enabled {
            return Err(LocatedClipError::PreviewDisabled);
        }
        let mine = generation.fetch_add(1, Ordering::SeqCst) + 1;
        let clip = self.source.resolve(locator)?;
        let image_preview_base64 = if clip.kind == ClipKind::Image {
            Some(
                self.platform
                    .image_preview(
                        clip.image_data
                            .as_deref()
                            .ok_or(LocatedClipError::MissingContent)?,
                    )
                    .map_err(LocatedClipError::PreviewPublication)?,
            )
        } else {
            None
        };
        let payload = PreviewPayload {
            id: clip.id,
            kind: clip.kind,
            text_content: clip.text_content,
            image_preview_base64,
            note: clip.note,
            truncated: clip.truncated,
            byte_size: clip.byte_size,
            captured_at: clip.captured_at,
            source_exe: clip.source_exe,
            source_title: clip.source_title,
        };
        publish(mine, payload)
            .await
            .map_err(LocatedClipError::PreviewPublication)
    }

    pub(crate) fn set_note(
        &self,
        locator: &ClipLocator,
        note: String,
    ) -> Result<NoteCommit, LocatedClipError> {
        let note = if note.trim().is_empty() {
            None
        } else {
            Some(note)
        };
        self.source.set_note(locator, note)
    }

    fn write(&self, locator: &ClipLocator) -> Result<CopyOutcome, LocatedClipError> {
        let clip = self.source.resolve(locator)?;
        match clip.kind {
            ClipKind::Text => self
                .platform
                .write_text(clip.text_content.as_deref().unwrap_or(""))
                .map(|_| CopyOutcome::Copied)
                .map_err(LocatedClipError::ClipboardWrite),
            ClipKind::Image => self
                .platform
                .write_image(
                    clip.image_data
                        .as_deref()
                        .ok_or(LocatedClipError::MissingContent)?,
                )
                .map(|_| CopyOutcome::Copied)
                .map_err(LocatedClipError::ClipboardWrite),
            ClipKind::FilePaths => {
                let text = clip.text_content.as_deref().unwrap_or("");
                if self.paste_files_as_files {
                    let paths = clip
                        .file_paths
                        .unwrap_or_else(|| crate::clipboard::split_legacy_file_text(text));
                    let existing = paths
                        .into_iter()
                        .filter(|path| self.platform.path_exists(path))
                        .collect::<Vec<_>>();
                    if existing.is_empty() {
                        self.platform
                            .write_text(text)
                            .map(|_| CopyOutcome::MissingFilesTextFallback)
                            .map_err(LocatedClipError::ClipboardWrite)
                    } else {
                        self.platform
                            .write_files(&existing)
                            .map(|_| CopyOutcome::Copied)
                            .map_err(LocatedClipError::ClipboardWrite)
                    }
                } else {
                    self.platform
                        .write_text(text)
                        .map(|_| CopyOutcome::Copied)
                        .map_err(LocatedClipError::ClipboardWrite)
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicU64;
    use std::sync::{Arc, Mutex};

    use rusqlite::Connection;

    use super::{
        CopyOutcome, LocatedClip, LocatedClipError, LocatedClipModule, LocatedClipPlatform,
        LocatedClipSource, LocatedClipWireError, NoteCommit, StateLocatedClipSource,
    };
    use crate::drawer::DrawerState;
    use crate::favorites::FavoritesStore;
    use crate::history::HistoryPolicy;
    use crate::history_state::HistoryState;
    use crate::models::{Clip, ClipKind, ClipLocator, ClipScope, FavoriteItem};
    use crate::persistence::Persistence;

    /// History aggregate fixture seeded through its public capture seam.
    fn history_state(clips: &[Clip]) -> Mutex<HistoryState> {
        let mut state = HistoryState::new(HistoryPolicy::default());
        for clip in clips {
            state.capture(clip.clone()).unwrap();
        }
        Mutex::new(state)
    }

    struct MemorySource;

    impl LocatedClipSource for MemorySource {
        fn resolve(&self, locator: &ClipLocator) -> Result<LocatedClip, LocatedClipError> {
            Ok(LocatedClip {
                id: locator.id.clone(),
                kind: ClipKind::Text,
                text_content: Some("hello".to_string()),
                file_paths: None,
                image_data: None,
                note: None,
                truncated: false,
                source_exe: "test.exe".to_string(),
                source_title: "Test".to_string(),
                captured_at: 1,
                byte_size: 5,
            })
        }

        fn set_note(
            &self,
            _locator: &ClipLocator,
            _note: Option<String>,
        ) -> Result<NoteCommit, LocatedClipError> {
            unreachable!()
        }
    }

    struct RecordingClipboard(Arc<Mutex<Vec<String>>>);

    impl LocatedClipPlatform for RecordingClipboard {
        fn write_text(&self, text: &str) -> Result<(), String> {
            self.0.lock().unwrap().push(format!("text:{text}"));
            Ok(())
        }

        fn write_image(&self, data: &[u8]) -> Result<(), String> {
            self.0.lock().unwrap().push(format!("image:{data:?}"));
            Ok(())
        }

        fn path_exists(&self, path: &str) -> bool {
            !path.contains("missing")
        }

        fn write_files(&self, paths: &[String]) -> Result<(), String> {
            self.0.lock().unwrap().push(format!("files:{paths:?}"));
            Ok(())
        }

        fn image_preview(&self, data: &[u8]) -> Result<String, String> {
            self.0.lock().unwrap().push(format!("preview:{data:?}"));
            Ok("bounded-preview".to_string())
        }
    }

    fn test_module<S, P>(source: S, platform: P) -> LocatedClipModule<S, P>
    where
        S: LocatedClipSource,
        P: LocatedClipPlatform,
    {
        LocatedClipModule::new(source, platform, true, true)
    }

    struct ImageSource(Option<Vec<u8>>);

    impl LocatedClipSource for ImageSource {
        fn resolve(&self, locator: &ClipLocator) -> Result<LocatedClip, LocatedClipError> {
            Ok(LocatedClip {
                id: locator.id.clone(),
                kind: ClipKind::Image,
                text_content: None,
                file_paths: None,
                image_data: self.0.clone(),
                note: None,
                truncated: false,
                source_exe: "test.exe".to_string(),
                source_title: "Test".to_string(),
                captured_at: 1,
                byte_size: 3,
            })
        }

        fn set_note(
            &self,
            _locator: &ClipLocator,
            _note: Option<String>,
        ) -> Result<NoteCommit, LocatedClipError> {
            unreachable!()
        }
    }

    struct FileSource {
        paths: Option<Vec<String>>,
        text: String,
    }

    struct NoteSource(Arc<Mutex<Vec<String>>>);

    impl LocatedClipSource for NoteSource {
        fn resolve(&self, _locator: &ClipLocator) -> Result<LocatedClip, LocatedClipError> {
            unreachable!()
        }

        fn set_note(
            &self,
            locator: &ClipLocator,
            note: Option<String>,
        ) -> Result<NoteCommit, LocatedClipError> {
            self.0
                .lock()
                .unwrap()
                .push(format!("{:?}:{note:?}", locator.scope));
            Ok(NoteCommit {
                note,
                drawer_generation: (locator.scope == ClipScope::Drawer).then_some(7),
            })
        }
    }

    impl LocatedClipSource for FileSource {
        fn resolve(&self, locator: &ClipLocator) -> Result<LocatedClip, LocatedClipError> {
            Ok(LocatedClip {
                id: locator.id.clone(),
                kind: ClipKind::FilePaths,
                text_content: Some(self.text.clone()),
                file_paths: self.paths.clone(),
                image_data: None,
                note: None,
                truncated: false,
                source_exe: "test.exe".to_string(),
                source_title: "Test".to_string(),
                captured_at: 1,
                byte_size: self.text.len() as u64,
            })
        }

        fn set_note(
            &self,
            _locator: &ClipLocator,
            _note: Option<String>,
        ) -> Result<NoteCommit, LocatedClipError> {
            unreachable!()
        }
    }

    #[tokio::test]
    async fn text_paste_contract_is_identical_for_history_and_drawer() {
        for scope in [ClipScope::History, ClipScope::Drawer] {
            let events = Arc::new(Mutex::new(Vec::new()));
            let module = test_module(MemorySource, RecordingClipboard(Arc::clone(&events)));
            let locator = ClipLocator {
                scope,
                id: "item".to_string(),
            };

            module
                .paste(&locator, || {
                    let events = Arc::clone(&events);
                    async move {
                        events.lock().unwrap().push("paste".to_string());
                    }
                })
                .await
                .unwrap();

            assert_eq!(*events.lock().unwrap(), ["text:hello", "paste"]);
        }
    }

    #[tokio::test]
    async fn image_paste_uses_raw_source_bytes_for_both_origins() {
        for scope in [ClipScope::History, ClipScope::Drawer] {
            let events = Arc::new(Mutex::new(Vec::new()));
            let module = test_module(
                ImageSource(Some(vec![1, 2, 3])),
                RecordingClipboard(Arc::clone(&events)),
            );
            let locator = ClipLocator {
                scope,
                id: "image".to_string(),
            };

            module
                .paste(&locator, || {
                    let events = Arc::clone(&events);
                    async move {
                        events.lock().unwrap().push("paste".to_string());
                    }
                })
                .await
                .unwrap();

            assert_eq!(*events.lock().unwrap(), ["image:[1, 2, 3]", "paste"]);
        }
    }

    #[tokio::test]
    async fn missing_image_bytes_fail_before_paste_presentation() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let module = test_module(ImageSource(None), RecordingClipboard(Arc::clone(&events)));
        let locator = ClipLocator {
            scope: ClipScope::Drawer,
            id: "missing-image".to_string(),
        };

        let error = module
            .paste(&locator, || {
                let events = Arc::clone(&events);
                async move { events.lock().unwrap().push("paste".to_string()) }
            })
            .await
            .unwrap_err();

        assert_eq!(error, LocatedClipError::MissingContent);
        assert!(events.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn file_paste_policy_is_shared_by_both_origins() {
        for scope in [ClipScope::History, ClipScope::Drawer] {
            let locator = ClipLocator {
                scope,
                id: "files".to_string(),
            };

            let files_events = Arc::new(Mutex::new(Vec::new()));
            let files_module = test_module(
                FileSource {
                    paths: Some(vec!["C:\\one.txt".to_string(), "C:\\two.txt".to_string()]),
                    text: "C:\\one.txt\r\nC:\\two.txt".to_string(),
                },
                RecordingClipboard(Arc::clone(&files_events)),
            );
            files_module.paste(&locator, || async {}).await.unwrap();
            assert_eq!(
                *files_events.lock().unwrap(),
                ["files:[\"C:\\\\one.txt\", \"C:\\\\two.txt\"]"]
            );

            let text_events = Arc::new(Mutex::new(Vec::new()));
            let text_module = LocatedClipModule::new(
                FileSource {
                    paths: Some(vec!["C:\\one.txt".to_string()]),
                    text: "C:\\one.txt".to_string(),
                },
                RecordingClipboard(Arc::clone(&text_events)),
                false,
                true,
            );
            text_module.paste(&locator, || async {}).await.unwrap();
            assert_eq!(*text_events.lock().unwrap(), ["text:C:\\one.txt"]);
        }
    }

    #[test]
    fn copy_reports_missing_file_fallback_without_requesting_paste() {
        for scope in [ClipScope::History, ClipScope::Drawer] {
            let events = Arc::new(Mutex::new(Vec::new()));
            let module = test_module(
                FileSource {
                    paths: Some(Vec::new()),
                    text: "C:\\missing.txt".to_string(),
                },
                RecordingClipboard(Arc::clone(&events)),
            );
            let locator = ClipLocator {
                scope,
                id: "missing".to_string(),
            };

            assert_eq!(
                module.copy(&locator).unwrap(),
                CopyOutcome::MissingFilesTextFallback
            );
            assert_eq!(*events.lock().unwrap(), ["text:C:\\missing.txt"]);
        }
    }

    #[test]
    fn file_policy_decodes_legacy_paths_and_filters_missing_sources() {
        let locator = ClipLocator {
            scope: ClipScope::Drawer,
            id: "files".to_string(),
        };

        let legacy_events = Arc::new(Mutex::new(Vec::new()));
        let legacy = test_module(
            FileSource {
                paths: None,
                text: "C:\\one.txt;C:\\two.txt".to_string(),
            },
            RecordingClipboard(Arc::clone(&legacy_events)),
        );
        assert_eq!(legacy.copy(&locator).unwrap(), CopyOutcome::Copied);
        assert_eq!(
            *legacy_events.lock().unwrap(),
            ["files:[\"C:\\\\one.txt\", \"C:\\\\two.txt\"]"]
        );

        let partial_events = Arc::new(Mutex::new(Vec::new()));
        let partial = test_module(
            FileSource {
                paths: Some(vec![
                    "C:\\one.txt".to_string(),
                    "C:\\missing.txt".to_string(),
                ]),
                text: "C:\\one.txt\r\nC:\\missing.txt".to_string(),
            },
            RecordingClipboard(Arc::clone(&partial_events)),
        );
        assert_eq!(partial.copy(&locator).unwrap(), CopyOutcome::Copied);
        assert_eq!(
            *partial_events.lock().unwrap(),
            ["files:[\"C:\\\\one.txt\"]"]
        );

        let missing_events = Arc::new(Mutex::new(Vec::new()));
        let missing = test_module(
            FileSource {
                paths: Some(vec!["C:\\missing.txt".to_string()]),
                text: "C:\\missing.txt".to_string(),
            },
            RecordingClipboard(Arc::clone(&missing_events)),
        );
        assert_eq!(
            missing.copy(&locator).unwrap(),
            CopyOutcome::MissingFilesTextFallback
        );
        assert_eq!(*missing_events.lock().unwrap(), ["text:C:\\missing.txt"]);
    }

    #[tokio::test]
    async fn preview_contract_publishes_equivalent_payloads_for_both_origins() {
        for scope in [ClipScope::History, ClipScope::Drawer] {
            let clipboard_events = Arc::new(Mutex::new(Vec::new()));
            let published = Arc::new(Mutex::new(None));
            let module = test_module(MemorySource, RecordingClipboard(clipboard_events));
            let locator = ClipLocator {
                scope,
                id: "preview".to_string(),
            };
            let generation = AtomicU64::new(0);

            module
                .preview(&locator, &generation, |mine, payload| {
                    let published = Arc::clone(&published);
                    async move {
                        *published.lock().unwrap() = Some((mine, payload));
                        Ok(())
                    }
                })
                .await
                .unwrap();

            let guard = published.lock().unwrap();
            let (mine, payload) = guard.as_ref().unwrap();
            assert_eq!(*mine, 1);
            assert_eq!(payload.id, "preview");
            assert_eq!(payload.kind, ClipKind::Text);
            assert_eq!(payload.text_content.as_deref(), Some("hello"));
            assert_eq!(payload.image_preview_base64, None);
            assert_eq!(payload.source_exe, "test.exe");
            assert_eq!(payload.source_title, "Test");
        }
    }

    #[tokio::test]
    async fn preview_matrix_keeps_image_bytes_private_and_file_text_visible() {
        for scope in [ClipScope::History, ClipScope::Drawer] {
            let locator = ClipLocator {
                scope,
                id: "preview-kind".to_string(),
            };
            let image_events = Arc::new(Mutex::new(Vec::new()));
            let image_payload = Arc::new(Mutex::new(None));
            let image_module = test_module(
                ImageSource(Some(vec![4, 5, 6])),
                RecordingClipboard(Arc::clone(&image_events)),
            );
            image_module
                .preview(&locator, &AtomicU64::new(0), |_, payload| {
                    let image_payload = Arc::clone(&image_payload);
                    async move {
                        *image_payload.lock().unwrap() = Some(payload);
                        Ok(())
                    }
                })
                .await
                .unwrap();
            let image_payload = image_payload.lock().unwrap();
            let image_payload = image_payload.as_ref().unwrap();
            assert_eq!(image_payload.kind, ClipKind::Image);
            assert_eq!(
                image_payload.image_preview_base64.as_deref(),
                Some("bounded-preview")
            );
            assert_eq!(*image_events.lock().unwrap(), ["preview:[4, 5, 6]"]);

            let file_payload = Arc::new(Mutex::new(None));
            let file_module = test_module(
                FileSource {
                    paths: Some(vec!["C:\\one.txt".to_string()]),
                    text: "C:\\one.txt".to_string(),
                },
                RecordingClipboard(Arc::new(Mutex::new(Vec::new()))),
            );
            file_module
                .preview(&locator, &AtomicU64::new(0), |_, payload| {
                    let file_payload = Arc::clone(&file_payload);
                    async move {
                        *file_payload.lock().unwrap() = Some(payload);
                        Ok(())
                    }
                })
                .await
                .unwrap();
            let file_payload = file_payload.lock().unwrap();
            let file_payload = file_payload.as_ref().unwrap();
            assert_eq!(file_payload.kind, ClipKind::FilePaths);
            assert_eq!(file_payload.text_content.as_deref(), Some("C:\\one.txt"));
            assert_eq!(file_payload.image_preview_base64, None);
        }
    }

    #[tokio::test]
    async fn disabled_preview_fails_before_resolution_or_generation_claim() {
        let generation = AtomicU64::new(0);
        let module = LocatedClipModule::new(
            MemorySource,
            RecordingClipboard(Arc::new(Mutex::new(Vec::new()))),
            true,
            false,
        );
        let locator = ClipLocator {
            scope: ClipScope::History,
            id: "preview".to_string(),
        };

        let error = module
            .preview(&locator, &generation, |_, _| async { Ok(()) })
            .await
            .unwrap_err();

        assert_eq!(error, LocatedClipError::PreviewDisabled);
        assert_eq!(generation.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[test]
    fn note_contract_normalizes_blank_input_for_both_origins() {
        for scope in [ClipScope::History, ClipScope::Drawer] {
            let events = Arc::new(Mutex::new(Vec::new()));
            let module = test_module(
                NoteSource(Arc::clone(&events)),
                RecordingClipboard(Arc::new(Mutex::new(Vec::new()))),
            );
            let locator = ClipLocator {
                scope,
                id: "note".to_string(),
            };

            let result = module.set_note(&locator, " \n\t".to_string()).unwrap();

            assert_eq!(result.note, None);
            assert_eq!(
                result.drawer_generation,
                (scope == ClipScope::Drawer).then_some(7)
            );
            assert_eq!(*events.lock().unwrap(), [format!("{scope:?}:None")]);
        }
    }

    fn text_clip(id: &str, hash: &str) -> Clip {
        Clip {
            id: id.to_string(),
            kind: ClipKind::Text,
            text_content: Some("durable".to_string()),
            file_paths: None,
            image_data: None,
            thumbnail_base64: None,
            content_hash: hash.to_string(),
            preview: "durable".to_string(),
            note: None,
            truncated: false,
            source_exe: "test.exe".to_string(),
            source_title: "Test".to_string(),
            source_icon: None,
            captured_at: 1,
            pinned: false,
            byte_size: 7,
        }
    }

    fn image_clip(id: &str, hash: &str) -> Clip {
        let mut clip = text_clip(id, hash);
        clip.kind = ClipKind::Image;
        clip.text_content = None;
        clip.image_data = Some(vec![1, 2, 3]);
        clip.byte_size = 3;
        clip
    }

    fn file_clip(id: &str, hash: &str) -> Clip {
        let mut clip = text_clip(id, hash);
        clip.kind = ClipKind::FilePaths;
        clip.text_content = Some("C:\\one.txt".to_string());
        clip.file_paths = Some(vec!["C:\\one.txt".to_string()]);
        clip.byte_size = 10;
        clip
    }

    async fn exercise_production_adapter_contract(
        module: &LocatedClipModule<StateLocatedClipSource<'_>, RecordingClipboard>,
        events: &Arc<Mutex<Vec<String>>>,
        scope: ClipScope,
    ) {
        let examples = [
            ("history-text", "hash-text", ClipKind::Text, "text:durable"),
            (
                "history-image",
                "hash-image",
                ClipKind::Image,
                "image:[1, 2, 3]",
            ),
            (
                "history-files",
                "hash-files",
                ClipKind::FilePaths,
                "files:[\"C:\\\\one.txt\"]",
            ),
        ];

        for (history_id, drawer_id, kind, expected_write) in examples {
            let locator = ClipLocator {
                scope,
                id: if scope == ClipScope::History {
                    history_id.to_string()
                } else {
                    drawer_id.to_string()
                },
            };

            events.lock().unwrap().clear();
            assert_eq!(module.copy(&locator).unwrap(), CopyOutcome::Copied);
            assert_eq!(*events.lock().unwrap(), [expected_write]);

            events.lock().unwrap().clear();
            module
                .paste(&locator, || {
                    let events = Arc::clone(events);
                    async move { events.lock().unwrap().push("paste".to_string()) }
                })
                .await
                .unwrap();
            assert_eq!(*events.lock().unwrap(), [expected_write, "paste"]);

            events.lock().unwrap().clear();
            let published = Arc::new(Mutex::new(None));
            module
                .preview(&locator, &AtomicU64::new(0), |_, payload| {
                    let published = Arc::clone(&published);
                    async move {
                        *published.lock().unwrap() = Some(payload);
                        Ok(())
                    }
                })
                .await
                .unwrap();
            assert_eq!(published.lock().unwrap().as_ref().unwrap().kind, kind);
            if kind == ClipKind::Image {
                assert_eq!(*events.lock().unwrap(), ["preview:[1, 2, 3]"]);
            } else {
                assert!(events.lock().unwrap().is_empty());
            }
        }

        let note_locator = ClipLocator {
            scope,
            id: if scope == ClipScope::History {
                "history-text".to_string()
            } else {
                "hash-text".to_string()
            },
        };
        let note = module
            .set_note(&note_locator, "contract note".to_string())
            .unwrap();
        assert_eq!(note.note.as_deref(), Some("contract note"));
        assert_eq!(note.drawer_generation.is_some(), scope == ClipScope::Drawer);
    }

    #[tokio::test]
    async fn production_history_and_drawer_adapters_run_the_same_action_matrix() {
        let clips = [
            text_clip("history-text", "hash-text"),
            image_clip("history-image", "hash-image"),
            file_clip("history-files", "hash-files"),
        ];
        let mut drawer = DrawerState::new(Some(FavoritesStore::from_conn(
            Connection::open_in_memory().unwrap(),
        )));
        let collection = drawer.create_collection("Contract").unwrap().value;
        for clip in &clips {
            drawer
                .add_snapshot(&collection.id, &FavoriteItem::from(clip.clone()))
                .unwrap();
        }
        let history = history_state(&clips);
        let drawer = Mutex::new(drawer);
        let events = Arc::new(Mutex::new(Vec::new()));
        let module = test_module(
            StateLocatedClipSource::new(&history, &drawer),
            RecordingClipboard(Arc::clone(&events)),
        );

        exercise_production_adapter_contract(&module, &events, ClipScope::History).await;
        exercise_production_adapter_contract(&module, &events, ClipScope::Drawer).await;
    }

    #[tokio::test]
    async fn drawer_actions_survive_history_deletion() {
        let clip = text_clip("history-id", "content-hash");
        let mut drawer = DrawerState::new(Some(FavoritesStore::from_conn(
            Connection::open_in_memory().unwrap(),
        )));
        let collection = drawer.create_collection("Saved").unwrap().value;
        drawer
            .add_snapshot(&collection.id, &FavoriteItem::from(clip))
            .unwrap();

        let history = history_state(&[text_clip("history-id", "content-hash")]);
        history.lock().unwrap().delete("history-id").unwrap();
        let drawer = Mutex::new(drawer);
        let events = Arc::new(Mutex::new(Vec::new()));
        let module = test_module(
            StateLocatedClipSource::new(&history, &drawer),
            RecordingClipboard(Arc::clone(&events)),
        );
        let locator = ClipLocator {
            scope: ClipScope::Drawer,
            id: "content-hash".to_string(),
        };

        assert_eq!(module.copy(&locator).unwrap(), CopyOutcome::Copied);
        assert_eq!(*events.lock().unwrap(), ["text:durable"]);

        events.lock().unwrap().clear();
        module
            .paste(&locator, || {
                let events = Arc::clone(&events);
                async move { events.lock().unwrap().push("paste".to_string()) }
            })
            .await
            .unwrap();
        assert_eq!(*events.lock().unwrap(), ["text:durable", "paste"]);

        let preview = Arc::new(Mutex::new(None));
        module
            .preview(&locator, &AtomicU64::new(0), |_, payload| {
                let preview = Arc::clone(&preview);
                async move {
                    *preview.lock().unwrap() = Some(payload);
                    Ok(())
                }
            })
            .await
            .unwrap();
        assert_eq!(
            preview
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .text_content
                .as_deref(),
            Some("durable")
        );

        let note = module.set_note(&locator, "still here".to_string()).unwrap();
        assert_eq!(note.note.as_deref(), Some("still here"));
        assert!(note.drawer_generation.is_some());
        let refreshed_preview = Arc::new(Mutex::new(None));
        module
            .preview(&locator, &AtomicU64::new(0), |_, payload| {
                let refreshed_preview = Arc::clone(&refreshed_preview);
                async move {
                    *refreshed_preview.lock().unwrap() = Some(payload);
                    Ok(())
                }
            })
            .await
            .unwrap();
        assert_eq!(
            refreshed_preview
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .note
                .as_deref(),
            Some("still here")
        );

        assert_eq!(
            module
                .copy(&ClipLocator {
                    scope: ClipScope::History,
                    id: "history-id".to_string(),
                })
                .unwrap_err(),
            LocatedClipError::NotFound
        );
    }

    #[test]
    fn history_note_persists_before_memory_through_located_interface() {
        let clip = text_clip("history-id", "content-hash");
        let mut state = HistoryState::new(HistoryPolicy::default());
        state
            .enable_persistence(|| Ok(Persistence::in_memory_for_test()))
            .unwrap();
        state.capture(clip).unwrap();
        let history = Mutex::new(state);
        let drawer = Mutex::new(DrawerState::new(None));
        let module = test_module(
            StateLocatedClipSource::new(&history, &drawer),
            RecordingClipboard(Arc::new(Mutex::new(Vec::new()))),
        );
        let locator = ClipLocator {
            scope: ClipScope::History,
            id: "history-id".to_string(),
        };

        module.set_note(&locator, "memo".to_string()).unwrap();

        let state = history.lock().unwrap();
        assert_eq!(
            state.clip("history-id").unwrap().note.as_deref(),
            Some("memo")
        );
        assert_eq!(
            state.durable_clips().unwrap()[0].note.as_deref(),
            Some("memo")
        );
    }

    #[test]
    fn history_note_persistence_failure_leaves_memory_unchanged() {
        let mut state = HistoryState::new(HistoryPolicy::default());
        state
            .capture(text_clip("history-id", "content-hash"))
            .unwrap();
        state.install_persistence_for_test(Persistence::writes_fail_for_test());
        let history = Mutex::new(state);
        let drawer = Mutex::new(DrawerState::new(None));
        let module = test_module(
            StateLocatedClipSource::new(&history, &drawer),
            RecordingClipboard(Arc::new(Mutex::new(Vec::new()))),
        );
        let locator = ClipLocator {
            scope: ClipScope::History,
            id: "history-id".to_string(),
        };

        assert!(matches!(
            module.set_note(&locator, "memo".to_string()),
            Err(LocatedClipError::HistoryPersistence(_))
        ));
        assert_eq!(
            history.lock().unwrap().clip("history-id").unwrap().note,
            None
        );
    }

    #[test]
    fn wire_errors_serialize_code_separately_from_diagnostic_detail() {
        let wire = LocatedClipWireError::from(LocatedClipError::HistoryPersistence(
            "database unavailable".to_string(),
        ));

        assert_eq!(
            serde_json::to_value(wire).unwrap(),
            serde_json::json!({
                "code": "history_persistence",
                "detail": "database unavailable"
            })
        );
    }

    #[test]
    fn production_source_errors_distinguish_not_found_and_drawer_unavailable() {
        let history = Mutex::new(HistoryState::new(HistoryPolicy::default()));
        let available_drawer = Mutex::new(DrawerState::new(Some(FavoritesStore::from_conn(
            Connection::open_in_memory().unwrap(),
        ))));
        let available = test_module(
            StateLocatedClipSource::new(&history, &available_drawer),
            RecordingClipboard(Arc::new(Mutex::new(Vec::new()))),
        );

        for scope in [ClipScope::History, ClipScope::Drawer] {
            assert_eq!(
                available
                    .copy(&ClipLocator {
                        scope,
                        id: "missing".to_string(),
                    })
                    .unwrap_err(),
                LocatedClipError::NotFound
            );
        }

        let unavailable_drawer = Mutex::new(DrawerState::new(None));
        let unavailable = test_module(
            StateLocatedClipSource::new(&history, &unavailable_drawer),
            RecordingClipboard(Arc::new(Mutex::new(Vec::new()))),
        );
        assert_eq!(
            unavailable
                .copy(&ClipLocator {
                    scope: ClipScope::Drawer,
                    id: "missing".to_string(),
                })
                .unwrap_err(),
            LocatedClipError::DrawerUnavailable
        );
    }
}
