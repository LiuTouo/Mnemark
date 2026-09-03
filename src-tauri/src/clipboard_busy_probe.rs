//! Regression probes for the "Ctrl+C then Ctrl+V pastes nothing" bug class:
//! interference between Mnemark's capture and delayed-render source apps.
//!
//! Facts these probes established about the Windows clipboard (all measured,
//! not assumed):
//! - During a delayed render (`WM_RENDERFORMAT`), the clipboard is NOT locked
//!   against other openers — but an opener interleaving during the wait
//!   destroys the pending reader's result (its `GetClipboardData` returns
//!   NULL), which the user experiences as "paste does nothing".
//! - A second concurrent READER gets its own render and is served — readers
//!   do not collide with readers.
//!
//! Capture therefore reads exactly ONE format per change (the winner by
//! priority, picked with the open-free `IsClipboardFormatAvailable`), treats
//! a NULL from `GetClipboardData` as a lost render — recording a deferred
//! Clip instead of re-probing lower-priority formats (each re-probe forces
//! another render, another lost-render chance per copy) — and pasting a
//! deferred Clip skips the clipboard write entirely while the sequence is
//! unchanged, so the paste target renders the content itself.
//!
//! The fixture owns the clipboard with a hidden window that delayed-renders
//! CF_DIB + CF_UNICODETEXT slowly (400 ms sleep in `WM_RENDERFORMAT`). A
//! competitor thread hammers `OpenClipboard`. The clipboard is process
//! (and machine) global, so probe tests serialize on CLIPBOARD_TEST_LOCK.

