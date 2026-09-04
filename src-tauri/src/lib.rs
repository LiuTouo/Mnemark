mod capture_policy;
mod clip_encoding;
mod clipboard;
#[cfg(test)]
mod clipboard_busy_probe; // regression probes: delayed-render capture/paste interference
mod config_transaction;
mod drawer;
mod favorites;
mod history;
mod history_state;
mod located_clip;
mod migration;
mod models;
mod panel_session;
mod persistence;
mod startup;
mod update;

use capture_policy::{
    CaptureDecision, CaptureEmitter, CaptureHistory, CaptureStoreOutcome, CaptureStoreRequest,
    ClipboardCaptureOutcome, ClipboardCapturer, ClipboardMonitor, ClipboardSequenceReader,
    ClipboardSourceSampler, SkipReason,
};
use config_transaction::{run_config_update, ConfigEffects};
use drawer::{DrawerMutation, DrawerState, DrawerViewInvalidation, DrawerViewState};
use favorites::FavoritesStore;
use history::HistoryPolicy;
use history_state::HistoryState;
use located_clip::{
    CopyOutcome, LocatedClipModule, LocatedClipSource, LocatedClipWireError,
    LockedStateLocatedClipSource, StateLocatedClipSource, SystemLocatedClipPlatform,
};
use models::{
    AppConfig, BatchMutationResult, Clip, ClipLocator, ClipboardSource, CollectionSummary,
    PanelShortcut, PreviewPayload, CURRENT_TUTORIAL_VERSION,
};
use panel_session::{PanelSession, PasteAction, SystemForegroundWindowSource, SystemPanelClock};
use persistence::Persistence;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

/// While an in-workspace modal is open, focus may legitimately move to
/// another application without dismissing Mnemark. The main window is reused,
/// so this flag is explicitly cleared whenever the panel hides or reopens.
static MAIN_MODAL_OPEN: AtomicBool = AtomicBool::new(false);

/// Lock a shared-state mutex, recovering from poisoning instead of
/// panicking. Clipboard state is best-effort: every mutation is a simple
/// Vec/field update that cannot leave the structure inconsistent, so a
/// guard poisoned by a panicking caller is safe to recover — panicking
/// here instead would cascade into the monitor thread (via its own lock
/// calls) and silently kill clipboard capture.
pub(crate) fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

struct AppState {
    /// Authoritative History aggregate: in-memory store, capacity policy,
    /// optional persistence and the undo entry share one lock, so a mutation
    /// can never interleave with another (same boundary as the Drawer).
    history: Arc<Mutex<HistoryState>>,
    config: Arc<Mutex<AppConfig>>,
    monitor_running: Arc<Mutex<bool>>,
    tray_items: Arc<Mutex<Option<TrayMenuItems>>>,
    /// Hotkey-registration failure that opened Settings at startup, shown
    /// inline there (CONTEXT: Hotkey conflict detection).
    startup_error: Arc<Mutex<Option<String>>>,
    /// Active clip preview payload. Kept so a freshly loaded preview page can
    /// call get_active_clip_preview and cannot miss the first update event.
    preview: Arc<Mutex<Option<PreviewPayload>>>,
    /// Temporal state for dismissal, Paste handoff, and preview publication.
    panel_session: PanelSession<SystemPanelClock, SystemForegroundWindowSource>,
    /// Authoritative Drawer aggregate: durable store, session UI state, and
    /// process-local mutation generation share one lock.
    drawer: Arc<Mutex<DrawerState>>,
    /// Logical width inserted to the left of the history panel in the single
    /// main workspace. Used to keep the history panel anchored while resizing.
    workspace_left_extent: Arc<Mutex<u32>>,
    workspace_right_extent: Arc<Mutex<u32>>,
}

/// Handles to the tray menu items, kept so their labels can be re-localized
/// when the UI language changes.
struct TrayMenuItems {
    pause: tauri::menu::MenuItem<tauri::Wry>,
    settings: tauri::menu::MenuItem<tauri::Wry>,
    tutorial: tauri::menu::MenuItem<tauri::Wry>,
    about: tauri::menu::MenuItem<tauri::Wry>,
    quit: tauri::menu::MenuItem<tauri::Wry>,
}

struct TrayLabels {
    pause: &'static str,
    resume: &'static str,
    settings: &'static str,
    tutorial: &'static str,
    about: &'static str,
    quit: &'static str,
}

fn tray_labels(lang: &str) -> TrayLabels {
    match lang {
        "en" => TrayLabels {
            pause: "Pause Monitoring",
            resume: "Resume Monitoring",
            settings: "Settings",
            tutorial: "Tutorial",
            about: "About",
            quit: "Quit",
        },
        _ => TrayLabels {
            pause: "暫停監聽",
            resume: "繼續監聽",
            settings: "設定",
            tutorial: "教學",
            about: "關於",
            quit: "結束",
        },
    }
}

/// Every History command is one aggregate call plus a wire mapping: the
/// consistency policy lives in the History module, not in transport code.

#[tauri::command]
fn get_clips(state: tauri::State<AppState>) -> Vec<Clip> {
    lock(&state.history).clips_for_ipc()
}

#[tauri::command]
fn delete_clip(id: String, state: tauri::State<AppState>) -> Result<(), String> {
    lock(&state.history)
        .delete(&id)
        .map(|_| ())
        .map_err(|e| e.message())
}

#[tauri::command]
fn undo_delete(id: String, state: tauri::State<AppState>) -> Result<Clip, String> {
    lock(&state.history)
        .undo_delete(&id)
        .map_err(|e| e.message())
}

#[tauri::command]
fn delete_clips(ids: Vec<String>, state: tauri::State<AppState>) -> Result<(), String> {
    lock(&state.history)
        .delete_many(&ids)
        .map(|_| ())
        .map_err(|e| e.message())
}

#[tauri::command]
fn undo_delete_batch(ids: Vec<String>, state: tauri::State<AppState>) -> Result<(), String> {
    lock(&state.history)
        .undo_delete_batch(&ids)
        .map_err(|e| e.message())
}

#[tauri::command]
fn set_pinned(id: String, pinned: bool, state: tauri::State<AppState>) -> Result<(), String> {
    lock(&state.history)
        .set_pinned(&id, pinned)
        .map_err(|e| e.message())
}

#[tauri::command]
fn get_config(state: tauri::State<AppState>) -> AppConfig {
    let config = lock(&state.config);
    config.clone()
}

/// The hotkey-registration failure that opened Settings at startup, if any.
/// Taken (read once, then cleared) so the page shows it exactly once.
#[tauri::command]
fn take_startup_error(state: tauri::State<AppState>) -> Option<String> {
    lock(&state.startup_error).take()
}

/// Register `new_hotkey` before unregistering `old_hotkey`, so a conflict never
/// leaves the Panel without a working shortcut.
fn swap_panel_hotkey(
    app: &tauri::AppHandle,
    old_hotkey: &str,
    new_hotkey: &str,
) -> Result<(), String> {
    let new_shortcut = new_hotkey
        .parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map_err(|e| format!("Invalid hotkey '{}': {}", new_hotkey, e))?;
    let old_shortcut = old_hotkey
        .parse::<tauri_plugin_global_shortcut::Shortcut>()
        .ok();
    if old_shortcut.as_ref() == Some(&new_shortcut) {
        return Ok(());
    }

    register_panel_hotkey(app, new_hotkey)?;
    if let Some(old) = old_shortcut {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let _ = app.global_shortcut().unregister(old);
    }
    Ok(())
}

/// Undo a completed hotkey swap in the same operation order as the previous
/// hand-written rollback: remove the rejected new chord, then restore the old.
fn restore_panel_hotkey(
    app: &tauri::AppHandle,
    new_hotkey: &str,
    old_hotkey: &str,
) -> Result<(), String> {
    if let Ok(new_shortcut) = new_hotkey.parse::<tauri_plugin_global_shortcut::Shortcut>() {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let _ = app.global_shortcut().unregister(new_shortcut);
    }
    register_panel_hotkey(app, old_hotkey)
}

