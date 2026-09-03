use std::cell::RefCell;
use std::future::Future;
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
    /// A deferred Clip whose clipboard sequence no longer matches: the
    /// content it stood in for is gone forever (clipboard changed, or the
    /// app restarted and the session-scoped flag was lost).
    DeferredExpired,
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
    DeferredExpired,
    ClipboardWrite,
    PreviewDisabled,
    PreviewPublication,
    DrawerMutation,
}

struct LocatedClipErrorParts {
    code: LocatedClipErrorCode,
    detail: Option<String>,
    default_message: &'static str,
}

impl LocatedClipError {
    fn into_parts(self) -> LocatedClipErrorParts {
        let (code, detail, default_message) = match self {
            Self::NotFound => (LocatedClipErrorCode::NotFound, None, "Clip not found"),
            Self::DrawerUnavailable => (
                LocatedClipErrorCode::DrawerUnavailable,
                None,
                "Favorites unavailable",
            ),
            Self::HistoryPersistence(detail) => (
                LocatedClipErrorCode::HistoryPersistence,
                Some(detail),
                "History persistence failed",
            ),
            Self::MissingContent => (
                LocatedClipErrorCode::MissingContent,
                None,
                "Clip content missing",
            ),
            Self::DeferredExpired => (
                LocatedClipErrorCode::DeferredExpired,
                None,
                "Deferred clip content expired",
            ),
            Self::ClipboardWrite(detail) => (
                LocatedClipErrorCode::ClipboardWrite,
                Some(detail),
                "Clipboard write failed",
            ),
            Self::PreviewDisabled => (
                LocatedClipErrorCode::PreviewDisabled,
                None,
                "Preview disabled",
            ),
            Self::PreviewPublication(detail) => (
                LocatedClipErrorCode::PreviewPublication,
                Some(detail),
                "Preview publication failed",
            ),
            Self::DrawerMutation(detail) => (
                LocatedClipErrorCode::DrawerMutation,
                Some(detail),
                "Drawer mutation failed",
            ),
        };
        LocatedClipErrorParts {
            code,
            detail,
            default_message,
        }
    }

