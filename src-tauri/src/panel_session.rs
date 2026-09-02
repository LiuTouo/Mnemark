use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering};
use std::time::{Duration, Instant};

const FOCUS_RECHECK_DELAY: Duration = Duration::from_millis(150);
const FOCUS_ARM_BACKSTOP: Duration = Duration::from_millis(500);
const PASTE_POLL_INTERVAL: Duration = Duration::from_millis(25);
const PASTE_SETTLE_DELAY: Duration = Duration::from_millis(50);
const PASTE_FOCUS_TIMEOUT_MS: u64 = 1_000;

pub(crate) trait PanelClock: Send + Sync {
    fn now_ms(&self) -> u64;
    fn sleep(&self, duration: Duration) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
}

pub(crate) trait ForegroundWindowSource: Send + Sync {
    fn foreground_window(&self) -> isize;
    fn foreground_is_desktop(&self) -> bool;
}

pub(crate) struct SystemPanelClock {
    started: Instant,
}

impl Default for SystemPanelClock {
    fn default() -> Self {
        Self {
            started: Instant::now(),
        }
    }
}

impl PanelClock for SystemPanelClock {
    fn now_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    fn sleep(&self, duration: Duration) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(tokio::time::sleep(duration))
    }
}

#[derive(Default)]
pub(crate) struct SystemForegroundWindowSource;

impl ForegroundWindowSource for SystemForegroundWindowSource {
    fn foreground_window(&self) -> isize {
        crate::clipboard::foreground_hwnd()
    }