/// Current wall-clock time in milliseconds since the Unix epoch (the same unit
/// as `Clip::captured_at` and the persistence cleanup clock).
pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Apply the persistence side of a config change, through the aggregate. When
/// enabling: the History module opens the database and atomically dumps the
/// current in-memory History before entering write-through mode. When
/// disabling: every persisted history row is deleted in one transaction
/// before the connection is dropped — the DB file stays in place (it hosts
/// Drawer data), but no clips rows survive the toggle. Any failure leaves the
/// previous mode intact.
fn apply_persist(state: &AppState, enabled: bool) -> Result<(), String> {
    let mut history = lock(&state.history);
    if enabled {
        history
            .enable_persistence(Persistence::open)
            .map_err(|e| e.message())
    } else {
        history
            .disable_persistence(now_ms())
            .map_err(|e| e.message())
    }
}

struct SystemConfigEffects<'a> {
    app: &'a tauri::AppHandle,
    state: &'a AppState,
}

impl ConfigEffects for SystemConfigEffects<'_> {
    fn hotkey_change_needed(&self, old_hotkey: &str, new_hotkey: &str) -> bool {
        let Ok(new_shortcut) = new_hotkey.parse::<tauri_plugin_global_shortcut::Shortcut>() else {
            // Validation will surface the parse error before effects run.
            return true;
        };
        old_hotkey
            .parse::<tauri_plugin_global_shortcut::Shortcut>()
            .ok()
            .as_ref()
            != Some(&new_shortcut)
    }

    fn apply_hotkey(&self, old_hotkey: &str, new_hotkey: &str) -> Result<(), String> {
        swap_panel_hotkey(self.app, old_hotkey, new_hotkey)
    }

    fn undo_hotkey(&self, new_hotkey: &str, old_hotkey: &str) -> Result<(), String> {
        restore_panel_hotkey(self.app, new_hotkey, old_hotkey)
    }

    fn set_startup(&self, enabled: bool) -> Result<(), String> {
        startup::set_startup(enabled)
    }

    fn set_persistence(&self, enabled: bool) -> Result<(), String> {
        apply_persist(self.state, enabled)
    }

    fn save_config(&self, config: &AppConfig) -> Result<(), String> {
        config.save()
    }
}

fn validate_config_update(new_config: &AppConfig, old_config: &AppConfig) -> Result<(), String> {
    new_config.favorites_toggle_shortcut.validate()?;
    if new_config
        .favorites_toggle_shortcut
        .equivalent_to_hotkey(&new_config.hotkey)
    {
        return Err("Drawer shortcut conflicts with the panel hotkey".to_string());
    }

    if new_config.hotkey == old_config.hotkey {
        return Ok(());
    }

    // A bare key (e.g. "A" or "F1") as a global shortcut makes that key
    // unusable in every other application — require a modifier.
    let has_modifier = ["Ctrl", "Shift", "Alt", "Super"]
        .iter()
        .any(|modifier| new_config.hotkey.contains(modifier));
    if !has_modifier {
        return Err(format!(
            "Hotkey '{}' must include at least one modifier (Ctrl/Shift/Alt)",
            new_config.hotkey
        ));
    }

    new_config
        .hotkey
        .parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map(|_| ())
        .map_err(|e| format!("Invalid hotkey '{}': {}", new_config.hotkey, e))
}

/// Non-transactional success-path work. The ordering is intentional: tray
/// localization, runtime config/policy sync, preview hide, update check, zoom.
fn apply_config_follow_ups(
    new_config: &AppConfig,
    old_config: &AppConfig,
    app: &tauri::AppHandle,
    state: &AppState,
) {
    if new_config.language != old_config.language {
        let labels = tray_labels(&new_config.language);
        let running = *lock(&state.monitor_running);
        let items = lock(&state.tray_items);
        if let Some(items) = items.as_ref() {
            let _ = items
                .pause
                .set_text(if running { labels.pause } else { labels.resume });
            let _ = items.settings.set_text(labels.settings);
            let _ = items.tutorial.set_text(labels.tutorial);
            let _ = items.about.set_text(labels.about);
            let _ = items.quit.set_text(labels.quit);
        }
    }

    let auto_update_turned_on = !old_config.auto_update && new_config.auto_update;
    let preview_turned_off = old_config.preview_enabled && !new_config.preview_enabled;
    let ui_scale_changed = new_config.ui_scale_percent != old_config.ui_scale_percent;

    *lock(&state.config) = new_config.clone();
    // New limits apply from the next capture/restore; existing Clips are not
    // re-trimmed, preserving the existing observable capacity semantics.
    lock(&state.history).set_policy(HistoryPolicy::from(new_config));

    if preview_turned_off {
        hide_preview_window(app);
    }
    if auto_update_turned_on {
        update::spawn_auto_update_check(app.clone(), state.config.clone());
    }
    if ui_scale_changed {
        // Cosmetic best-effort: the config is already on disk, so a failed
        // zoom call only leaves this session at the old scale.
        apply_ui_scale(app);
    }
}

#[tauri::command]
fn update_config(
    new_config: AppConfig,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let new_config = new_config.sanitized();
    let effects = SystemConfigEffects {
        app: &app,
        state: state.inner(),
    };

    run_config_update(
        || lock(&state.config).clone(),
        &new_config,
        validate_config_update,
        &effects,
        |target, snapshot| apply_config_follow_ups(target, snapshot, &app, &state),
    )
}

/// Write content to the clipboard, hide the Panel so focus returns to the
/// previous window, WAIT for that focus change to actually happen (a blind
/// fixed sleep loses pastes whenever focus is slow to move), then send
/// Ctrl+V.
async fn hide_and_paste(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let action = state.panel_session.prepare_paste(|| hide_panel(app)).await;
    if action == PasteAction::SuppressDesktop {
        log("[Mnemark] paste suppressed: foreground is the desktop shell");
        return;
    }
    if action == PasteAction::SuppressUnexpectedTarget {
        log("[Mnemark] paste suppressed: the previously focused window did not regain focus");
        return;
    }
    if let Err(e) = clipboard::simulate_ctrl_v() {
        // Phase-2 failure path per the Paste spec: the content is already
        // on the clipboard, so the user can still Ctrl+V manually.
        log(&format!("[Mnemark] paste simulation failed: {}", e));
    }
}

fn located_clip_module(
    state: &AppState,
) -> LocatedClipModule<StateLocatedClipSource<'_>, SystemLocatedClipPlatform> {
    let config = lock(&state.config);
    LocatedClipModule::new(
        StateLocatedClipSource::new(state.history.as_ref(), state.drawer.as_ref()),
        SystemLocatedClipPlatform,
        config.paste_files_as_files,
        config.preview_enabled,
    )
}

#[tauri::command]
async fn paste_located_clip(
    app: tauri::AppHandle,
    locator: ClipLocator,
    state: tauri::State<'_, AppState>,
) -> Result<CopyOutcome, LocatedClipWireError> {
    located_clip_module(&state)
        .paste(&locator, || hide_and_paste(&app))
        .await
        .map_err(LocatedClipWireError::from)
}

#[tauri::command]
fn copy_located_clip(
    locator: ClipLocator,
    state: tauri::State<AppState>,
) -> Result<CopyOutcome, LocatedClipWireError> {
    located_clip_module(&state)
        .copy(&locator)
        .map_err(LocatedClipWireError::from)
}

#[tauri::command]
async fn show_located_clip_preview(
    locator: ClipLocator,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), LocatedClipWireError> {
    let generation = state.panel_session.claim_preview();
    located_clip_module(&state)
        .preview(&locator, generation, |generation, payload| {
            commit_preview_on_main_thread(&app, generation, payload)
        })
        .await
        .map_err(LocatedClipWireError::from)
}