    pub(crate) fn command_message(self) -> String {
        let parts = self.into_parts();
        parts
            .detail
            .unwrap_or_else(|| parts.default_message.to_string())
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct LocatedClipWireError {
    code: LocatedClipErrorCode,
    detail: Option<String>,
}

impl From<LocatedClipError> for LocatedClipWireError {
    fn from(error: LocatedClipError) -> Self {
        let parts = error.into_parts();
        Self {
            code: parts.code,
            detail: parts.detail,
        }
    }
}

pub(crate) enum ResolvedClip {
    History(Clip),
    Drawer(FavoriteItem),
}

impl ResolvedClip {
    fn into_snapshot(self) -> FavoriteItem {
        match self {
            Self::History(clip) => FavoriteItem::from(clip),
            Self::Drawer(item) => item,
        }
    }

    fn into_content_hash(self) -> String {
        match self {
            Self::History(clip) => clip.content_hash,
            Self::Drawer(item) => item.content_hash,
        }
    }

    /// Deferred sequence for History clips. Drawer snapshots never carry it:
    /// a favorite materializes its content at add time, so a deferred Clip
    /// falls back to the pre-existing MissingContent path there.
    fn deferred_sequence(&self) -> Option<u32> {
        match self {
            Self::History(clip) => clip.deferred,
            Self::Drawer(_) => None,
        }
    }
}

macro_rules! with_resolved_clip {
    ($resolved:expr, |$clip:ident| $body:expr) => {
        match $resolved {
            ResolvedClip::History($clip) => $body,
            ResolvedClip::Drawer($clip) => $body,
        }
    };
}

pub(crate) struct NoteCommit {
    pub(crate) note: Option<String>,
    pub(crate) drawer_generation: Option<u64>,
}

impl From<Clip> for ResolvedClip {
    fn from(clip: Clip) -> Self {
        Self::History(clip)
    }
}

impl From<FavoriteItem> for ResolvedClip {
    fn from(item: FavoriteItem) -> Self {
        Self::Drawer(item)
    }
}

pub(crate) trait LocatedClipSource {
    fn resolve(&self, locator: &ClipLocator) -> Result<ResolvedClip, LocatedClipError>;

    fn resolve_snapshot(&self, locator: &ClipLocator) -> Result<FavoriteItem, LocatedClipError> {
        self.resolve(locator).map(ResolvedClip::into_snapshot)
    }

    fn resolve_content_hash(&self, locator: &ClipLocator) -> Result<String, LocatedClipError> {
        self.resolve(locator).map(ResolvedClip::into_content_hash)
    }

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
    fn resolve(&self, locator: &ClipLocator) -> Result<ResolvedClip, LocatedClipError> {
        lock(self.history)
            .clip(&locator.id)
            .map(ResolvedClip::from)
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

fn resolve_drawer_snapshot(
    drawer: &DrawerState,
    locator: &ClipLocator,
) -> Result<ResolvedClip, LocatedClipError> {
    if !drawer.has_favorites_store() {
        return Err(LocatedClipError::DrawerUnavailable);
    }
    drawer
        .get_item(&locator.id)
        .map_err(LocatedClipError::DrawerMutation)?
        .map(ResolvedClip::from)
        .ok_or(LocatedClipError::NotFound)
}

fn set_drawer_note(
    drawer: &mut DrawerState,
    locator: &ClipLocator,
    note: Option<String>,
) -> Result<NoteCommit, LocatedClipError> {
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

impl LocatedClipSource for DrawerSnapshotAdapter<'_> {
    fn resolve(&self, locator: &ClipLocator) -> Result<ResolvedClip, LocatedClipError> {
        resolve_drawer_snapshot(&lock(self.drawer), locator)
    }

    fn set_note(
        &self,
        locator: &ClipLocator,
        note: Option<String>,
    ) -> Result<NoteCommit, LocatedClipError> {
        set_drawer_note(&mut lock(self.drawer), locator, note)
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
    fn resolve(&self, locator: &ClipLocator) -> Result<ResolvedClip, LocatedClipError> {
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

/// Located-Clip adapter used while the Drawer aggregate lock is already held.
/// It prevents add/lookup commands from resolving a snapshot, releasing the
/// aggregate, and then reacquiring it for the dependent operation.
pub(crate) struct LockedStateLocatedClipSource<'a> {
    history: HistoryAdapter<'a>,
    drawer: RefCell<&'a mut DrawerState>,
}

impl<'a> LockedStateLocatedClipSource<'a> {
    pub(crate) fn new(history: &'a Mutex<HistoryState>, drawer: &'a mut DrawerState) -> Self {
        Self {
            history: HistoryAdapter { history },
            drawer: RefCell::new(drawer),
        }
    }
}

impl LocatedClipSource for LockedStateLocatedClipSource<'_> {
    fn resolve(&self, locator: &ClipLocator) -> Result<ResolvedClip, LocatedClipError> {
        match locator.scope {
            ClipScope::History => self.history.resolve(locator),
            ClipScope::Drawer => resolve_drawer_snapshot(&self.drawer.borrow(), locator),
        }
    }

    fn set_note(
        &self,
        locator: &ClipLocator,
        note: Option<String>,
    ) -> Result<NoteCommit, LocatedClipError> {
        match locator.scope {
            ClipScope::History => self.history.set_note(locator, note),
            ClipScope::Drawer => set_drawer_note(&mut self.drawer.borrow_mut(), locator, note),
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
        generation: u64,
        publish: Publish,
    ) -> Result<(), LocatedClipError>
    where
        Publish: FnOnce(u64, PreviewPayload) -> F,
        F: Future<Output = Result<(), String>>,
    {
        if !self.preview_enabled {
            return Err(LocatedClipError::PreviewDisabled);
        }
        with_resolved_clip!(self.source.resolve(locator)?, |clip| {
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
            publish(generation, payload)
                .await
                .map_err(LocatedClipError::PreviewPublication)
        })
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
        let resolved = self.source.resolve(locator)?;
        // A deferred Clip stands in for content the monitor never read
        // (delayed-render source, lost render). While the clipboard sequence
        // is unchanged, the content is still on the clipboard — skip the
        // write entirely so the paste target renders it itself, preserving
        // the source app's rich formats Mnemark never stored. Once the
        // sequence moved, that content is gone forever.
        if let Some(seq) = resolved.deferred_sequence() {
            if crate::clipboard::clipboard_sequence() == seq {
                return Ok(CopyOutcome::Copied);
            }
            return Err(LocatedClipError::DeferredExpired);
        }
        with_resolved_clip!(resolved, |clip| {
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
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use rusqlite::Connection;

    use super::{
        CopyOutcome, LocatedClipError, LocatedClipModule, LocatedClipPlatform, LocatedClipSource,
        LocatedClipWireError, LockedStateLocatedClipSource, NoteCommit, ResolvedClip,
        StateLocatedClipSource,
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
        fn resolve(&self, locator: &ClipLocator) -> Result<ResolvedClip, LocatedClipError> {
            let mut clip = text_clip(&locator.id, "memory-text");
            clip.text_content = Some("hello".to_string());
            clip.preview = "hello".to_string();
            clip.byte_size = 5;
            Ok(ResolvedClip::History(clip))
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
        fn resolve(&self, locator: &ClipLocator) -> Result<ResolvedClip, LocatedClipError> {
            let mut clip = image_clip(&locator.id, "memory-image");
            clip.image_data = self.0.clone();
            Ok(ResolvedClip::History(clip))
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
        fn resolve(&self, _locator: &ClipLocator) -> Result<ResolvedClip, LocatedClipError> {
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
        fn resolve(&self, locator: &ClipLocator) -> Result<ResolvedClip, LocatedClipError> {
            let mut clip = file_clip(&locator.id, "memory-files");
            clip.text_content = Some(self.text.clone());
            clip.file_paths = self.paths.clone();
            clip.byte_size = self.text.len() as u64;
            Ok(ResolvedClip::History(clip))
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
            module
                .preview(&locator, 7, |mine, payload| {
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
            assert_eq!(*mine, 7);
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
                .preview(&locator, 1, |_, payload| {
                    let image_payload = Arc::clone(&image_payload);
                    async move {
                        *image_payload.lock().unwrap() = Some(payload);
                        Ok(())
                    }
                })
                .await
                .unwrap();
            {
                let image_payload = image_payload.lock().unwrap();
                let image_payload = image_payload.as_ref().unwrap();
                assert_eq!(image_payload.kind, ClipKind::Image);
                assert_eq!(
                    image_payload.image_preview_base64.as_deref(),
                    Some("bounded-preview")
                );
            }
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
                .preview(&locator, 1, |_, payload| {
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
    async fn disabled_preview_fails_before_resolution_or_publication() {
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
            .preview(&locator, 1, |_, _| async { Ok(()) })
            .await
            .unwrap_err();

        assert_eq!(error, LocatedClipError::PreviewDisabled);
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
            deferred: None,        }
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

    fn deferred_clip(id: &str, seq: u32) -> Clip {
        let mut clip = text_clip(id, "deferred-hash");
        clip.text_content = None;
        clip.byte_size = 0;
        clip.deferred = Some(seq);
        clip
    }

    /// A deferred Clip stands in for content that is still live on the
    /// clipboard: while the sequence number is unchanged, the write is
    /// skipped entirely — the paste target renders the delayed content
    /// itself — and the action still counts as copied.
    #[tokio::test]
    async fn deferred_clip_skips_the_write_while_the_clipboard_is_untouched() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let history = history_state(&[deferred_clip("d1", crate::clipboard::clipboard_sequence())]);
        let drawer = Mutex::new(DrawerState::new(None));
        let module = test_module(
            StateLocatedClipSource::new(&history, &drawer),
            RecordingClipboard(Arc::clone(&events)),
        );

        let locator = ClipLocator {
            scope: ClipScope::History,
            id: "d1".to_string(),
        };
        assert_eq!(module.copy(&locator).unwrap(), CopyOutcome::Copied);
        assert!(
            events.lock().unwrap().is_empty(),
            "no platform write may run"
        );
        module
            .paste(&locator, || async {})
            .await
            .unwrap();
        assert!(
            events.lock().unwrap().is_empty(),
            "paste must also skip the platform write"
        );
    }

    /// Once the clipboard moved on, the content a deferred Clip stood in for
    /// is gone forever — the paste fails with DeferredExpired instead of
    /// silently writing the WRONG clipboard content into the target app.
    #[test]
    fn deferred_clip_expires_once_the_clipboard_moved_on() {
        let stale = crate::clipboard::clipboard_sequence().wrapping_add(1);
        let history = history_state(&[deferred_clip("d1", stale)]);
        let drawer = Mutex::new(DrawerState::new(None));
        let module = test_module(
            StateLocatedClipSource::new(&history, &drawer),
            RecordingClipboard(Arc::new(Mutex::new(Vec::new()))),
        );

        let locator = ClipLocator {
            scope: ClipScope::History,
            id: "d1".to_string(),
        };
        assert_eq!(
            module.copy(&locator),
            Err(LocatedClipError::DeferredExpired)
        );
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
                .preview(&locator, 1, |_, payload| {
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

    #[test]
    fn locked_source_resolves_snapshots_and_hashes_by_the_scope_identity_rule() {
        let clip = text_clip("history-id", "content-hash");
        let history = history_state(std::slice::from_ref(&clip));
        let mut drawer = DrawerState::new(Some(FavoritesStore::from_conn(
            Connection::open_in_memory().unwrap(),
        )));
        let collection = drawer.create_collection("Saved").unwrap().value;
        drawer
            .add_snapshot(&collection.id, &FavoriteItem::from(clip))
            .unwrap();
        let source = LockedStateLocatedClipSource::new(&history, &mut drawer);

        let history_locator = ClipLocator {
            scope: ClipScope::History,
            id: "history-id".to_string(),
        };
        let drawer_locator = ClipLocator {
            scope: ClipScope::Drawer,
            id: "content-hash".to_string(),
        };

        assert_eq!(
            source.resolve_snapshot(&history_locator).unwrap().id,
            "content-hash"
        );
        assert_eq!(
            source.resolve_snapshot(&drawer_locator).unwrap().id,
            "content-hash"
        );
        assert_eq!(
            source.resolve_content_hash(&history_locator).unwrap(),
            "content-hash"
        );
        assert_eq!(
            source.resolve_content_hash(&drawer_locator).unwrap(),
            "content-hash"
        );
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
            .preview(&locator, 1, |_, payload| {
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
            .preview(&locator, 1, |_, payload| {
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
