//! Clipboard capture policy and its injectable monitor seam.
//!
//! The policy owns sequence consumption and per-observation decisions. The
//! production shell supplies Win32 capture, History locking and Tauri event
//! adapters; tests supply in-memory fakes through the same interface.

use crate::history_state::HistoryState;
use crate::models::{AppConfig, Clip, ClipboardSource, ClipboardUpdate};

pub(crate) const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(200);

pub(crate) enum ClipboardCaptureOutcome {
    Captured(Box<Clip>),
    Locked,
    Skipped(String),
}

pub(crate) struct CaptureStoreRequest {
    clip: Clip,
    self_exe: String,
}

pub(crate) enum CaptureStoreOutcome {
    Stored(Box<ClipboardUpdate>),
    Locked,
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DeferReason {
    Debounce,
    ClipboardLocked,
    HistoryLocked,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SkipReason {
    Paused,
    Capture(String),
    DoubleCopy,
}

pub(crate) enum CaptureDecision {
    NoChange,
    Defer {
        pending_sequence: u32,
        reason: DeferReason,
    },
    Skip {
        consumed_sequence: u32,
        reason: SkipReason,
    },
    Store {
        consumed_sequence: u32,
        update: Box<ClipboardUpdate>,
    },
    PersistenceFailed {
        consumed_sequence: u32,
        message: String,
    },
}

pub(crate) trait ClipboardSequenceReader {
    fn sequence_number(&mut self) -> u32;
}

pub(crate) trait ClipboardCapturer {
    /// Capture the clipboard content attributed to `source` — the sample the
    /// policy froze at first observation, never a fresh foreground read.
    fn capture(&mut self, config: &AppConfig, source: &ClipboardSource) -> ClipboardCaptureOutcome;
}

/// Foreground source sampler. Called by the policy exactly once per new
/// clipboard sequence; the returned sample is frozen into the pending
/// observation, so a focus change after the copy can never re-attribute the
/// content on a deferred tick or history-lock retry. `None` means the source
/// could not be determined with confidence.
pub(crate) trait ClipboardSourceSampler {
    fn sample(&mut self) -> Option<ClipboardSource>;
}

pub(crate) trait CaptureHistory {
    fn store(&mut self, request: CaptureStoreRequest) -> CaptureStoreOutcome;
}

pub(crate) trait CaptureEmitter {
    fn emit(&mut self, decision: CaptureDecision);
}

struct PreviousCapture {
    content_hash: String,
    observed_at: u64,
}

struct PendingObservation {
    sequence: u32,
    first_seen_at: u64,
    /// Source frozen at first observation; reused verbatim by every later
    /// tick that consumes this sequence.
    source: ClipboardSource,
}

struct CapturePolicy {
    last_sequence: u32,
    previous_capture: Option<PreviousCapture>,
    pending_observation: Option<PendingObservation>,
    self_exe: String,
}

struct CaptureObservation<'a> {
    sequence: u32,
    running: bool,
    observed_at: u64,
    config: &'a AppConfig,
}

impl CapturePolicy {
    fn consume<C, H, S>(
        &mut self,
        observation: CaptureObservation<'_>,
        capturer: &mut C,
        history: &mut H,
        sampler: &mut S,
    ) -> CaptureDecision
    where
        C: ClipboardCapturer,
        H: CaptureHistory,
        S: ClipboardSourceSampler,
    {
        let sequence = observation.sequence;
        if !observation.running {
            self.consume_sequence(sequence);
            return CaptureDecision::Skip {
                consumed_sequence: sequence,
                reason: SkipReason::Paused,
            };
        }
        if sequence == self.last_sequence {
            return CaptureDecision::NoChange;
        }

        let (first_seen_at, source) = match &self.pending_observation {
            Some(pending) if pending.sequence == sequence => {
                (pending.first_seen_at, pending.source.clone())
            }
            _ => {
                // Conservative policy for an undeterminable source: it could
                // be an excluded app that lost its window mid-copy — skip the
                // sequence instead of storing under a guess. Never re-sampled.
                let Some(source) = sampler.sample() else {
                    self.consume_sequence(sequence);
                    return CaptureDecision::Skip {
                        consumed_sequence: sequence,
                        reason: SkipReason::Capture("Source could not be determined".to_string()),
                    };
                };
                // Freeze the source at first observation: deferred ticks and
                // lock retries reuse this sample instead of re-sampling the
                // foreground, which by then may name a different app.
                self.pending_observation = Some(PendingObservation {
                    sequence,
                    first_seen_at: observation.observed_at,
                    source: source.clone(),
                });
                (observation.observed_at, source)
            }
        };

        if let Some(previous) = &self.previous_capture {
            if within_debounce(
                observation.observed_at,
                previous.observed_at,
                observation.config.debounce_ms,
            ) {
                return CaptureDecision::Defer {
                    pending_sequence: sequence,
                    reason: DeferReason::Debounce,
                };
            }
        }

        match capturer.capture(observation.config, &source) {
            ClipboardCaptureOutcome::Captured(clip) => {
                let clip = *clip;
                let content_hash = clip.content_hash.clone();
                if is_double_copy(
                    &content_hash,
                    first_seen_at,
                    self.previous_capture.as_ref(),
                    observation.config.debounce_ms,
                ) {
                    self.consume_sequence(sequence);
                    return CaptureDecision::Skip {
                        consumed_sequence: sequence,
                        reason: SkipReason::DoubleCopy,
                    };
                }

                match history.store(CaptureStoreRequest {
                    clip,
                    self_exe: self.self_exe.clone(),
                }) {
                    CaptureStoreOutcome::Stored(update) => {
                        self.finish_capture(sequence, content_hash, observation.observed_at);
                        CaptureDecision::Store {
                            consumed_sequence: sequence,
                            update,
                        }
                    }
                    CaptureStoreOutcome::Locked => CaptureDecision::Defer {
                        pending_sequence: sequence,
                        reason: DeferReason::HistoryLocked,
                    },
                    CaptureStoreOutcome::Failed(message) => {
                        self.finish_capture(sequence, content_hash, observation.observed_at);
                        CaptureDecision::PersistenceFailed {
                            consumed_sequence: sequence,
                            message,
                        }
                    }
                }
            }
            ClipboardCaptureOutcome::Locked => CaptureDecision::Defer {
                pending_sequence: sequence,
                reason: DeferReason::ClipboardLocked,
            },
            ClipboardCaptureOutcome::Skipped(reason) => {
                self.consume_sequence(sequence);
                CaptureDecision::Skip {
                    consumed_sequence: sequence,
                    reason: SkipReason::Capture(reason),
                }
            }
        }
    }