#[tauri::command]
fn set_located_clip_note(
    locator: ClipLocator,
    note: String,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<Option<String>, LocatedClipWireError> {
    let commit = located_clip_module(&state)
        .set_note(&locator, note)
        .map_err(LocatedClipWireError::from)?;
    if let Some(generation) = commit.drawer_generation {
        let _ = app.emit(
            "drawer-view-invalidated",
            DrawerViewInvalidation { generation },
        );
    }
    Ok(commit.note)
}

// === Drawer ===

/// Run a read against the authoritative Drawer aggregate.
fn with_drawer<T>(
    state: &AppState,
    read: impl FnOnce(&DrawerState) -> Result<T, String>,
) -> Result<T, String> {
    read(&lock(&state.drawer))
}

/// Apply one Drawer mutation while holding the aggregate lock, then publish
/// only its generation after the lock has been released. Event delivery is an
/// invalidation hint and cannot turn a committed mutation into an error.
fn mutate_drawer<T>(
    state: &AppState,
    app: &tauri::AppHandle,
    mutation: impl FnOnce(&mut DrawerState) -> Result<DrawerMutation<T>, String>,
) -> Result<T, String> {
    let DrawerMutation { value, generation } = {
        let mut drawer = lock(&state.drawer);
        mutation(&mut drawer)?
    };
    let _ = app.emit(
        "drawer-view-invalidated",
        DrawerViewInvalidation { generation },
    );
    Ok(value)
}

#[tauri::command]
fn get_drawer_view(state: tauri::State<AppState>) -> Result<DrawerViewState, String> {
    with_drawer(&state, DrawerState::view)
}

#[tauri::command]
fn create_collection(
    name: String,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<CollectionSummary, String> {
    mutate_drawer(&state, &app, |drawer| drawer.create_collection(&name))
}

#[tauri::command]
fn rename_collection(
    id: String,
    name: String,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<CollectionSummary, String> {
    mutate_drawer(&state, &app, |drawer| drawer.rename_collection(&id, &name))
}

#[tauri::command]
fn delete_collection(
    id: String,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    mutate_drawer(&state, &app, |drawer| drawer.delete_collection(&id))?;
    Ok(())
}

#[tauri::command]
fn reorder_collections(
    ids: Vec<String>,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    mutate_drawer(&state, &app, |drawer| drawer.reorder_collections(&ids))
}

#[tauri::command]
fn reorder_favorite_items(
    collection_id: String,
    ids: Vec<String>,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    mutate_drawer(&state, &app, |drawer| {
        drawer.reorder_items(&collection_id, &ids)
    })
}

#[tauri::command]
fn add_favorite(
    collection_id: String,
    locator: ClipLocator,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    mutate_drawer(&state, &app, |drawer| {
        let item = LockedStateLocatedClipSource::new(state.history.as_ref(), drawer)
            .resolve_snapshot(&locator)
            .map_err(|error| error.command_message())?;
        drawer.add_snapshot(&collection_id, &item)
    })
}

#[tauri::command]
fn add_favorites(
    collection_id: String,
    locators: Vec<ClipLocator>,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<BatchMutationResult, String> {
    if locators.is_empty() {
        return Err("Batch must include at least one favorite".to_string());
    }
    mutate_drawer(&state, &app, |drawer| {
        let items = {
            let source = LockedStateLocatedClipSource::new(state.history.as_ref(), drawer);
            locators
                .iter()
                .map(|locator| {
                    source
                        .resolve_snapshot(locator)
                        .map_err(|error| error.command_message())
                })
                .collect::<Result<Vec<_>, _>>()?
        };
        drawer.add_snapshots(&collection_id, &items)
    })
}

#[tauri::command]
fn remove_favorite(
    collection_id: String,
    item_id: String,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    mutate_drawer(&state, &app, |drawer| {
        drawer.remove_snapshot(&collection_id, &item_id)
    })
}

#[tauri::command]
fn remove_favorites(
    collection_id: String,
    item_ids: Vec<String>,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<BatchMutationResult, String> {
    mutate_drawer(&state, &app, |drawer| {
        drawer.remove_snapshots(&collection_id, &item_ids)
    })
}

/// Which collections reference this clip (empty when not favorited). Lets the
/// history panel show a favorite state for a history item after its history
/// entry was deleted and re-added, or cross-reference a favorite.
#[tauri::command]
fn favorite_collection_ids(
    locator: ClipLocator,
    state: tauri::State<AppState>,
) -> Result<Vec<String>, String> {
    let mut drawer = lock(&state.drawer);
    let hash = {
        let source = LockedStateLocatedClipSource::new(state.history.as_ref(), &mut drawer);
        source
            .resolve_content_hash(&locator)
            .map_err(|error| error.command_message())?
    };
    drawer.collection_ids_for_item(&hash)
}

/// Open/close the inline drawer pane. Closing clears the selection.
#[tauri::command]
fn set_favorites_open(
    open: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    mutate_drawer(&state, &app, |drawer| drawer.set_open(open))?;
    Ok(())
}

/// Toggle the inline drawer pane from its authoritative session state.
#[tauri::command]
fn toggle_favorites_sidebar(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    mutate_drawer(&state, &app, DrawerState::toggle_open)?;
    Ok(())
}

/// Select a collection (or `None` for history). Never changes `open`.
#[tauri::command]
fn set_favorites_selected(
    collection_id: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    mutate_drawer(&state, &app, |drawer| drawer.set_selected(collection_id))?;
    Ok(())
}

/// Commit a prepared preview to the UI on the Tauri main thread and hand the
/// result back to the awaiting async command. Heavy work stays off the main
/// thread; only this one non-blocking closure runs there, so its generation
/// re-check and window mutation are ordered with respect to every other
/// main-thread task (and to the hide/clear ordering).
async fn commit_preview_on_main_thread(
    app: &tauri::AppHandle,
    generation: u64,
    payload: PreviewPayload,
) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let state = handle.state::<AppState>();
        // Re-check the generation before any window mutation: a superseded
        // show completes as a no-op.
        if !state.panel_session.preview_is_current(generation) {
            let _ = tx.send(Ok(()));
            return;
        }
        let _ = tx.send(commit_preview_window(&handle, generation, &payload));
    })
    .map_err(|e| format!("run_on_main_thread failed: {:?}", e))?;

    rx.await
        .map_err(|_| "preview commit channel closed".to_string())?
}

/// Commit the current preview payload to the inline pane in the main WebView.
fn commit_preview_window(
    app: &tauri::AppHandle,
    generation: u64,
    payload: &PreviewPayload,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    *lock(&state.preview) = Some(payload.clone());
    let _ = app.emit("preview-payload-updated", payload);
    let _ = generation;
    Ok(())
}

#[tauri::command]
fn hide_clip_preview(app: tauri::AppHandle) {
    hide_preview_window(&app);
}

/// Hide the Panel (and its attached preview) as a temporary suspension, keeping
/// the saved preview payload so a later show_panel restores it. The frontend
/// closePanel routes through here so both windows hide atomically instead of
/// relying on the deferred (150 ms) focus-loss re-check to hide the preview.
#[tauri::command]
fn hide_panel_command(app: tauri::AppHandle) {
    hide_panel(&app);
}

#[tauri::command]
fn get_active_clip_preview(state: tauri::State<AppState>) -> Option<PreviewPayload> {
    lock(&state.preview).clone()
}

struct Win32SequenceReader;

impl ClipboardSequenceReader for Win32SequenceReader {
    fn sequence_number(&mut self) -> u32 {
        use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;

        unsafe { GetClipboardSequenceNumber() }
    }
}

struct Win32SourceSampler;

impl ClipboardSourceSampler for Win32SourceSampler {
    /// Foreground identity at this instant. The capture policy calls this once
    /// per new clipboard sequence and freezes the result for all later ticks
    /// consuming that sequence — deferred captures and history-lock retries
    /// never re-sample here, so a focus change after a password manager's copy
    /// cannot re-attribute the content to another app.
    fn sample(&mut self) -> ClipboardSource {
        clipboard::get_foreground_info()
    }
}

struct Win32ClipboardCapturer;

impl ClipboardCapturer for Win32ClipboardCapturer {
    fn capture(&mut self, config: &AppConfig, source: &ClipboardSource) -> ClipboardCaptureOutcome {
        match clipboard::capture_clipboard(config, source) {
            Ok(clip) => ClipboardCaptureOutcome::Captured(Box::new(clip)),
            Err(clipboard::CaptureError::Locked) => ClipboardCaptureOutcome::Locked,
            // Lost renders are converted to deferred Clips inside
            // capture_clipboard; this arm is defense in depth only.
            Err(clipboard::CaptureError::LostRender) => {
                ClipboardCaptureOutcome::Skipped("lost render".to_string())
            }
            Err(clipboard::CaptureError::Skip(reason)) => ClipboardCaptureOutcome::Skipped(reason),
        }
    }
}

struct SharedCaptureHistory {
    history: Arc<Mutex<HistoryState>>,
}

impl CaptureHistory for SharedCaptureHistory {
    fn store(&mut self, request: CaptureStoreRequest) -> CaptureStoreOutcome {
        match self.history.try_lock() {
            Ok(mut history) => request.apply(&mut history),
            Err(std::sync::TryLockError::WouldBlock) => CaptureStoreOutcome::Locked,
            Err(std::sync::TryLockError::Poisoned(poisoned)) => {
                request.apply(&mut poisoned.into_inner())
            }
        }
    }
}

struct TauriCaptureEmitter {
    app: tauri::AppHandle,
}

impl CaptureEmitter for TauriCaptureEmitter {
    fn emit(&mut self, decision: CaptureDecision) {
        match decision {
            CaptureDecision::NoChange => {}
            CaptureDecision::Defer {
                pending_sequence,
                reason,
            } => {
                let _ = (pending_sequence, reason);
            }
            CaptureDecision::Skip {
                consumed_sequence,
                reason: SkipReason::Capture(reason),
            } => {
                let _ = consumed_sequence;
                log(&format!("[Mnemark] capture skipped: {}", reason));
            }
            CaptureDecision::Skip {
                consumed_sequence,
                reason,
            } => {
                let _ = (consumed_sequence, reason);
            }
            CaptureDecision::Store {
                consumed_sequence,
                update,
            } => {
                let _ = consumed_sequence;
                // Events describe an already-committed capture result; they
                // are not authoritative History state.
                let _ = self.app.emit("clipboard-update", *update);
            }
            CaptureDecision::PersistenceFailed {
                consumed_sequence,
                message,
            } => {
                let _ = consumed_sequence;
                // Keep monitoring after durable failures and make the gap
                // observable through the existing backend event contract.
                eprintln!("[Mnemark] history persistence write failed: {}", message);
                let _ = self.app.emit("history-persistence-error", &message);
            }
        }
    }
}

fn start_monitor(
    app_handle: tauri::AppHandle,
    history: Arc<Mutex<HistoryState>>,
    config: Arc<Mutex<AppConfig>>,
    monitor_running: Arc<Mutex<bool>>,
) {
    std::thread::spawn(move || {
        let self_exe = std::env::current_exe()
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
            .unwrap_or_default();
        let mut monitor = ClipboardMonitor::new(
            Win32SequenceReader,
            Win32ClipboardCapturer,
            SharedCaptureHistory { history },
            TauriCaptureEmitter { app: app_handle },
            Win32SourceSampler,
            self_exe,
        );

        loop {
            std::thread::sleep(capture_policy::POLL_INTERVAL);
            let running = *lock(&monitor_running);
            let config = lock(&config).clone();
            // A panicking iteration must not kill clipboard monitoring:
            // untrusted clipboard bytes reach the image decoders, and a dead
            // monitor thread fails silently — the user never notices history
            // has stopped. Log and keep polling.
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                monitor.tick(running, &config, now_ms())
            }))
            .is_err()
            {
                log("[Mnemark] monitor iteration panicked; clipboard watching continues");
            }
        }
    });
}

