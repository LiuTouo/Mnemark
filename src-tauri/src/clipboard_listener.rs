//! Event-driven clipboard monitoring shell.
//!
//! A message-only window (invisible, message-only windows are excluded from
//! enumeration and receive no input) is registered with
//! `AddClipboardFormatListener`, so `WM_CLIPBOARDUPDATE` wakes the monitor the
//! moment ANY process changes the clipboard — replacing the legacy 200 ms
//! polling loop (kept as a fallback in `start_monitor`). Deferred decisions
//! arm a one-shot retry timer; a slow heartbeat timer re-checks periodically
//! as insurance against a missed event (session reconnects, queue hiccups).
//!
//! The window belongs to the thread that called [`ClipboardListener::new`];
//! [`ClipboardListener::run`] must be called from that same thread (it pumps
//! the thread's message queue). The trigger callback runs inside the window
//! procedure, so it is wrapped in `catch_unwind` — unwinding across the
//! `extern "system"` boundary is undefined behavior.

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::DataExchange::AddClipboardFormatListener;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, GetWindowLongPtrW, KillTimer,
    RegisterClassW, SetTimer, SetWindowLongPtrW, TranslateMessage, GWLP_USERDATA, WINDOW_EX_STYLE,
    WINDOW_STYLE, WM_CLIPBOARDUPDATE, WM_TIMER, WNDCLASSW,
};

/// Message-only window parent: the SDK's ((HWND)-3). windows-rs does not
/// export it, so it is defined here verbatim.
const HWND_MESSAGE: HWND = HWND(-3isize as usize as *mut core::ffi::c_void);

/// One-shot retry timer id (armed after a Defer decision).
const RETRY_TIMER_ID: usize = 1;
/// Periodic heartbeat timer id.
const HEARTBEAT_TIMER_ID: usize = 2;
/// Heartbeat cadence: cheap insurance against a missed WM_CLIPBOARDUPDATE.
const HEARTBEAT_INTERVAL_MS: u32 = 5_000;

/// What woke the monitor thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Trigger {
    /// WM_CLIPBOARDUPDATE: the clipboard sequence number changed.
    ClipboardEvent,
    /// The one-shot retry timer armed after a deferred decision.
    Retry,
    /// The periodic heartbeat.
    Heartbeat,
}

/// A clipboard-listener message-only window bound to the creating thread.
pub(crate) struct ClipboardListener {
    hwnd: HWND,
}

/// Callback storage leaked into GWLP_USERDATA; owned by the window, which
/// lives for the rest of the process.
type TriggerCallback = Box<dyn FnMut(Trigger)>;

impl ClipboardListener {
    /// Create the hidden message-only window and register it as a clipboard
    /// format listener. Must run on the thread that will call [`Self::run`].
    pub(crate) fn new() -> Result<Self, String> {
        unsafe {
            let hinstance = {
                use windows::Win32::System::LibraryLoader::GetModuleHandleW;
                let module = GetModuleHandleW(PCWSTR::null()).map_err(|e| e.to_string())?;
                windows::Win32::Foundation::HINSTANCE(module.0)
            };
            let class_name = w!("MnemarkMonitor");
            let wc = WNDCLASSW {
                lpfnWndProc: Some(monitor_wndproc),
                lpszClassName: class_name,
                hInstance: hinstance,
                ..Default::default()
            };
            // A second registration in the same process would fail with
            // ERROR_CLASS_ALREADY_EXISTS; only one monitor exists per process,
            // so a failure here is a real error.
            if RegisterClassW(&wc) == 0 {
                return Err("RegisterClassW failed".to_string());
            }
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                class_name,
                w!(""),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                None,
                hinstance,
                None,
            )
            .map_err(|e| format!("CreateWindowExW failed: {e}"))?;
            AddClipboardFormatListener(hwnd)
                .map_err(|e| format!("AddClipboardFormatListener failed: {e}"))?;
            Ok(Self { hwnd })
        }
    }

    pub(crate) fn hwnd(&self) -> HWND {
        self.hwnd
    }

    /// Pump this thread's messages forever, invoking `on_trigger` for every
    /// clipboard event, retry and heartbeat. Returns only when the pump fails
    /// (GetMessageW error) — normal operation never returns.
    pub(crate) fn run(&self, on_trigger: impl FnMut(Trigger) + 'static) {
        let callback: TriggerCallback = Box::new(on_trigger);
        unsafe {
            // Box the fat trait pointer once more so the leaked slot holds a
            // thin pointer that can cross GWLP_USERDATA as an isize.
            let leaked = Box::into_raw(Box::new(callback));
            SetWindowLongPtrW(self.hwnd, GWLP_USERDATA, leaked as isize);
            // Periodic heartbeat: re-arm forever (a periodic timer).
            SetTimer(self.hwnd, HEARTBEAT_TIMER_ID, HEARTBEAT_INTERVAL_MS, None);
            loop {
                let mut msg = windows::Win32::UI::WindowsAndMessaging::MSG::default();
                let result = GetMessageW(&mut msg, self.hwnd, 0, 0);
                if result.0 == 0 || result.0 == -1 {
                    crate::log("[Mnemark] monitor message pump exited");
                    return;
                }
                let _ = TranslateMessage(&msg);
                let _ = DispatchMessageW(&msg);
            }
        }
    }
}

/// Arm (or re-arm) the one-shot retry timer for a deferred decision.
pub(crate) fn arm_retry(hwnd: HWND, delay_ms: u64) {
    // u32 clamp: SetTimer takes USER_DWORD milliseconds; multi-day debounces
    // cannot occur (config clamps debounce to 10 s).
    let delay = u32::try_from(delay_ms).unwrap_or(u32::MAX);
    unsafe { SetTimer(hwnd, RETRY_TIMER_ID, delay, None) };
}

/// Disarm the one-shot retry timer (the pending sequence resolved).
pub(crate) fn clear_retry(hwnd: HWND) {
    unsafe { KillTimer(hwnd, RETRY_TIMER_ID).ok() };
}

/// Deliver triggers through GWLP_USERDATA. The callback is invoked inside
/// `catch_unwind`: a panic must not unwind across the FFI boundary, and the
/// pump keeps delivering after the (logged) panic.
unsafe extern "system" fn monitor_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let userdata = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
    if userdata != 0 {
        // SAFETY: the pointer is the Box leaked by run() on this same thread
        // and is never freed or aliased elsewhere.
        let callback = &mut *(userdata as *mut TriggerCallback);
        let trigger = match (msg, wparam.0) {
            (WM_CLIPBOARDUPDATE, _) => Some(Trigger::ClipboardEvent),
            (WM_TIMER, wparam_value) if wparam_value == RETRY_TIMER_ID => {
                // One-shot: disarm so only the shell re-arms it.
                unsafe { KillTimer(hwnd, RETRY_TIMER_ID).ok() };
                Some(Trigger::Retry)
            }
            (WM_TIMER, wparam_value) if wparam_value == HEARTBEAT_TIMER_ID => {
                Some(Trigger::Heartbeat)
            }
            _ => None,
        };
        if let Some(trigger) = trigger {
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| callback(trigger))).is_err()
            {
                // Same contract as the legacy polling loop: log and keep
                // watching. Untrusted clipboard bytes reach the image
                // decoders; one bad payload must not kill monitoring.
                crate::log("[Mnemark] monitor iteration panicked; clipboard watching continues");
            }
            return LRESULT(0);
        }
    }
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}