#[cfg(test)]
mod probes {
    use crate::clipboard::capture_clipboard;
    use crate::models::AppConfig;

    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HANDLE, HGLOBAL, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
        TranslateMessage, MSG, WINDOW_EX_STYLE, WINDOW_STYLE, WNDCLASSW,
    };

    // 0x0305 — hard-coded to avoid guessing the crate's const path.
    const WM_RENDERFORMAT: u32 = 0x0305;
    const CF_UNICODETEXT: u32 = 13;
    const CF_DIB: u32 = 8;

    const RENDER_DELAY_MS: u64 = 400;
    /// Threshold the fix must get under: a paste target needs the clipboard
    /// within its own brief retry budget.
    const BUSY_THRESHOLD_MS: u128 = 100;

    static RENDER_DELAY_MS_STATIC: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(RENDER_DELAY_MS);

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    struct SharedFixture {
        stop: AtomicBool,
    }

    static TEST_WNDCLASS_REGISTERED: std::sync::OnceLock<u16> = std::sync::OnceLock::new();

    fn register_test_wndclass() -> u16 {
        *TEST_WNDCLASS_REGISTERED.get_or_init(|| {
            unsafe {
                let hinstance = GetModuleHandleW(PCWSTR::null()).expect("GetModuleHandleW");
                let class_name = wide("MnemarkBusyProbeWnd");
                let wc = WNDCLASSW {
                    style: Default::default(),
                    lpfnWndProc: Some(probe_wndproc),
                    cbClsExtra: 0,
                    cbWndExtra: 0,
                    hInstance: hinstance.into(),
                    hIcon: Default::default(),
                    hCursor: Default::default(),
                    hbrBackground: Default::default(),
                    lpszMenuName: PCWSTR::null(),
                    lpszClassName: PCWSTR::from_raw(class_name.as_ptr()),
                };
                RegisterClassW(&wc)
            }
        })
    }

    /// The Windows clipboard is process-global: the probe tests must never
    /// run concurrently with each other under the default parallel test
    /// runner.
    static CLIPBOARD_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    static RENDER_TOTAL_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    /// Ordered log of every WM_RENDERFORMAT the fixture served. Mutex, not
    /// atomics: the SendMessage reply that ends each render is the
    /// happens-before edge that makes the log visible to the test thread —
    /// Relaxed atomics had no such edge and flaked.
    static RENDER_LOG: std::sync::Mutex<Vec<u32>> = std::sync::Mutex::new(Vec::new());
    // One-shot render, Excel-style: each format renders at most once. A
    // second WM_RENDERFORMAT for an already-rendered format is refused —
    // that is what a real source app does when its copy state is gone.
    static RENDERED_FORMATS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    static ONE_SHOT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

    unsafe extern "system" fn probe_wndproc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if msg == WM_RENDERFORMAT {
            let fmt = wparam.0 as u32;
            let t0 = std::time::Instant::now(); 
            let mask = 1u64 << (fmt.min(63));
            RENDERED_FORMATS.fetch_or(mask, Ordering::Relaxed);
            if ONE_SHOT.load(Ordering::Relaxed) {
                let already = RENDERED_FORMATS.fetch_or(mask, Ordering::Relaxed);
                if already & mask != 0 {
                    // Refuse: render state is gone after the first render.
                    return LRESULT(0);
                }
            }
            let delay = RENDER_DELAY_MS_STATIC.load(Ordering::Relaxed);
            std::thread::sleep(Duration::from_millis(delay));
            RENDER_TOTAL_MS.fetch_add(delay, Ordering::Relaxed);
            RENDER_LOG
                .lock()
                .expect("render log")
                .push(fmt);

            println!( 
                "render fmt={} done in {} ms",
                fmt,
                t0.elapsed().as_millis()
            );

            if fmt == CF_UNICODETEXT {
                // Render a small UTF-16 string, NUL-terminated, GMEM_MOVEABLE.
                let text: Vec<u16> = "mnemark probe".encode_utf16().chain(std::iter::once(0)).collect();
                if let Ok(hmem) = GlobalAlloc(GMEM_MOVEABLE, text.len() * 2) {
                    let ptr = GlobalLock(hmem);
                    if !ptr.is_null() {
                        std::ptr::copy_nonoverlapping(text.as_ptr(), ptr as *mut u16, text.len());
                        let _ = GlobalUnlock(hmem);
                        let _ = SetClipboardData(CF_UNICODETEXT, HANDLE(hmem.0));
                    } else {
                        let _ = windows::Win32::Foundation::GlobalFree(hmem);
                    }
                }
            } else if fmt == CF_DIB {
                // Minimal 40-byte BITMAPINFOHEADER-only DIB: enough bytes for
                // a capturer to read and hash without a full pixel payload.
                if let Ok(hmem) = GlobalAlloc(GMEM_MOVEABLE, 40) {
                    let ptr = GlobalLock(hmem);
                    if !ptr.is_null() {
                        // biSize=40, 1x1, 1 plane, 24bpp, BI_RGB, rest zero.
                        let header: [u8; 40] = [
                            40, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 24, 0,
                            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                            0, 0, 0, 0, 0, 0, 0, 0,
                        ];
                        std::ptr::copy_nonoverlapping(header.as_ptr(), ptr as *mut u8, 40);
                        let _ = GlobalUnlock(hmem);
                        let _ = SetClipboardData(CF_DIB, HANDLE(hmem.0));
                    } else {
                        let _ = windows::Win32::Foundation::GlobalFree(hmem);
                    }
                }
            }
            return LRESULT(0);
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    /// Owner thread: create a message-only window, take clipboard ownership
    /// with a delayed-render CF_UNICODETEXT, then pump messages so
    /// `WM_RENDERFORMAT` (sent cross-thread by the capturer) is delivered.
    fn spawn_owner(ready: mpsc::Sender<()>, shared: std::sync::Arc<SharedFixture>) {
        std::thread::spawn(move || {
            unsafe {
                let _ = register_test_wndclass();
                let class_name = wide("MnemarkBusyProbeWnd");
                let hwnd = CreateWindowExW(
                    WINDOW_EX_STYLE(0),
                    PCWSTR::from_raw(class_name.as_ptr()),
                    PCWSTR::null(),
                    WINDOW_STYLE(0),
                    0,
                    0,
                    0,
                    0,
                    HWND::default(),
                    windows::Win32::UI::WindowsAndMessaging::HMENU::default(),
                    GetModuleHandleW(PCWSTR::null()).unwrap_or_default(),
                    None,
                )
                .expect("CreateWindowExW");

                // Delayed render: set both formats with NULL handles so any
                // reader forces a render per format asked.
                let mut opened = false;
                for _ in 0..20 {
                    if OpenClipboard(hwnd).is_ok() {
                        opened = true;
                        break;
                    }
                    // A real clipboard reader (possibly a production Mnemark
                    // running on this desktop) may hold the clipboard open
                    // for its brief capture window.
                    std::thread::sleep(Duration::from_millis(50));
                }
                assert!(opened, "owner OpenClipboard");
                let _ = EmptyClipboard();
                let _ = SetClipboardData(CF_DIB, HANDLE(std::ptr::null_mut()));
                let _ = SetClipboardData(CF_UNICODETEXT, HANDLE(std::ptr::null_mut()));
                CloseClipboard().expect("owner CloseClipboard");

                ready.send(()).expect("send ready");

                let mut msg = MSG::default();
                while !shared.stop.load(Ordering::Relaxed) {
                    // Timeout-free wait is fine: stop is checked per message;
                    // the test tears down the process soon after anyway.
                    if GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                    std::thread::sleep(Duration::from_millis(1));
                    if RENDER_TOTAL_MS.load(Ordering::Relaxed) > 0 {
                        // One render delivered — nothing more to pump for.
                        // Keep pumping until stop so the capturer's
                        // cross-thread SendMessage gets its reply.
                    }
                }
            }
        });
    }

    /// Competitor thread: behaves exactly like a paste target — try
    /// `OpenClipboard`, use it, release. Records the longest consecutive busy
    /// window.
    fn spawn_competitor(shared: std::sync::Arc<SharedFixture>) -> mpsc::Receiver<(u32, u128)> {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut busy_opened_at: Option<Instant> = None;
            let mut max_busy: u128 = 0;
            let mut fail_count: u32 = 0;
            while !shared.stop.load(Ordering::Relaxed) {
                unsafe {
                    if OpenClipboard(HWND(std::ptr::null_mut())).is_ok() {
                        let _ = CloseClipboard();
                        busy_opened_at = None;
                    } else {
                        fail_count += 1;
                        let now = Instant::now();
                        let open_since = *busy_opened_at.get_or_insert(now);
                        let elapsed = now.duration_since(open_since).as_millis();
                        if elapsed > max_busy {
                            max_busy = elapsed;
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            let _ = tx.send((fail_count, max_busy));
        });
        rx
    }

    /// Isolate the delayed-render read from capture_clipboard: what does a
    /// plain GetClipboardData see, and with which Win32 error on failure?
    #[test]
    #[ignore = "diagnostic helper, kept from the investigation"]
    fn delayed_render_direct_getclipboarddata() {
        let _clipboard_guard = CLIPBOARD_TEST_LOCK.lock().expect("clipboard test lock");
        let shared = std::sync::Arc::new(SharedFixture {
            stop: AtomicBool::new(false),
        });
        let (ready_tx, ready_rx) = mpsc::channel();
        spawn_owner(ready_tx, shared.clone());
        ready_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("owner ready");

        let start = Instant::now();
        let opened = unsafe { OpenClipboard(HWND(std::ptr::null_mut())) };
        println!("direct: open ok: {}", opened.is_ok());
        let read = unsafe { GetClipboardData(CF_UNICODETEXT) };
        println!(
            "direct: get elapsed {} ms, ok: {}",
            start.elapsed().as_millis(),
            read.is_ok()
        );
        if let Err(e) = &read {
            println!("direct: get error: {}", e);
        }
        if let Ok(h) = read {
            let h = HGLOBAL(h.0);
            let size = unsafe { GlobalSize(h) };
            let ptr = unsafe { GlobalLock(h) };
            let text = if ptr.is_null() {
                "<null lock>".to_string()
            } else {
                let units = size / 2;
                let mut chars = Vec::new();
                let mut p = ptr as *const u16;
                for _ in 0..units {
                    let c = unsafe { *p };
                    if c == 0 {
                        break;
                    }
                    chars.push(c);
                    p = unsafe { p.add(1) };
                }
                unsafe { let _ = GlobalUnlock(h); };
                String::from_utf16_lossy(&chars)
            };
            println!("direct: read text = {:?}", text);
        }
        unsafe { let _ = CloseClipboard(); };
        shared.stop.store(true, Ordering::Relaxed);
    }

    /// Regression for "Ctrl+C then Ctrl+V pastes nothing": on a delayed-render
    /// source whose render is lost (a third party opens the clipboard during
    /// the wait), capture must force exactly ONE render — never re-probe
    /// lower-priority formats, each a fresh lost-render chance — and record a
    /// deferred Clip so the copy is never missed. RED before the fix: the
    /// three-probe pattern forced two renders here and stored nothing.
    #[test]
    fn capture_defers_instead_of_forcing_repeated_renders() {
        let _clipboard_guard = CLIPBOARD_TEST_LOCK.lock().expect("clipboard test lock");
        ONE_SHOT.store(false, Ordering::Relaxed);
        RENDERED_FORMATS.store(0, Ordering::Relaxed);
        RENDER_TOTAL_MS.store(0, Ordering::Relaxed);
        RENDER_LOG.lock().expect("render log").clear();

        let shared = std::sync::Arc::new(SharedFixture {
            stop: AtomicBool::new(false),
        });
        let (ready_tx, ready_rx) = mpsc::channel();
        spawn_owner(ready_tx, shared.clone());
        ready_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("owner ready");

        let competitor = spawn_competitor(shared.clone());
        std::thread::sleep(Duration::from_millis(100));

        let outcome = capture_clipboard(&AppConfig::default());

        std::thread::sleep(Duration::from_millis(50));
        shared.stop.store(true, Ordering::Relaxed);
        let (fail_count, max_busy) = competitor
            .recv_timeout(Duration::from_secs(5))
            .expect("competitor report");

        let summary = match &outcome {
            Ok(clip) => format!(
                "Ok(deferred={:?}, kind={:?})",
                clip.deferred, clip.kind
            ),
            Err(crate::clipboard::CaptureError::Locked) => "Err(Locked)".to_string(),
            Err(crate::clipboard::CaptureError::LostRender) => "Err(LostRender)".to_string(),
            Err(crate::clipboard::CaptureError::Skip(reason)) => {
                format!("Err(Skip({}))", reason)
            }
        };
        println!("capture outcome: {}", summary);
        println!("renders forced: {} ms total", RENDER_TOTAL_MS.load(Ordering::Relaxed));
        println!("competitor failed opens: {}, max busy {} ms", fail_count, max_busy);

        // Deterministic distinguisher, immune to render-retry timing inside
        // one GetClipboardData wait: the winner (DIB) render is forced, but
        // the TEXT format is never asked — the old three-probe pattern forced
        // a second (text) render here, another lost-render chance per change.
        // Mutex read: each render's SendMessage reply is the happens-before
        // edge that makes its log entry visible to this thread.
        let renders = RENDER_LOG.lock().expect("render log").clone();
        assert!(
            renders.contains(&CF_DIB),
            "the winner format's render should have been forced (renders: {:?})",
            renders
        );
        assert!(
            !renders.contains(&CF_UNICODETEXT),
            "lower-priority formats must never be probed after a lost render (renders: {:?})",
            renders
        );
        match outcome {
            Ok(clip) => assert!(
                clip.deferred.is_some(),
                "lost render must record a deferred Clip, got {}",
                summary
            ),
            Err(_) => panic!("lost render must record a deferred Clip, got {}", summary),
        }
        shared.stop.store(true, Ordering::Relaxed);
    }

    /// Untested collision that decides the fix design: Mnemark's capture and
    /// the USER's paste target both wait on the SAME slow render at the same
    /// time. Whose read survives? Owner here re-renders on every request
    /// (real Office keeps re-rendering while its copy state lives).
    #[test]
    fn concurrent_capture_and_paste_both_wait_on_one_render() {
        let _clipboard_guard = CLIPBOARD_TEST_LOCK.lock().expect("clipboard test lock");
        ONE_SHOT.store(false, Ordering::Relaxed); // re-rendering source
        RENDERED_FORMATS.store(0, Ordering::Relaxed);
        RENDER_TOTAL_MS.store(0, Ordering::Relaxed);

        let shared = std::sync::Arc::new(SharedFixture {
            stop: AtomicBool::new(false),
        });
        let (ready_tx, ready_rx) = mpsc::channel();
        spawn_owner(ready_tx, shared.clone());
        ready_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("owner ready");

        // Thread A = Mnemark capture (production path).
        let config = AppConfig::default();
        let cap = std::thread::spawn(move || {
            let t0 = Instant::now();
            let r = capture_clipboard(&config);
            (r.is_ok(), t0.elapsed().as_millis())
        });

        // Thread B = the user's paste target, joining MID-render (+100 ms).
        let paste = std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(100));
            let t0 = Instant::now();
            let opened = unsafe { OpenClipboard(HWND(std::ptr::null_mut())) };
            if opened.is_err() {
                return (false, "open failed".to_string(), t0.elapsed().as_millis());
            }
            let read = unsafe { GetClipboardData(CF_UNICODETEXT) };
            unsafe { let _ = CloseClipboard(); };
            let detail = match &read {
                Ok(_) => "got data".to_string(),
                Err(e) => format!("NULL ({})", e),
            };
            (read.is_ok(), detail, t0.elapsed().as_millis())
        });

        let (cap_ok, cap_ms) = cap.join().expect("capture thread");
        let (paste_ok, paste_detail, paste_ms) = paste.join().expect("paste thread");
        println!(
            "capture: ok={} ({} ms) | paste: ok={} ({} ms, {})",
            cap_ok, cap_ms, paste_ok, paste_ms, paste_detail
        );
        shared.stop.store(true, Ordering::Relaxed);
    }

    #[test]
    fn clipboard_busy_window_during_slow_delayed_render() {
        let _clipboard_guard = CLIPBOARD_TEST_LOCK.lock().expect("clipboard test lock");
        let shared = std::sync::Arc::new(SharedFixture {
            stop: AtomicBool::new(false),
        });

        let (ready_tx, ready_rx) = mpsc::channel();
        spawn_owner(ready_tx, shared.clone());
        ready_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("owner ready");

        let competitor = spawn_competitor(shared.clone());

        // Give the competitor a moment to sample a quiet clipboard first.
        std::thread::sleep(Duration::from_millis(100));

        let config = AppConfig::default();
        let capture_start = Instant::now();
        let outcome = capture_clipboard(&config);
        let capture_elapsed = capture_start.elapsed();

        std::thread::sleep(Duration::from_millis(50));
        shared.stop.store(true, Ordering::Relaxed);
        let (fail_count, max_busy) = competitor
            .recv_timeout(Duration::from_secs(5))
            .expect("competitor report");

        // The capture should have succeeded (text was rendered eventually).
        let clip_summary = match &outcome {
            Ok(clip) => format!("Ok(kind={:?}, bytes={})", clip.kind, clip.byte_size),
            Err(crate::clipboard::CaptureError::Locked) => "Err(Locked)".to_string(),
            Err(crate::clipboard::CaptureError::LostRender) => "Err(LostRender)".to_string(),
            Err(crate::clipboard::CaptureError::Skip(reason)) => {
                format!("Err(Skip({}))", reason)
            }
        };

        println!("capture outcome: {}", clip_summary);
        println!("capture wall time: {} ms", capture_elapsed.as_millis());
        println!("competitor failed opens: {}", fail_count);
        println!("longest clipboard-busy window: {} ms", max_busy);

        assert!(
            max_busy < BUSY_THRESHOLD_MS,
            "clipboard busy for {} ms during capture (threshold {} ms) — a paste target in this window gets \"paste nothing\"",
            max_busy,
            BUSY_THRESHOLD_MS
        );
    }
}