/// Debug-only log. Release builds compile to a no-op (the app has no
/// console under windows_subsystem = "windows" anyway).
fn log(msg: &str) {
    #[cfg(debug_assertions)]
    eprintln!("{}", msg);
    #[cfg(not(debug_assertions))]
    let _ = msg;
}

/// Preview window sizing/positioning constants, in logical pixels. The main
/// window is a 480x620 transparent host whose visual panel sits at logical
/// offset (30, 30) with width 420; the preview attaches beside that panel.
const PANEL_OFFSET: i32 = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WorkspaceGeometry {
    x: i32,
    y: i32,
    physical_width: u32,
    physical_height: u32,
}

fn place_workspace_window(
    current_pos: (i32, i32),
    current_left_extent: u32,
    next_left_extent: u32,
    next_right_extent: u32,
    scale: f64,
    zoom: f64,
    work_area: (i32, i32, u32, u32),
) -> WorkspaceGeometry {
    let (wx, wy, ww, wh) = work_area;
    let factor = scale * zoom;
    let history_x = current_pos.0
        + (((PANEL_OFFSET as u32 + current_left_extent) as f64) * factor).round() as i32;
    let physical_width = (((480 + next_left_extent + next_right_extent) as f64) * factor)
        .round()
        .max(1.0) as u32;
    let physical_height = (620.0 * factor).round().max(1.0) as u32;
    let desired_x =
        history_x - (((PANEL_OFFSET as u32 + next_left_extent) as f64) * factor).round() as i32;
    let max_x = wx + ww.saturating_sub(physical_width) as i32;
    let max_y = wy + wh.saturating_sub(physical_height) as i32;
    WorkspaceGeometry {
        x: desired_x.clamp(wx, max_x.max(wx)),
        y: current_pos.1.clamp(wy, max_y.max(wy)),
        physical_width: physical_width.min(ww.max(1)),
        physical_height: physical_height.min(wh.max(1)),
    }
}

fn apply_main_workspace_layout(
    left_extent: u32,
    right_extent: u32,
    app: &tauri::AppHandle,
    state: &AppState,
) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let monitor = window
        .current_monitor()
        .map_err(|e| format!("current_monitor failed: {:?}", e))?
        .ok_or_else(|| "no monitor".to_string())?;
    let position = window
        .outer_position()
        .map_err(|e| format!("main outer_position failed: {:?}", e))?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let zoom = ui_zoom_of(&lock(&state.config));
    let current_left = *lock(&state.workspace_left_extent);
    let wa = monitor.work_area();
    let geometry = place_workspace_window(
        (position.x, position.y),
        current_left,
        left_extent,
        right_extent,
        scale,
        zoom,
        (wa.position.x, wa.position.y, wa.size.width, wa.size.height),
    );
    window
        .set_size(tauri::LogicalSize::new(
            geometry.physical_width as f64 / scale,
            geometry.physical_height as f64 / scale,
        ))
        .map_err(|e| format!("main workspace set_size failed: {:?}", e))?;
    window
        .set_position(tauri::PhysicalPosition::new(geometry.x, geometry.y))
        .map_err(|e| format!("main workspace set_position failed: {:?}", e))?;
    *lock(&state.workspace_left_extent) = left_extent;
    *lock(&state.workspace_right_extent) = right_extent;
    Ok(())
}

#[tauri::command]
fn set_main_workspace_layout(
    left_extent: u32,
    right_extent: u32,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    apply_main_workspace_layout(left_extent, right_extent, &app, &state)
}

/// Pure coordinate math: compute the i32 (x, y) that centers window of
/// `win_size` inside a monitor at `mon_pos` with `mon_size`.
///
/// Safe for all inputs: intermediate i64 arithmetic prevents overflow, the
/// final i32 conversion saturates to the i32 range, and the result is clamped
/// so the window never lands above or left of the monitor origin (handles both
/// negative monitor coords and windows larger than the monitor).
fn center_coords(mon_pos: (i32, i32), mon_size: (u32, u32), win_size: (u32, u32)) -> (i32, i32) {
    let cx = mon_pos.0 as i64 + (mon_size.0 as i64 - win_size.0 as i64) / 2;
    let cy = mon_pos.1 as i64 + (mon_size.1 as i64 - win_size.1 as i64) / 2;
    let cx = cx.clamp(i32::MIN as i64, i32::MAX as i64) as i32;
    let cy = cy.clamp(i32::MIN as i64, i32::MAX as i64) as i32;
    (cx.max(mon_pos.0), cy.max(mon_pos.1))
}