    fn foreground_is_desktop(&self) -> bool {
        crate::clipboard::foreground_is_desktop()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PasteAction {
    Send,
    SuppressDesktop,
    SuppressUnexpectedTarget,
}

pub(crate) struct PanelSession<C, F> {
    clock: C,
    foreground: F,
    focus_armed: AtomicBool,
    paste_target: AtomicIsize,
    preview_generation: AtomicU64,
}

impl<C, F> PanelSession<C, F>
where
    C: PanelClock,
    F: ForegroundWindowSource,
{
    pub(crate) fn new(clock: C, foreground: F) -> Self {
        Self {
            clock,
            foreground,
            focus_armed: AtomicBool::new(false),
            paste_target: AtomicIsize::new(0),
            preview_generation: AtomicU64::new(0),
        }
    }

    /// Returns true when a focus-loss event should schedule its deferred
    /// re-check. Focus gain arms immediately; the backstop covers platforms
    /// that fail to publish the initial focus event.
    pub(crate) fn focus_changed(&self, focused: bool) -> bool {
        if focused {
            self.focus_armed.store(true, Ordering::SeqCst);
            false
        } else {
            self.focus_armed.load(Ordering::SeqCst)
        }
    }

    pub(crate) async fn arm_after_backstop(&self) -> bool {
        self.clock.sleep(FOCUS_ARM_BACKSTOP).await;
        !self.focus_armed.swap(true, Ordering::SeqCst)
    }

    pub(crate) async fn wait_for_focus_recheck(&self) {
        self.clock.sleep(FOCUS_RECHECK_DELAY).await;
    }

    pub(crate) fn should_dismiss(&self, focused: bool, modal_open: bool) -> bool {
        !focused && !modal_open
    }

    pub(crate) fn remember_paste_target(&self) {
        let target = self.foreground.foreground_window();
        self.paste_target.store(target, Ordering::SeqCst);
    }

    pub(crate) async fn prepare_paste(&self, hide: impl FnOnce()) -> PasteAction {
        let target = self.paste_target.load(Ordering::SeqCst);
        hide();
        let deadline = self.clock.now_ms().saturating_add(PASTE_FOCUS_TIMEOUT_MS);

        loop {
            let foreground = self.foreground.foreground_window();
            if (target != 0 && foreground == target) || self.clock.now_ms() >= deadline {
                break;
            }
            self.clock.sleep(PASTE_POLL_INTERVAL).await;
        }

        self.clock.sleep(PASTE_SETTLE_DELAY).await;
        if self.foreground.foreground_is_desktop() {
            PasteAction::SuppressDesktop
        } else if target == 0 || self.foreground.foreground_window() != target {
            PasteAction::SuppressUnexpectedTarget
        } else {
            PasteAction::Send
        }
    }

    pub(crate) fn claim_preview(&self) -> u64 {
        self.preview_generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub(crate) fn preview_is_current(&self, generation: u64) -> bool {
        self.preview_generation.load(Ordering::SeqCst) == generation
    }

    pub(crate) fn release_preview(&self) {
        self.preview_generation.fetch_add(1, Ordering::SeqCst);
    }

    #[cfg(test)]
    fn clock(&self) -> &C {
        &self.clock
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering};
    use std::sync::Mutex;
    use std::time::Duration;

    use super::{ForegroundWindowSource, PanelClock, PanelSession, PasteAction};

    #[derive(Default)]
    struct FakeClock {
        now: AtomicU64,
        sleeps: Mutex<Vec<Duration>>,
    }

    impl PanelClock for FakeClock {
        fn now_ms(&self) -> u64 {
            self.now.load(Ordering::SeqCst)
        }

        fn sleep(&self, duration: Duration) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
            Box::pin(async move {
                self.sleeps.lock().unwrap().push(duration);
                self.now
                    .fetch_add(duration.as_millis() as u64, Ordering::SeqCst);
            })
        }
    }

    struct FakeForeground {
        windows: Mutex<VecDeque<isize>>,
        last: AtomicIsize,
        desktop: AtomicBool,
    }

    impl FakeForeground {
        fn new(windows: impl IntoIterator<Item = isize>, desktop: bool) -> Self {
            Self {
                windows: Mutex::new(windows.into_iter().collect()),
                last: AtomicIsize::new(0),
                desktop: AtomicBool::new(desktop),
            }
        }
    }

    impl ForegroundWindowSource for FakeForeground {
        fn foreground_window(&self) -> isize {
            let next = self.windows.lock().unwrap().pop_front();
            if let Some(window) = next {
                self.last.store(window, Ordering::SeqCst);
                window
            } else {
                self.last.load(Ordering::SeqCst)
            }
        }

        fn foreground_is_desktop(&self) -> bool {
            self.desktop.load(Ordering::SeqCst)
        }
    }

    #[tokio::test]
    async fn backstop_requests_a_focus_recheck_without_a_second_focus_event() {
        let session = PanelSession::new(FakeClock::default(), FakeForeground::new([], false));

        assert!(!session.focus_changed(false));
        assert!(session.arm_after_backstop().await);
        session.wait_for_focus_recheck().await;
        assert!(session.should_dismiss(false, false));
        assert!(!session.should_dismiss(false, true));
    }

    #[tokio::test]
    async fn backstop_does_not_duplicate_a_recheck_after_focus_gain() {
        let session = PanelSession::new(FakeClock::default(), FakeForeground::new([], false));
        assert!(!session.focus_changed(true));

        assert!(!session.arm_after_backstop().await);
    }

    #[tokio::test]
    async fn paste_polls_for_the_previous_window_then_settles() {
        let session = PanelSession::new(
            FakeClock::default(),
            FakeForeground::new([20, 10, 10, 20, 20], false),
        );
        session.remember_paste_target();
        let hidden = AtomicBool::new(false);

        let action = session
            .prepare_paste(|| hidden.store(true, Ordering::SeqCst))
            .await;

        assert_eq!(action, PasteAction::Send);
        assert!(hidden.load(Ordering::SeqCst));
        assert_eq!(
            *session.clock().sleeps.lock().unwrap(),
            [
                Duration::from_millis(25),
                Duration::from_millis(25),
                Duration::from_millis(50),
            ]
        );
    }

    #[tokio::test]
    async fn paste_suppresses_the_keystroke_when_the_shell_is_the_target() {
        let session = PanelSession::new(
            FakeClock::default(),
            FakeForeground::new([20, 20, 20], true),
        );
        session.remember_paste_target();

        assert_eq!(
            session.prepare_paste(|| {}).await,
            PasteAction::SuppressDesktop
        );
    }

    #[tokio::test]
    async fn paste_never_sends_to_a_window_other_than_the_saved_target() {
        let session = PanelSession::new(FakeClock::default(), FakeForeground::new([20, 30], false));
        session.remember_paste_target();

        assert_eq!(
            session.prepare_paste(|| {}).await,
            PasteAction::SuppressUnexpectedTarget
        );
    }

    #[tokio::test]
    async fn unavailable_target_clears_the_previous_session_target() {
        let session = PanelSession::new(
            FakeClock::default(),
            FakeForeground::new([20, 0, 20], false),
        );
        session.remember_paste_target();
        session.remember_paste_target();

        assert_eq!(
            session.prepare_paste(|| {}).await,
            PasteAction::SuppressUnexpectedTarget
        );
    }

    #[test]
    fn preview_hide_supersedes_a_pending_commit() {
        let session = PanelSession::new(FakeClock::default(), FakeForeground::new([], false));
        let pending = session.claim_preview();
        assert!(session.preview_is_current(pending));

        session.release_preview();

        assert!(!session.preview_is_current(pending));
        let current = session.claim_preview();
        assert!(session.preview_is_current(current));
    }
}