    fn consume_sequence(&mut self, sequence: u32) {
        self.last_sequence = sequence;
        self.pending_observation = None;
    }

    fn finish_capture(&mut self, sequence: u32, content_hash: String, observed_at: u64) {
        self.consume_sequence(sequence);
        self.previous_capture = Some(PreviousCapture {
            content_hash,
            observed_at,
        });
    }
}

fn within_debounce(now: u64, last_capture_ts: u64, debounce_ms: u64) -> bool {
    now.saturating_sub(last_capture_ts) < debounce_ms
}

fn is_double_copy(
    hash: &str,
    first_seen_at: u64,
    previous_capture: Option<&PreviousCapture>,
    debounce_ms: u64,
) -> bool {
    matches!(previous_capture, Some(previous)
        if previous.content_hash == hash
            && within_debounce(first_seen_at, previous.observed_at, debounce_ms))
}

pub(crate) struct ClipboardMonitor<R, C, H, E, S> {
    sequence_reader: R,
    capturer: C,
    history: H,
    emitter: E,
    source_sampler: S,
    policy: CapturePolicy,
}

impl<R, C, H, E, S> ClipboardMonitor<R, C, H, E, S>
where
    R: ClipboardSequenceReader,
    C: ClipboardCapturer,
    H: CaptureHistory,
    E: CaptureEmitter,
    S: ClipboardSourceSampler,
{
    pub(crate) fn new(
        sequence_reader: R,
        capturer: C,
        history: H,
        emitter: E,
        source_sampler: S,
        self_exe: String,
    ) -> Self {
        Self {
            sequence_reader,
            capturer,
            history,
            emitter,
            source_sampler,
            policy: CapturePolicy {
                last_sequence: 0,
                previous_capture: None,
                pending_observation: None,
                self_exe,
            },
        }
    }

    pub(crate) fn tick(&mut self, running: bool, config: &AppConfig, observed_at: u64) {
        let sequence = self.sequence_reader.sequence_number();
        let decision = self.policy.consume(
            CaptureObservation {
                sequence,
                running,
                observed_at,
                config,
            },
            &mut self.capturer,
            &mut self.history,
            &mut self.source_sampler,
        );
        self.emitter.emit(decision);
    }
}

impl CaptureStoreRequest {
    pub(crate) fn apply(self, history: &mut HistoryState) -> CaptureStoreOutcome {
        let mut clip = self.clip;
        if !self.self_exe.is_empty() && clip.source_exe.eq_ignore_ascii_case(&self.self_exe) {
            if let Some((source_exe, source_title)) = history.source_by_hash(&clip.content_hash) {
                clip.source_exe = source_exe;
                clip.source_title = source_title;
            }
        }
        match history.capture(clip) {
            Ok((clip, evicted)) => {
                CaptureStoreOutcome::Stored(Box::new(ClipboardUpdate { clip, evicted }))
            }
            Err(error) => CaptureStoreOutcome::Failed(error.message()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::HistoryPolicy;
    use crate::models::ClipKind;

    struct FakeSequenceReader {
        sequence: u32,
    }

    impl ClipboardSequenceReader for FakeSequenceReader {
        fn sequence_number(&mut self) -> u32 {
            self.sequence
        }
    }

    #[derive(Default)]
    struct FakeCapturer {
        calls: usize,
        sources_seen: Vec<ClipboardSource>,
        results: Vec<ClipboardCaptureOutcome>,
    }

    impl ClipboardCapturer for FakeCapturer {
        fn capture(
            &mut self,
            _config: &AppConfig,
            source: &ClipboardSource,
        ) -> ClipboardCaptureOutcome {
            self.calls += 1;
            self.sources_seen.push(source.clone());
            self.results.remove(0)
        }
    }

    /// Returns each canned sample once, then panics like FakeCapturer does on
    /// an empty result — an unexpected extra sample fails the test loudly.
    struct FakeSourceSampler {
        calls: usize,
        samples: Vec<Option<ClipboardSource>>,
    }

    impl ClipboardSourceSampler for FakeSourceSampler {
        fn sample(&mut self) -> Option<ClipboardSource> {
            self.calls += 1;
            self.samples.remove(0)
        }
    }

    /// Returns the same foreground sample every time; existing tests do not
    /// care about the source.
    #[derive(Default)]
    struct FixedSourceSampler {
        calls: usize,
    }

    impl ClipboardSourceSampler for FixedSourceSampler {
        fn sample(&mut self) -> Option<ClipboardSource> {
            self.calls += 1;
            Some(source("Editor.exe"))
        }
    }

    fn source(exe: &str) -> ClipboardSource {
        ClipboardSource {
            exe: exe.to_string(),
            title: format!("{exe} title"),
        }
    }

    struct FakeHistory {
        state: HistoryState,
        locked_attempts: usize,
    }

    impl Default for FakeHistory {
        fn default() -> Self {
            Self {
                state: HistoryState::new(HistoryPolicy::default()),
                locked_attempts: 0,
            }
        }
    }

    impl CaptureHistory for FakeHistory {
        fn store(&mut self, request: CaptureStoreRequest) -> CaptureStoreOutcome {
            if self.locked_attempts > 0 {
                self.locked_attempts -= 1;
                return CaptureStoreOutcome::Locked;
            }
            request.apply(&mut self.state)
        }
    }

    #[derive(Default)]
    struct RecordingEmitter {
        decisions: Vec<CaptureDecision>,
    }

    impl CaptureEmitter for RecordingEmitter {
        fn emit(&mut self, decision: CaptureDecision) {
            self.decisions.push(decision);
        }
    }

    fn clip(id: &str, hash: &str, captured_at: u64, source_exe: &str) -> Clip {
        Clip {
            id: id.to_string(),
            kind: ClipKind::Text,
            text_content: Some(id.to_string()),
            file_paths: None,
            image_data: None,
            thumbnail_base64: None,
            content_hash: hash.to_string(),
            preview: id.to_string(),
            note: None,
            truncated: false,
            source_exe: source_exe.to_string(),
            source_title: format!("{source_exe} title"),
            source_icon: None,
            captured_at,
            pinned: false,
            byte_size: id.len() as u64,
            deferred: None,
        }
    }

    fn captured(clip: Clip) -> ClipboardCaptureOutcome {
        ClipboardCaptureOutcome::Captured(Box::new(clip))
    }

    #[test]
    fn unchanged_sequence_is_a_no_op() {
        let mut monitor = ClipboardMonitor::new(
            FakeSequenceReader { sequence: 0 },
            FakeCapturer::default(),
            FakeHistory::default(),
            RecordingEmitter::default(),
            FixedSourceSampler::default(),
            "Mnemark.exe".to_string(),
        );

        monitor.tick(true, &AppConfig::default(), 1_000);

        assert_eq!(monitor.capturer.calls, 0);
        assert!(matches!(
            monitor.emitter.decisions.as_slice(),
            [CaptureDecision::NoChange]
        ));
    }

    #[test]
    fn new_sequence_with_capture_success_consumes_and_stores() {
        let mut monitor = ClipboardMonitor::new(
            FakeSequenceReader { sequence: 1 },
            FakeCapturer {
                calls: 0,
                sources_seen: Vec::new(),
                results: vec![captured(clip("clip-a", "hash-a", 1_000, "Editor.exe"))],
            },
            FakeHistory::default(),
            RecordingEmitter::default(),
            FixedSourceSampler::default(),
            "Mnemark.exe".to_string(),
        );

        monitor.tick(true, &AppConfig::default(), 1_000);
        monitor.tick(true, &AppConfig::default(), 1_200);

        assert!(matches!(
            monitor.emitter.decisions.as_slice(),
            [
                CaptureDecision::Store {
                    consumed_sequence: 1,
                    update,
                },
                CaptureDecision::NoChange,
            ] if update.clip.id == "clip-a" && update.evicted.is_empty()
        ));
        assert_eq!(monitor.capturer.calls, 1);
        assert_eq!(monitor.history.state.clips_for_ipc().len(), 1);
    }

    #[test]
    fn paused_sequence_is_consumed_without_capture_or_resume_replay() {
        let mut monitor = ClipboardMonitor::new(
            FakeSequenceReader { sequence: 1 },
            FakeCapturer {
                calls: 0,
                sources_seen: Vec::new(),
                results: vec![captured(clip("paused", "hash-paused", 1_000, "Editor.exe"))],
            },
            FakeHistory::default(),
            RecordingEmitter::default(),
            FixedSourceSampler::default(),
            "Mnemark.exe".to_string(),
        );

        monitor.tick(false, &AppConfig::default(), 1_000);
        monitor.tick(true, &AppConfig::default(), 1_200);

        assert_eq!(monitor.capturer.calls, 0);
        assert!(matches!(
            monitor.emitter.decisions.as_slice(),
            [
                CaptureDecision::Skip {
                    consumed_sequence: 1,
                    reason: SkipReason::Paused,
                },
                CaptureDecision::NoChange,
            ]
        ));
        assert!(monitor.history.state.clips_for_ipc().is_empty());
    }

    #[test]
    fn double_copy_inside_debounce_window_is_deferred_then_dropped() {
        let config = AppConfig {
            debounce_ms: 200,
            ..Default::default()
        };
        let mut monitor = ClipboardMonitor::new(
            FakeSequenceReader { sequence: 1 },
            FakeCapturer {
                calls: 0,
                sources_seen: Vec::new(),
                results: vec![
                    captured(clip("first", "same-hash", 0, "Editor.exe")),
                    captured(clip("double", "same-hash", 200, "Editor.exe")),
                ],
            },
            FakeHistory::default(),
            RecordingEmitter::default(),
            FixedSourceSampler::default(),
            "Mnemark.exe".to_string(),
        );

        monitor.tick(true, &config, 0);
        monitor.sequence_reader.sequence = 2;
        monitor.tick(true, &config, 100);
        monitor.tick(true, &config, 200);

        assert_eq!(monitor.capturer.calls, 2);
        assert!(matches!(
            monitor.emitter.decisions.as_slice(),
            [
                CaptureDecision::Store {
                    consumed_sequence: 1,
                    ..
                },
                CaptureDecision::Defer {
                    pending_sequence: 2,
                    reason: DeferReason::Debounce,
                },
                CaptureDecision::Skip {
                    consumed_sequence: 2,
                    reason: SkipReason::DoubleCopy,
                },
            ]
        ));
        assert_eq!(monitor.history.state.clips_for_ipc().len(), 1);
    }

    #[test]
    fn self_capture_keeps_original_attribution_and_dedup_identity() {
        let config = AppConfig {
            debounce_ms: 200,
            ..Default::default()
        };
        let mut monitor = ClipboardMonitor::new(
            FakeSequenceReader { sequence: 1 },
            FakeCapturer {
                calls: 0,
                sources_seen: Vec::new(),
                results: vec![
                    captured(clip("original-id", "same-hash", 0, "Original.exe")),
                    captured(clip("echo-id", "same-hash", 300, "Mnemark.exe")),
                ],
            },
            FakeHistory::default(),
            RecordingEmitter::default(),
            FixedSourceSampler::default(),
            "Mnemark.exe".to_string(),
        );

        monitor.tick(true, &config, 0);
        monitor.sequence_reader.sequence = 2;
        monitor.tick(true, &config, 300);

        let clips = monitor.history.state.clips_for_ipc();
        assert_eq!(clips.len(), 1);
        assert_eq!(clips[0].id, "original-id");
        assert_eq!(clips[0].captured_at, 300);
        assert_eq!(clips[0].source_exe, "Original.exe");
        assert_eq!(clips[0].source_title, "Original.exe title");
        assert!(matches!(
            monitor.emitter.decisions.last(),
            Some(CaptureDecision::Store {
                consumed_sequence: 2,
                update,
            }) if update.clip.id == "original-id"
                && update.clip.source_exe == "Original.exe"
        ));
    }

    #[test]
    fn different_content_inside_window_is_stored_after_defer() {
        let config = AppConfig {
            debounce_ms: 200,
            ..Default::default()
        };
        let mut monitor = ClipboardMonitor::new(
            FakeSequenceReader { sequence: 1 },
            FakeCapturer {
                calls: 0,
                sources_seen: Vec::new(),
                results: vec![
                    captured(clip("first", "hash-a", 0, "Editor.exe")),
                    captured(clip("second", "hash-b", 200, "Editor.exe")),
                ],
            },
            FakeHistory::default(),
            RecordingEmitter::default(),
            FixedSourceSampler::default(),
            "Mnemark.exe".to_string(),
        );

        monitor.tick(true, &config, 0);
        monitor.sequence_reader.sequence = 2;
        monitor.tick(true, &config, 100);
        monitor.tick(true, &config, 200);

        assert!(matches!(
            monitor.emitter.decisions.as_slice(),
            [
                CaptureDecision::Store {
                    consumed_sequence: 1,
                    ..
                },
                CaptureDecision::Defer {
                    pending_sequence: 2,
                    reason: DeferReason::Debounce,
                },
                CaptureDecision::Store {
                    consumed_sequence: 2,
                    ..
                },
            ]
        ));
        assert_eq!(monitor.history.state.clips_for_ipc().len(), 2);
    }

    #[test]
    fn definitive_capture_skip_consumes_the_sequence() {
        let mut monitor = ClipboardMonitor::new(
            FakeSequenceReader { sequence: 1 },
            FakeCapturer {
                calls: 0,
                sources_seen: Vec::new(),
                results: vec![ClipboardCaptureOutcome::Skipped("excluded".to_string())],
            },
            FakeHistory::default(),
            RecordingEmitter::default(),
            FixedSourceSampler::default(),
            "Mnemark.exe".to_string(),
        );

        monitor.tick(true, &AppConfig::default(), 1_000);
        monitor.tick(true, &AppConfig::default(), 1_200);

        assert_eq!(monitor.capturer.calls, 1);
        assert!(matches!(
            monitor.emitter.decisions.as_slice(),
            [
                CaptureDecision::Skip {
                    consumed_sequence: 1,
                    reason: SkipReason::Capture(reason),
                },
                CaptureDecision::NoChange,
            ] if reason == "excluded"
        ));
    }

    #[test]
    fn locked_clipboard_leaves_sequence_pending_for_retry() {
        let mut monitor = ClipboardMonitor::new(
            FakeSequenceReader { sequence: 1 },
            FakeCapturer {
                calls: 0,
                sources_seen: Vec::new(),
                results: vec![
                    ClipboardCaptureOutcome::Locked,
                    captured(clip("retry", "hash-retry", 50, "Editor.exe")),
                ],
            },
            FakeHistory::default(),
            RecordingEmitter::default(),
            FixedSourceSampler::default(),
            "Mnemark.exe".to_string(),
        );

        monitor.tick(true, &AppConfig::default(), 0);
        monitor.tick(true, &AppConfig::default(), 50);

        assert!(matches!(
            monitor.emitter.decisions.as_slice(),
            [
                CaptureDecision::Defer {
                    pending_sequence: 1,
                    reason: DeferReason::ClipboardLocked,
                },
                CaptureDecision::Store {
                    consumed_sequence: 1,
                    ..
                },
            ]
        ));
    }

    #[test]
    fn locked_history_leaves_sequence_pending_for_retry() {
        let history = FakeHistory {
            locked_attempts: 1,
            ..Default::default()
        };
        let mut monitor = ClipboardMonitor::new(
            FakeSequenceReader { sequence: 1 },
            FakeCapturer {
                calls: 0,
                sources_seen: Vec::new(),
                results: vec![
                    captured(clip("first", "same-hash", 0, "Editor.exe")),
                    captured(clip("retry", "same-hash", 50, "Editor.exe")),
                ],
            },
            history,
            RecordingEmitter::default(),
            FixedSourceSampler::default(),
            "Mnemark.exe".to_string(),
        );

        monitor.tick(true, &AppConfig::default(), 0);
        monitor.tick(true, &AppConfig::default(), 50);

        assert!(matches!(
            monitor.emitter.decisions.as_slice(),
            [
                CaptureDecision::Defer {
                    pending_sequence: 1,
                    reason: DeferReason::HistoryLocked,
                },
                CaptureDecision::Store {
                    consumed_sequence: 1,
                    ..
                },
            ]
        ));
        assert_eq!(monitor.history.state.clips_for_ipc().len(), 1);
    }

    #[test]
    fn newer_clipboard_change_after_debounce_is_stored() {
        let config = AppConfig {
            debounce_ms: 200,
            ..Default::default()
        };
        let mut monitor = ClipboardMonitor::new(
            FakeSequenceReader { sequence: 1 },
            FakeCapturer {
                calls: 0,
                sources_seen: Vec::new(),
                results: vec![
                    captured(clip("first", "same-hash", 0, "Editor.exe")),
                    captured(clip("recopy", "same-hash", 200, "Editor.exe")),
                ],
            },
            FakeHistory::default(),
            RecordingEmitter::default(),
            FixedSourceSampler::default(),
            "Mnemark.exe".to_string(),
        );

        monitor.tick(true, &config, 0);
        monitor.sequence_reader.sequence = 2;
        monitor.tick(true, &config, 100);
        monitor.sequence_reader.sequence = 3;
        monitor.tick(true, &config, 200);

        assert!(matches!(
            monitor.emitter.decisions.last(),
            Some(CaptureDecision::Store {
                consumed_sequence: 3,
                ..
            })
        ));
    }

    #[test]
    fn recopy_after_debounce_refreshes_timestamp_source_and_order() {
        let config = AppConfig {
            debounce_ms: 200,
            ..Default::default()
        };
        let mut monitor = ClipboardMonitor::new(
            FakeSequenceReader { sequence: 1 },
            FakeCapturer {
                calls: 0,
                sources_seen: Vec::new(),
                results: vec![
                    captured(clip("old-id", "same-hash", 0, "First.exe")),
                    captured(clip("middle-id", "middle-hash", 300, "Middle.exe")),
                    captured(clip("new-id", "same-hash", 600, "Second.exe")),
                ],
            },
            FakeHistory::default(),
            RecordingEmitter::default(),
            FixedSourceSampler::default(),
            "Mnemark.exe".to_string(),
        );

        monitor.tick(true, &config, 0);
        monitor.sequence_reader.sequence = 2;
        monitor.tick(true, &config, 300);
        monitor.sequence_reader.sequence = 3;
        monitor.tick(true, &config, 600);

        let clips = monitor.history.state.clips_for_ipc();
        assert_eq!(clips.len(), 2);
        assert_eq!(clips[0].id, "old-id");
        assert_eq!(clips[1].id, "middle-id");
        assert_eq!(clips[0].captured_at, 600);
        assert_eq!(clips[0].source_exe, "Second.exe");
    }

    #[test]
    fn persistence_failure_is_emitted_without_mutating_history() {
        use crate::persistence::Persistence;

        let mut history = FakeHistory::default();
        history
            .state
            .install_persistence_for_test(Persistence::writes_fail_for_test());
        let mut monitor = ClipboardMonitor::new(
            FakeSequenceReader { sequence: 1 },
            FakeCapturer {
                calls: 0,
                sources_seen: Vec::new(),
                results: vec![captured(clip("failed", "hash-failed", 1_000, "Editor.exe"))],
            },
            history,
            RecordingEmitter::default(),
            FixedSourceSampler::default(),
            "Mnemark.exe".to_string(),
        );

        monitor.tick(true, &AppConfig::default(), 1_000);
        monitor.tick(true, &AppConfig::default(), 1_200);

        assert!(monitor.history.state.clips_for_ipc().is_empty());
        assert!(matches!(
            monitor.emitter.decisions.as_slice(),
            [
                CaptureDecision::PersistenceFailed {
                    consumed_sequence: 1,
                    message,
                },
                CaptureDecision::NoChange,
            ] if !message.is_empty()
        ));
        assert_eq!(monitor.capturer.calls, 1);
    }

    #[test]
    fn focus_change_during_debounce_cannot_re_attribute_the_source() {
        let config = AppConfig {
            debounce_ms: 200,
            ..Default::default()
        };
        let mut monitor = ClipboardMonitor::new(
            FakeSequenceReader { sequence: 1 },
            FakeCapturer {
                calls: 0,
                sources_seen: Vec::new(),
                results: vec![
                    captured(clip("first", "hash-first", 0, "Editor.exe")),
                    // The capturer enforces the exclusion list, so the frozen
                    // Vault.exe sample is rejected even though focus moved on.
                    ClipboardCaptureOutcome::Skipped("excluded".to_string()),
                ],
            },
            FakeHistory::default(),
            RecordingEmitter::default(),
            FakeSourceSampler {
                calls: 0,
                // Sequence 1 arms the debounce. Sequence 2 is FIRST observed
                // while Vault.exe is still foreground; by the delayed capture
                // the foreground is Browser.exe — sampling then would
                // misattribute. A third sample is never taken.
                samples: vec![
                    Some(source("Editor.exe")),
                    Some(source("Vault.exe")),
                    Some(source("Browser.exe")),
                ],
            },
            "Mnemark.exe".to_string(),
        );

        // A capture arms the debounce window; then the excluded app copies
        // and loses focus before the window expires.
        monitor.tick(true, &config, 0);
        monitor.sequence_reader.sequence = 2;
        monitor.tick(true, &config, 100);
        monitor.tick(true, &config, 200);

        assert_eq!(monitor.source_sampler.calls, 2);
        assert_eq!(
            monitor.capturer.sources_seen,
            vec![source("Editor.exe"), source("Vault.exe")]
        );
        assert!(matches!(
            monitor.emitter.decisions.as_slice(),
            [
                CaptureDecision::Store {
                    consumed_sequence: 1,
                    ..
                },
                CaptureDecision::Defer {
                    pending_sequence: 2,
                    reason: DeferReason::Debounce,
                },
                CaptureDecision::Skip {
                    consumed_sequence: 2,
                    reason: SkipReason::Capture(reason),
                },
            ] if reason == "excluded"
        ));
        // Only the arming capture (Editor.exe) is stored; the frozen excluded
        // sample never reaches history.
        assert_eq!(monitor.history.state.clips_for_ipc().len(), 1);
    }

    #[test]
    fn history_lock_retry_keeps_the_first_sampled_source() {
        let history = FakeHistory {
            locked_attempts: 1,
            ..Default::default()
        };
        let mut monitor = ClipboardMonitor::new(
            FakeSequenceReader { sequence: 1 },
            FakeCapturer {
                calls: 0,
                sources_seen: Vec::new(),
                results: vec![
                    captured(clip("first", "hash-retry", 0, "Editor.exe")),
                    captured(clip("retry", "hash-retry", 50, "Editor.exe")),
                ],
            },
            history,
            RecordingEmitter::default(),
            FakeSourceSampler {
                calls: 0,
                samples: vec![Some(source("Editor.exe")), Some(source("Browser.exe"))],
            },
            "Mnemark.exe".to_string(),
        );

        monitor.tick(true, &AppConfig::default(), 0);
        monitor.tick(true, &AppConfig::default(), 50);

        assert_eq!(monitor.source_sampler.calls, 1);
        assert_eq!(
            monitor.capturer.sources_seen,
            vec![source("Editor.exe"), source("Editor.exe")]
        );
    }

    #[test]
    fn undeterminable_source_is_skipped_conservatively() {
        let mut monitor = ClipboardMonitor::new(
            FakeSequenceReader { sequence: 1 },
            FakeCapturer {
                calls: 0,
                sources_seen: Vec::new(),
                results: vec![],
            },
            FakeHistory::default(),
            RecordingEmitter::default(),
            FakeSourceSampler {
                calls: 0,
                samples: vec![None],
            },
            "Mnemark.exe".to_string(),
        );

        monitor.tick(true, &AppConfig::default(), 1_000);
        monitor.tick(true, &AppConfig::default(), 1_200);

        assert_eq!(monitor.capturer.calls, 0);
        assert!(monitor.history.state.clips_for_ipc().is_empty());
        assert!(matches!(
            monitor.emitter.decisions.as_slice(),
            [
                CaptureDecision::Skip {
                    consumed_sequence: 1,
                    reason: SkipReason::Capture(reason),
                },
                CaptureDecision::NoChange,
            ] if reason == "Source could not be determined"
        ));
    }

    #[test]
    fn production_poll_interval_remains_two_hundred_milliseconds() {
        assert_eq!(POLL_INTERVAL, std::time::Duration::from_millis(200));
    }
}