fn center_history_coords(
    mon_pos: (i32, i32),
    mon_size: (u32, u32),
    win_size: (u32, u32),
    left_extent: u32,
    factor: f64,
) -> (i32, i32) {
    let history_offset = (((PANEL_OFFSET as u32 + left_extent) as f64) * factor).round() as i64;
    let history_width = (420.0 * factor).round() as i64;
    let monitor_center = mon_pos.0 as i64 + mon_size.0 as i64 / 2;
    let desired_x = monitor_center - history_width / 2 - history_offset;
    let max_x = mon_pos.0 as i64 + mon_size.0.saturating_sub(win_size.0) as i64;
    let x = desired_x.clamp(mon_pos.0 as i64, max_x.max(mon_pos.0 as i64));
    let (_, y) = center_coords(mon_pos, mon_size, win_size);
    (x.clamp(i32::MIN as i64, i32::MAX as i64) as i32, y)
}

/// Position `window` centered on the monitor that currently contains the
/// cursor. Every failure is logged and swallowed: a transient cursor/monitor
/// lookup failure must not prevent showing the panel.
fn center_on_cursor_monitor(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let cursor = match app.cursor_position() {
        Ok(p) => p,
        Err(e) => {
            log(&format!("[Mnemark] cursor_position failed: {:?}", e));
            return;
        }
    };

    let monitor = match app.monitor_from_point(cursor.x, cursor.y) {
        Ok(Some(m)) => m,
        Ok(None) => {
            log("[Mnemark] monitor_from_point returned None");
            return;
        }
        Err(e) => {
            log(&format!("[Mnemark] monitor_from_point failed: {:?}", e));
            return;
        }
    };

    let window_size = window.outer_size().unwrap_or(tauri::PhysicalSize {
        width: 480,
        height: 620,
    });

    let mon_pos = monitor.position();
    let mon_size = monitor.size();

    let state = app.state::<AppState>();
    let left_extent = *lock(&state.workspace_left_extent);
    let factor = monitor.scale_factor() * ui_zoom_of(&lock(&state.config));
    let (x, y) = center_history_coords(
        (mon_pos.x, mon_pos.y),
        (mon_size.width, mon_size.height),
        (window_size.width, window_size.height),
        left_extent,
        factor,
    );

    if let Err(e) = window.set_position(tauri::PhysicalPosition::new(x, y)) {
        log(&format!("[Mnemark] set_position failed: {:?}", e));
    }
}

fn show_panel(app: &tauri::AppHandle) {
    use tauri::{webview::PageLoadEvent, WebviewUrl, WebviewWindowBuilder};

    log("[Mnemark] show_panel() called");
    app.state::<AppState>()
        .panel_session
        .remember_paste_target();
    MAIN_MODAL_OPEN.store(false, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("main") {
        log("[Mnemark] panel exists, showing");
        let _ = window.emit("main-panel-reset", ());
        center_on_cursor_monitor(app, &window);
        let _ = window.show();
        let _ = window.set_focus();
    } else {
        log("[Mnemark] creating new panel window");
        let (panel_w, panel_h) = zoomed_builder_size(app, 480, 620);
        let first_page_load = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let first_page_load_for_callback = first_page_load.clone();
        match WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
            .title("Mnemark")
            // Window is larger than the panel (420x540) so the rounded
            // corners and CSS drop shadow have room inside a transparent frame.
            .inner_size(panel_w, panel_h)
            .decorations(false)
            .transparent(true)
            // Disable the DWM undecorated shadow: tao defaults it on, which
            // draws a 1px white border + shadow around the whole window rect
            // instead of following the rounded panel. The panel has its own
            // CSS drop shadow.
            .shadow(false)
            .resizable(false)
            .skip_taskbar(true)
            .always_on_top(true)
            // Keep the first main window hidden until its document and deferred
            // module script have loaded. Showing it immediately after build()
            // exposes clickable UI before main.ts has registered its listeners,
            // which drops a fast first click. The one-shot guard prevents a
            // later navigation/HMR reload from resurfacing a hidden panel.
            .on_page_load(move |window, payload| {
                if matches!(payload.event(), PageLoadEvent::Finished)
                    && first_page_load_for_callback.swap(false, std::sync::atomic::Ordering::SeqCst)
                {
                    let app = window.app_handle();
                    center_on_cursor_monitor(app, &window);
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            })
            .visible(false)
            .focused(false)
            .build()
        {
            Ok(w) => {
                log(&format!("[Mnemark] panel created: {:?}", w.label()));
                let _ = w.set_zoom(ui_zoom_of(&lock(&app.state::<AppState>().config)));
                center_on_cursor_monitor(app, &w);
                // Click outside (focus loss) dismisses the Panel. The handler
                // is armed only after the window has gained focus once (with a
                // grace-period backstop), so a transient focus bounce during
                // creation doesn't immediately dismiss the Panel.
                let app_handle = app.clone();
                w.on_window_event(move |event| {
                    match event {
                        tauri::WindowEvent::Focused(true) => {
                            app_handle
                                .state::<AppState>()
                                .panel_session
                                .focus_changed(true);
                        }
                        tauri::WindowEvent::Focused(false) => {
                            if app_handle
                                .state::<AppState>()
                                .panel_session
                                .focus_changed(false)
                            {
                                schedule_focus_group_check(&app_handle);
                            }
                        }
                        tauri::WindowEvent::Destroyed => {
                            // A destroyed main window must not strand a visible
                            // preview.
                            hide_preview_window(&app_handle);
                        }
                        _ => {}
                    }
                });
                // Backstop: arm even if the initial focus event never arrives.
                let app_handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let should_recheck = app_handle
                        .state::<AppState>()
                        .panel_session
                        .arm_after_backstop()
                        .await;
                    if should_recheck {
                        schedule_focus_group_check(&app_handle);
                    }
                });
            }
            Err(e) => {
                log(&format!("[Mnemark] panel creation failed: {:?}", e));
            }
        }
    }
}

fn hide_panel(app: &tauri::AppHandle) {
    MAIN_MODAL_OPEN.store(false, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("main-panel-reset", ());
        let _ = window.hide();
    }
}

#[tauri::command]
fn set_main_modal_open(open: bool, app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    // Reassert topmost when editing begins. Windows can otherwise reorder a
    // long-lived tool window after activation changes from other applications.
    window
        .set_always_on_top(true)
        .map_err(|e| format!("set_always_on_top failed: {e:?}"))?;
    MAIN_MODAL_OPEN.store(open, Ordering::SeqCst);
    if open {
        window
            .set_focus()
            .map_err(|e| format!("set_focus failed: {e:?}"))?;
    }
    Ok(())
}

/// Clear the inline preview payload and supersede any in-flight show.
fn hide_preview_window(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    state.panel_session.release_preview();
    *lock(&state.preview) = None;
}

/// Delay the main-window focus check so transient Windows activation changes
/// do not dismiss the panel during the same event turn.
fn schedule_focus_group_check(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        app.state::<AppState>()
            .panel_session
            .wait_for_focus_recheck()
            .await;
        let handle = app.clone();
        if let Err(e) = app.run_on_main_thread(move || {
            let focused = handle
                .get_webview_window("main")
                .and_then(|w| w.is_focused().ok())
                .unwrap_or(false);
            let modal_open = MAIN_MODAL_OPEN.load(Ordering::SeqCst);
            if handle
                .state::<AppState>()
                .panel_session
                .should_dismiss(focused, modal_open)
            {
                hide_panel(&handle);
            }
        }) {
            log(&format!("[Mnemark] run_on_main_thread failed: {:?}", e));
        }
    });
}

/// UI zoom factor derived from the config percentage.
fn ui_zoom_of(config: &AppConfig) -> f64 {
    config.ui_scale_percent as f64 / 100.0
}

/// Base logical window size at zoom = 100% for each scalable window.
fn base_window_size(label: &str) -> Option<(u32, u32)> {
    match label {
        "main" => Some((480, 620)),
        "settings" => Some((500, 700)),
        "about" => Some((440, 540)),
        "tutorial" => Some((500, 600)),
        _ => None,
    }
}

/// Pure math: base logical size × zoom, clamped to a logical upper bound
/// with a 1px floor. Unit-testable.
fn zoomed_logical_size(w: u32, h: u32, zoom: f64, max_w: u32, max_h: u32) -> (f64, f64) {
    let w = (w as f64 * zoom).min(max_w as f64).max(1.0);
    let h = (h as f64 * zoom).min(max_h as f64).max(1.0);
    (w, h)
}

