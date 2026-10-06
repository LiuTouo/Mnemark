//! Diagnostic log for the field: release builds have no console
//! (`windows_subsystem = "windows"` makes `log()` a no-op), so startup-time
//! hotkey and panel-creation failures are invisible exactly when they happen
//! (reboot autostart). This module appends timestamped lines to
//! `data_dir()/mnemark.log` in every build, truncating the file at init once
//! it grows past a small cap so it never grows without bound.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Rotate (truncate) the log at init once it exceeds this size. A few boots'
/// worth of diagnostic lines fit comfortably, and the cap bounds growth.
const MAX_LOG_BYTES: u64 = 256 * 1024;

/// Active log file; `None` until `init()` ran, so pre-init writes are cheap
/// no-ops instead of touching the filesystem.
static LOG_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Activate file logging for this process. Call once at startup.
pub fn init() {
    init_at(crate::models::data_dir().join("mnemark.log"));
}

fn init_at(path: PathBuf) {
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > MAX_LOG_BYTES {
            let _ = std::fs::write(&path, b"");
        }
    }
    if let Ok(mut guard) = LOG_PATH.lock() {
        *guard = Some(path);
    }
}

/// Append one timestamped line. Best-effort: diagnostics must never take the
/// app down, so every error is swallowed.
pub fn write(msg: &str) {
    let path = LOG_PATH.lock().ok().and_then(|guard| guard.clone());
    if let Some(path) = path {
        let _ = write_line(&path, &now_line(msg));
    }
}

fn write_line(path: &Path, line: &str) -> std::io::Result<()> {
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{line}")
}

fn now_line(msg: &str) -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{} [Mnemark] {}", utc_timestamp(secs), msg)
}

/// UTC wall-clock "YYYY-MM-DD HH:MM:SS" from Unix seconds, without pulling a
/// date-time crate into the direct dependency tree (none exists today).
fn utc_timestamp(epoch_secs: u64) -> String {
    let (y, m, d) = civil_from_days((epoch_secs / 86_400) as i64);
    let secs_of_day = epoch_secs % 86_400;
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        y,
        m,
        d,
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60
    )
}

/// Howard Hinnant's civil_from_days: days since 1970-01-01 → (year, month,
/// day), proleptic Gregorian, valid for any date representable in i64.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::{civil_from_days, init_at, utc_timestamp, write_line, MAX_LOG_BYTES};
    use std::path::PathBuf;

    fn temp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("mnemark-diag-{}-{}", name, std::process::id()))
    }

    fn reset(path: &std::path::Path) {
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn utc_timestamp_formats_known_epochs() {
        assert_eq!(utc_timestamp(0), "1970-01-01 00:00:00");
        assert_eq!(utc_timestamp(1_700_000_000), "2023-11-14 22:13:20");
    }

    #[test]
    fn civil_from_days_spans_leap_boundaries() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        // 2024-02-29 (leap day) = 19782 days after the epoch.
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
        // 2024-03-01 = the day after the leap day.
        assert_eq!(civil_from_days(19_783), (2024, 3, 1));
        // 1969-12-31 (pre-epoch, negative day count).
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
    }

    #[test]
    fn write_line_appends_without_truncating() {
        let path = temp("append");
        reset(&path);
        write_line(&path, "first").unwrap();
        write_line(&path, "second").unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, "first\nsecond\n");
        reset(&path);
    }

    #[test]
    fn init_truncates_when_over_cap() {
        let path = temp("cap");
        reset(&path);
        std::fs::write(&path, vec![b'x'; (MAX_LOG_BYTES + 1) as usize]).unwrap();
        init_at(path.clone());
        // init itself only rotates; the file now exists and is empty.
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 0);
        write_line(&path, "fresh").unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(!content.contains('x'));
        assert!(content.contains("fresh"));
        reset(&path);
    }

    #[test]
    fn init_keeps_small_existing_log() {
        let path = temp("keep");
        reset(&path);
        write_line(&path, "previous boot").unwrap();
        init_at(path.clone());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "previous boot\n",
            "a small log must survive init"
        );
        reset(&path);
    }
}