/// Logical work-area size of a monitor (physical size / scale factor).
fn logical_work_area(monitor: &tauri::Monitor) -> (u32, u32) {
    let wa = monitor.work_area();
    let s = monitor.scale_factor();
    (
        (wa.size.width as f64 / s) as u32,
        (wa.size.height as f64 / s) as u32,
    )
}

/// Builder-stage size for a new window: base size scaled by the configured
/// zoom, clamped to the primary monitor's work area (the window does not
/// exist yet, so its own monitor is unknown).
fn zoomed_builder_size(app: &tauri::AppHandle, w: u32, h: u32) -> (f64, f64) {
    let zoom = ui_zoom_of(&lock(&app.state::<AppState>().config));
    let (max_w, max_h) = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| logical_work_area(&m))
        .unwrap_or((u32::MAX, u32::MAX));
    zoomed_logical_size(w, h, zoom, max_w, max_h)
}

/// Apply the webview zoom and matching logical size to one window. Both the
/// CSS content and the window scale together, so the transparent-frame
/// margins (e.g. main's 30px shadow gutter) stay proportional.
fn apply_window_zoom(window: &tauri::WebviewWindow, zoom: f64) {
    let Some((w, h)) = base_window_size(window.label()) else {
        return;
    };
    let (max_w, max_h) = window
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| logical_work_area(&m))
        .unwrap_or((u32::MAX, u32::MAX));
    let (zw, zh) = zoomed_logical_size(w, h, zoom, max_w, max_h);
    let _ = window.set_zoom(zoom);
    let _ = window.set_size(tauri::LogicalSize::new(zw, zh));
}

/// Re-apply the configured UI scale to every live scalable window.
fn apply_ui_scale(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let zoom = ui_zoom_of(&lock(&state.config));
    for (label, window) in app.webview_windows() {
        if label == "main" {
            let _ = window.set_zoom(zoom);
            let state = app.state::<AppState>();
            let left = *lock(&state.workspace_left_extent);
            let right = *lock(&state.workspace_right_extent);
            let _ = apply_main_workspace_layout(left, right, app, &state);
            continue;
        }
        if base_window_size(&label).is_none() {
            continue;
        }
        apply_window_zoom(&window, zoom);
    }
}

fn tutorial_needed(version: u32) -> bool {
    version < CURRENT_TUTORIAL_VERSION
}

fn toggle_panel(app: &tauri::AppHandle) {
    let visible = app
        .get_webview_window("main")
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false);
    if visible {
        hide_panel(app);
    } else {
        show_panel(app);
    }
}

/// Register the global hotkey that toggles the Panel.
/// Returns Err if the combination is invalid or already owned by another app.
fn register_panel_hotkey(app: &tauri::AppHandle, hotkey_str: &str) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let shortcut = hotkey_str
        .parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map_err(|e| format!("Invalid hotkey '{}': {}", hotkey_str, e))?;
    let handle = app.clone();
    app.global_shortcut()
        .on_shortcut(shortcut, move |_app, _sc, event| {
            if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                toggle_panel(&handle);
            }
        })
        .map_err(|e| format!("Hotkey '{}' is already in use: {}", hotkey_str, e))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(_hidden: bool) {
    update::cleanup_stale_portable_update();
    // One-time migration of legacy ClipFlow data (config/db/shortcut) into the
    // Mnemark identity. Runs before config load / persistence open so the first
    // launch reads the migrated files. Errors preserve the legacy data and are
    // surfaced through the existing startup-error UI, never silently dropped.
    let migration_error = migration::migrate_legacy_data().err();
    let mut config = AppConfig::load();
    // Self-heal an invalid favorites chord from a hand-edited config: fall back
    // to the default rather than carrying a malformed shortcut into the UI.
    if config.favorites_toggle_shortcut.validate().is_err() {
        config.favorites_toggle_shortcut = PanelShortcut::default();
    }
    // History aggregate startup: optional SQLite persistence is loaded,
    // reconciled (72h stale-row policy) and installed inside the module. Any
    // failure degrades to memory-only operation with the existing
    // diagnostics — the app still starts.
    let (history_state, startup_diagnostics) = HistoryState::bootstrap(
        &config,
        now_ms(),
        persistence::db_exists(),
        Persistence::open,
    );
    for diagnostic in &startup_diagnostics {
        log(&format!("[Mnemark] {diagnostic}"));
    }

    // Favorites are always persisted, independent of the history `persist`
    // toggle: open the favorites store (its own tables in mnemark.db).
    let favorites = match FavoritesStore::open() {
        Ok(f) => Some(f),
        Err(e) => {
            log(&format!("[Mnemark] failed to open favorites store: {}", e));
            None
        }
    };

    let history = Arc::new(Mutex::new(history_state));
    let config_store = Arc::new(Mutex::new(config.clone()));
    let monitor_running = Arc::new(Mutex::new(true));
    let drawer = Arc::new(Mutex::new(DrawerState::new(favorites)));
    let tray_items = Arc::new(Mutex::new(None));
    let startup_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(migration_error));

    log("[Mnemark] run() called");

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState {
            history: history.clone(),
            config: config_store.clone(),
            monitor_running: monitor_running.clone(),
            tray_items: tray_items.clone(),
            startup_error: startup_error.clone(),
            preview: Arc::new(Mutex::new(None)),
            panel_session: PanelSession::new(
                SystemPanelClock::default(),
                SystemForegroundWindowSource,
            ),
            drawer: drawer.clone(),
            workspace_left_extent: Arc::new(Mutex::new(0)),
            workspace_right_extent: Arc::new(Mutex::new(0)),
        })
        .setup(move |app| {
            let resource_dir = app.path().resource_dir().unwrap_or_default();
            log(&format!("[Mnemark] resource_dir: {:?}", resource_dir));
            log("[Mnemark] setup closure entered");
            let handle = app.handle().clone();

            log("[Mnemark] registering hotkey");
            // Register global hotkey
            let hotkey_str = {
                let config = lock(&config_store);
                config.hotkey.clone()
            };

            if let Err(e) = register_panel_hotkey(&handle, &hotkey_str) {
                log(&format!("[Mnemark] hotkey registration failed: {}", e));
                // Per spec: on conflict, open Settings so the user picks
                // another combination — with the reason shown inline.
                *lock(&startup_error) = Some(e);
            }

            // Surface any startup error — a failed legacy migration or a hotkey
            // conflict — inline in Settings (see take_startup_error).
            if lock(&startup_error).is_some() {
                let _ = open_settings_window(&handle);
            }

            // Debug-only shortcut to force-show the Panel. Never registered
            // in release builds: a global Ctrl+Shift+I would steal the
            // devtools key from browsers and IDEs system-wide.
            #[cfg(debug_assertions)]
            {
                let handle_debug = handle.clone();
                if let Ok(debug_sc) =
                    "Ctrl+Shift+I".parse::<tauri_plugin_global_shortcut::Shortcut>()
                {
                    use tauri_plugin_global_shortcut::GlobalShortcutExt;
                    let _ = app
                        .global_shortcut()
                        .on_shortcut(debug_sc, move |_app, _sc, event| {
                            if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                                show_panel(&handle_debug);
                            }
                        });
                }
            }

            log("[Mnemark] hotkey registered, starting tray setup");
            // Start clipboard monitor
            start_monitor(
                handle.clone(),
                history.clone(),
                config_store.clone(),
                monitor_running.clone(),
            );

            // Background auto-update check (installed builds only, and only
            // when auto_update is on — portable builds never touch the updater).
            update::spawn_auto_update_check(handle.clone(), config_store.clone());

            // Build tray (programmatic only — no trayIcon in config)
            use tauri::menu::{MenuBuilder, MenuItemBuilder};
            use tauri::tray::TrayIconBuilder;

            let tray_lang = lock(&config_store).language.clone();
            let labels = tray_labels(&tray_lang);

            let pause_item = MenuItemBuilder::with_id("pause", labels.pause).build(app)?;
            let settings_item = MenuItemBuilder::with_id("settings", labels.settings).build(app)?;
            let tutorial_item = MenuItemBuilder::with_id("tutorial", labels.tutorial).build(app)?;
            let about_item = MenuItemBuilder::with_id("about", labels.about).build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", labels.quit).build(app)?;

            let menu = MenuBuilder::new(app)
                .item(&pause_item)
                .item(&settings_item)
                .item(&tutorial_item)
                .separator()
                .item(&about_item)
                .item(&quit_item)
                .build()?;

            let icon = app.default_window_icon().cloned().unwrap();
            let pause_item_handle = pause_item.clone();

            let _tray = TrayIconBuilder::new()
                .icon(icon)
                .tooltip(format!("Mnemark v{}", env!("CARGO_PKG_VERSION")))
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "pause" => {
                        let state = app.state::<AppState>();
                        let mut running = lock(&state.monitor_running);
                        *running = !*running;
                        let lang = lock(&state.config).language.clone();
                        let labels = tray_labels(&lang);
                        let _ = pause_item_handle.set_text(if *running {
                            labels.pause
                        } else {
                            labels.resume
                        });
                    }
                    "settings" => {
                        let _ = open_settings_window(app);
                    }
                    "tutorial" => {
                        let _ = open_tutorial_window(app);
                    }
                    "about" => {
                        let _ = open_about_dialog(app);
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;
            log("[Mnemark] tray built successfully");

            // Keep item handles so labels can be re-localized on language change.
            *lock(&tray_items) = Some(TrayMenuItems {
                pause: pause_item.clone(),
                settings: settings_item.clone(),
                tutorial: tutorial_item.clone(),
                about: about_item.clone(),
                quit: quit_item.clone(),
            });

            // Auto-open the tutorial once (deferred while any startup/migration
            // error is present, so it never stacks on top of the Settings error).
            if lock(&startup_error).is_none()
                && tutorial_needed(lock(&config_store).tutorial_version)
            {
                let _ = open_tutorial_window(&handle);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_clips,
            delete_clip,
            delete_clips,
            undo_delete,
            undo_delete_batch,
            set_pinned,
            set_located_clip_note,
            get_config,
            take_startup_error,
            update_config,
            paste_located_clip,
            copy_located_clip,
            show_located_clip_preview,
            hide_clip_preview,
            hide_panel_command,
            set_main_modal_open,
            get_active_clip_preview,
            get_drawer_view,
            create_collection,
            rename_collection,
            delete_collection,
            reorder_collections,
            reorder_favorite_items,
            add_favorite,
            add_favorites,
            remove_favorite,
            remove_favorites,
            favorite_collection_ids,
            set_favorites_open,
            toggle_favorites_sidebar,
            set_favorites_selected,
            set_main_workspace_layout,
            complete_tutorial,
            show_panel_command,
            update::update_channel,
            update::check_for_updates,
            update::install_update,
            update::restart_app,
            update::download_portable_update,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            // Tray app: closing the last window only returns to the
            // background — never exits. Quit is explicit via the tray menu
            // (app.exit bypasses this handler).
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}

fn open_settings_window(app: &tauri::AppHandle) -> Result<(), tauri::Error> {
    use tauri::WebviewUrl;
    use tauri::WebviewWindowBuilder;

    log("[Mnemark] open_settings_window() called");
    if let Some(window) = app.get_webview_window("settings") {
        if window.is_visible().unwrap_or(false) {
            log("[Mnemark] settings exists, focusing");
            window.set_focus()?;
            return Ok(());
        }
        log("[Mnemark] settings exists, showing");
        let _ = window.center();
        window.show()?;
        window.set_focus()?;
        // Tell the (reused) frontend this is a fresh session so it reloads
        // the saved config and clears dirty/recording state.
        let _ = app.emit("settings-reopened", ());
        return Ok(());
    }

    log("[Mnemark] creating settings window");
    let (settings_w, settings_h) = zoomed_builder_size(app, 500, 700);
    let w = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title("Mnemark Settings")
        .inner_size(settings_w, settings_h)
        .resizable(false)
        .visible(true)
        .center()
        .build()?;
    let _ = w.set_zoom(ui_zoom_of(&lock(&app.state::<AppState>().config)));

    let app_handle = app.clone();
    w.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            // Never destroy: hide instead, so repeated open/close does not
            // rebuild the WebView each time (a long-running risk on Windows).
            // Save/Cancel/Escape/title-bar all route through CloseRequested.
            api.prevent_close();
            if let Some(window) = app_handle.get_webview_window("settings") {
                let _ = window.hide();
            }
        }
    });

    log("[Mnemark] settings window created");
    Ok(())
}

fn open_about_dialog(app: &tauri::AppHandle) -> Result<(), tauri::Error> {
    use tauri::WebviewUrl;
    use tauri::WebviewWindowBuilder;

    if let Some(window) = app.get_webview_window("about") {
        window.set_focus()?;
        return Ok(());
    }

    let (about_w, about_h) = zoomed_builder_size(app, 440, 540);
    let w = WebviewWindowBuilder::new(app, "about", WebviewUrl::App("about.html".into()))
        .title("About Mnemark")
        .inner_size(about_w, about_h)
        .resizable(false)
        .center()
        .build()?;
    let _ = w.set_zoom(ui_zoom_of(&lock(&app.state::<AppState>().config)));

    Ok(())
}

// === Tutorial ===

/// Mark the tutorial as seen (idempotent): bump the stored version and save.
fn mark_tutorial_seen(state: &AppState) -> Result<(), String> {
    let mut config = lock(&state.config);
    if config.tutorial_version < CURRENT_TUTORIAL_VERSION {
        config.tutorial_version = CURRENT_TUTORIAL_VERSION;
        config.save()
    } else {
        Ok(())
    }
}

/// Open (or focus) the tutorial window. Closing it by any means marks the
/// version seen — so the window's own close button counts as "skip" — but hides
/// instead of destroying so a first-run portable launch keeps its last window.
fn open_tutorial_window(app: &tauri::AppHandle) -> Result<(), tauri::Error> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    if let Some(window) = app.get_webview_window("tutorial") {
        if window.is_visible().unwrap_or(false) {
            window.set_focus()?;
        } else {
            // A hidden window needs show+center+focus; set_focus alone is a
            // no-op on it.
            let _ = window.center();
            let _ = window.show();
            window.set_focus()?;
            // Tell the (reused) frontend this is a fresh session so it can
            // re-arm Skip/Start and restart from the first page.
            let _ = app.emit("tutorial-reopened", ());
        }
        return Ok(());
    }

    let (tutorial_w, tutorial_h) = zoomed_builder_size(app, 500, 600);
    let w = WebviewWindowBuilder::new(app, "tutorial", WebviewUrl::App("tutorial.html".into()))
        .title("Mnemark Tutorial")
        .inner_size(tutorial_w, tutorial_h)
        .resizable(false)
        .center()
        .build()?;
    let _ = w.set_zoom(ui_zoom_of(&lock(&app.state::<AppState>().config)));

    let app_handle = app.clone();
    w.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            // Never destroy: mark seen and hide, so the tutorial being the last
            // window does not close it and wedge the tray. `app.exit(0)` still
            // exits — it bypasses per-window CloseRequested.
            api.prevent_close();
            let state = app_handle.state::<AppState>();
            let _ = mark_tutorial_seen(&state);
            if let Some(window) = app_handle.get_webview_window("tutorial") {
                let _ = window.hide();
            }
        }
    });
    Ok(())
}

/// The single main-thread action that completes the tutorial. Both flags live
/// in one value so the executor runs the hide and (for Start) the panel reopen
/// together on the main thread — never a bare `show_panel` on the IPC thread,
/// whose first-run window creation would deadlock the event loop.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
struct CompleteTutorialAction {
    hide_tutorial: bool,
    open_history: bool,
}

/// Execute the completion's window mutations. Must only run on the Tauri main
/// thread (the caller dispatches via `run_on_main_thread`): `show_panel` first
/// creates the "main" window, which cannot be built off-thread. Idempotent — a
/// duplicate Start hides an already-hidden tutorial and reuses the existing
/// panel window, so a double-click never creates a second window or wedges.
fn apply_complete_tutorial_on_main_thread(
    app: &tauri::AppHandle,
    action: CompleteTutorialAction,
) -> Result<(), String> {
    if action.hide_tutorial {
        if let Some(w) = app.get_webview_window("tutorial") {
            w.hide()
                .map_err(|e| format!("tutorial hide failed: {:?}", e))?;
        }
    }
    if action.open_history {
        show_panel(app);
    }
    Ok(())
}

/// Tutorial close/skip/finish. `open_history` is true for "finish" — it opens
/// the history panel after marking the version seen. All window hide/show/create
/// work is dispatched to the Tauri main thread; only the version save runs on
/// the IPC thread, and no config lock is held across that dispatch.
#[tauri::command]
async fn complete_tutorial(
    app: tauri::AppHandle,
    open_history: bool,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    // Hide and (optionally) open history even if the save fails; report the
    // save error so a disk failure retries on next launch instead of being
    // silently swallowed.
    let save_result = mark_tutorial_seen(&state);
    // Start (`open_history`) must carry the reopen in the SAME action as the
    // hide, not as a second dispatch.
    let action = CompleteTutorialAction {
        hide_tutorial: true,
        open_history,
    };

    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(apply_complete_tutorial_on_main_thread(&handle, action));
    })
    .map_err(|e| format!("run_on_main_thread failed: {:?}", e))?;

    let window_result = rx
        .await
        .map_err(|_| "tutorial completion channel closed".to_string())?;

    window_result?;
    save_result
}

/// Expose the panel show primitive so the tutorial (or any other surface) can
/// open/restore the history panel.
#[tauri::command]
fn show_panel_command(app: tauri::AppHandle) {
    show_panel(&app);
}

#[cfg(test)]
mod shell_open_scope_tests {
    /// tauri-plugin-shell compiles plugins.shell.open at startup wrapped as
    /// ^{pattern}$ and panics on an invalid regex — guard the config here.
    #[test]
    fn shell_open_regex_compiles_and_scopes_correctly() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let pattern = conf["plugins"]["shell"]["open"]
            .as_str()
            .expect("plugins.shell.open must be set");
        let re = regex::Regex::new(&format!("^{pattern}$")).unwrap();

        // About-page links and the open-folder button must keep working.
        assert!(re.is_match("https://github.com/LiuTouo/Mnemark"));
        assert!(re.is_match("C:\\Users\\me\\AppData\\Local\\Mnemark"));
        assert!(re.is_match("D:/portable/Mnemark"));

        // Everything else must be rejected by the webview surface.
        for bad in [
            "http://github.com/x",
            "javascript:alert(1)",
            "file:///C:/Windows",
            "mailto:a@b.c",
            "\\\\server\\share\\x",
        ] {
            assert!(!re.is_match(bad), "should reject: {bad}");
        }
    }
}

#[cfg(test)]
mod monitor_clock_tests {
    #[test]
    fn now_ms_never_panics_and_returns_epoch_scale() {
        // The monitor's clock: a pre-epoch system clock maps to 0 (fallback)
        // instead of panicking inside duration_since().unwrap(), which would
        // kill the monitor thread. On any real test machine this is ~2026.
        let now = super::now_ms();
        assert!(now > 1_000_000_000_000, "now_ms should be post-2001 ms");
    }
}

#[cfg(test)]
mod ui_scale_tests {
    use super::zoomed_logical_size;

    #[test]
    fn zoom_multiplies_base_size() {
        let (w, h) = zoomed_logical_size(480, 620, 1.5, u32::MAX, u32::MAX);
        assert_eq!(w, 720.0);
        assert_eq!(h, 930.0);
    }

    #[test]
    fn zoom_clamps_to_work_area() {
        let (w, h) = zoomed_logical_size(500, 700, 1.5, 600, 800);
        assert_eq!(w, 600.0);
        assert_eq!(h, 800.0);
    }

    #[test]
    fn zoom_floors_at_one_pixel() {
        let (w, h) = zoomed_logical_size(0, 0, 1.0, 100, 100);
        assert_eq!(w, 1.0);
        assert_eq!(h, 1.0);
    }
}

#[cfg(test)]
mod center_coords_tests {
    use super::{center_coords, center_history_coords};

    #[test]
    fn center_on_positive_monitor() {
        let (x, y) = center_coords((0, 0), (1920, 1080), (480, 620));
        assert_eq!(x, 720);
        assert_eq!(y, 230);
    }

    #[test]
    fn center_on_negative_monitor_origin() {
        let (x, y) = center_coords((-1920, 0), (1920, 1080), (480, 620));
        assert_eq!(x, -1200);
        assert_eq!(y, 230);
    }

    #[test]
    fn expanded_workspace_centers_the_history_column() {
        let (x, y) = center_history_coords((0, 0), (1920, 1080), (1216, 620), 368, 1.0);
        assert_eq!(x + 30 + 368 + 210, 960);
        assert_eq!(y, 230);
    }

    #[test]
    fn window_larger_than_monitor_clamps_to_origin() {
        let (x, y) = center_coords((0, 0), (800, 600), (1024, 768));
        assert_eq!(x, 0);
        assert_eq!(y, 0);
    }

    #[test]
    fn odd_dimensions_truncate_correctly() {
        let (x, y) = center_coords((0, 0), (1921, 1079), (480, 620));
        assert_eq!(x, 720);
        assert_eq!(y, 229);
    }

    #[test]
    fn negative_monitor_with_window_larger_clamps() {
        let (x, y) = center_coords((-500, -300), (640, 480), (800, 600));
        assert_eq!(x, -500);
        assert_eq!(y, -300);
    }

    #[test]
    fn extreme_monitor_position_saturates_to_i32_range() {
        // i64 center would overflow i32 — the saturating clamp keeps it in range.
        let (x, y) = center_coords((i32::MAX - 100, i32::MIN + 100), (2000, 2000), (480, 620));
        // x: center adds (2000-480)/2=760, overflows i32 → saturates at i32::MAX.
        assert_eq!(x, i32::MAX);
        // y: center adds (2000-620)/2=690 → i32::MIN+100+690 = i32::MIN+790, fits.
        assert_eq!(y, i32::MIN + 790);
        // Neither wrapped.
        assert!(x >= i32::MAX - 100);
        assert!(y > i32::MIN);
        assert!(y <= i32::MIN + 1000);
    }
}

#[cfg(test)]
mod workspace_placement_tests {
    use super::place_workspace_window;

    #[test]
    fn left_pane_keeps_history_anchor_when_space_allows() {
        let p = place_workspace_window((500, 100), 0, 368, 0, 1.0, 1.0, (0, 0, 1920, 1080));
        assert_eq!(p.x, 132);
        assert_eq!(p.x + 30 + 368, 530);
        assert_eq!(p.physical_width, 848);
    }

    #[test]
    fn full_workspace_uses_both_extents() {
        let p = place_workspace_window((700, 100), 0, 368, 368, 1.0, 1.0, (0, 0, 1920, 1080));
        assert_eq!(p.physical_width, 1216);
        assert_eq!(p.physical_height, 620);
    }

    #[test]
    fn workspace_clamps_into_negative_monitor_work_area() {
        let p = place_workspace_window((-1900, 100), 0, 368, 368, 1.0, 1.0, (-1920, 0, 1920, 1080));
        assert!(p.x >= -1920);
        assert!(p.x + p.physical_width as i32 <= 0);
    }

    #[test]
    fn dpi_and_ui_zoom_scale_workspace_once_each() {
        let p = place_workspace_window((500, 100), 0, 0, 368, 1.5, 1.25, (0, 0, 2560, 1440));
        assert_eq!(p.physical_width, (848.0_f64 * 1.5 * 1.25).round() as u32);
        assert_eq!(p.physical_height, (620.0_f64 * 1.5 * 1.25).round() as u32);
    }
}

#[cfg(test)]
mod tutorial_tests {
    use super::tutorial_needed;

    #[test]
    fn unseen_tutorial_is_needed() {
        assert!(tutorial_needed(0));
    }

    #[test]
    fn current_tutorial_is_not_needed() {
        assert!(!tutorial_needed(super::CURRENT_TUTORIAL_VERSION));
    }
}
