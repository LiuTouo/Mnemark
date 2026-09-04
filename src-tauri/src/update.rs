//! Update support. One binary serves both channels:
//! - installed (NSIS): full auto update via tauri-plugin-updater (check →
//!   download → verify signature → close → install → relaunch). The updater
//!   must NEVER run on portable — it would run the NSIS installer over a
//!   portable exe.
//! - portable (raw exe anywhere else): the About page checks GitHub for a
//!   newer release, then Rust downloads the signed update manifest (the
//!   webview's fetch dies on CORS when GitHub redirects to the CDN), verifies
//!   it, downloads the manifest-bound exe, and the user overwrites the old
//!   exe manually after quitting.
//!
//! Channel detection reads the NSIS uninstall registry key — the only
//! reliable marker, since the install location is user-selectable
//! (per-user %LOCALAPPDATA%\Programs or per-machine Program Files).

use crate::models::AppConfig;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::Manager;
use url::Url;

fn to_wide(s: &str) -> Vec<u16> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// Decode a REG_SZ/REG_EXPAND_SZ value from a raw u16 buffer. `len_bytes`
/// is the byte count reported by RegQueryValueExW; the terminating null is
/// stripped only when present (the API does not guarantee it for every
/// value type, and blindly dropping the last unit eats a real character).
fn parse_reg_sz(buf: &[u16], len_bytes: usize) -> Option<String> {
    if len_bytes < 2 || !len_bytes.is_multiple_of(2) {
        return None;
    }
    let mut units = &buf[..len_bytes / 2];
    if units.last() == Some(&0) {
        units = &units[..units.len() - 1];
    }
    if units.is_empty() {
        return None;
    }
    Some(String::from_utf16_lossy(units))
}

/// InstallLocation from the NSIS uninstall key, if this machine has one.
/// The value is written quoted ("C:\...\Mnemark") — quotes are trimmed.
fn install_location_from_registry() -> Option<PathBuf> {
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE,
        KEY_READ, REG_EXPAND_SZ, REG_SZ,
    };

    let subkey = to_wide("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Mnemark");
    let value = to_wide("InstallLocation");

    for root in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        unsafe {
            let mut hkey = HKEY::default();
            if RegOpenKeyExW(root, PCWSTR(subkey.as_ptr()), 0, KEY_READ, &mut hkey).is_err() {
                continue;
            }
            let mut buf = [0u16; 512];
            let mut len = (buf.len() * 2) as u32;
            let mut value_type = windows::Win32::System::Registry::REG_VALUE_TYPE::default();
            let ok = RegQueryValueExW(
                hkey,
                PCWSTR(value.as_ptr()),
                None,
                Some(&mut value_type),
                Some(buf.as_mut_ptr() as *mut u8),
                Some(&mut len),
            );
            let _ = RegCloseKey(hkey);
            if ok.is_ok() && matches!(value_type, REG_SZ | REG_EXPAND_SZ) {
                if let Some(raw) = parse_reg_sz(&buf, len as usize) {
                    let trimmed = raw.trim_matches('"').trim_end_matches(['\\', '/']);
                    if !trimmed.is_empty() {
                        return Some(PathBuf::from(trimmed));
                    }
                }
            }
        }
    }
    None
}

/// True when this exe lives in the directory the NSIS installer registered.
/// Case-insensitive, trailing-separator-insensitive.
pub fn is_installed_build() -> bool {
    let exe = std::env::current_exe().unwrap_or_default();
    let Some(dir) = install_location_from_registry() else {
        return false;
    };
    let norm = |p: &std::path::Path| {
        p.to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .to_lowercase()
    };
    exe.parent().map(norm) == Some(norm(&dir))
}

#[tauri::command]
pub fn update_channel() -> &'static str {
    if is_installed_build() {
        "installed"
    } else {
        "portable"
    }
}

/// The minisign public key, mirrored from tauri.conf.json
/// (`plugins.updater.pubkey`). The same key verifies NSIS updater artifacts
/// and portable-update downloads — keep the two in sync when rotating keys.
const UPDATE_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEQ5QjAzOEE4RUJCOTM4MjAKUldRZ09MbnJxRGl3Mlp3NTlQaVNtTmxJS1B1NjRtQ3JjdFlPaklzR2V6d0ZQQ1hoak1NSDdyWDIK";

/// A portable exe is ~15 MB; anything wildly bigger is not an update.
const MAX_DOWNLOAD_BYTES: u64 = 128 * 1024 * 1024;

/// Hosts a portable update may be fetched from. GitHub redirects release
/// assets to its CDN, so both are allowed — and every redirect hop is
/// re-validated: the webview supplies these URLs and must not pivot elsewhere.
fn is_allowed_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("github.com")
        || host
            .to_ascii_lowercase()
            .ends_with(".githubusercontent.com")
}

/// Enforce https + the host allowlist on an already-parsed URL: no
/// credentials, no non-default port, host must be github.com or
/// *.githubusercontent.com. Parsing happens once, with the same grammar
/// the ureq request API uses — so the validated host is always the host
/// the client connects to, and a `?query` or `#fragment` can no longer
/// smuggle an "@allowed.host" past the check.
fn validate_parsed(url: &Url) -> Result<(), String> {
    if url.scheme() != "https" {
        return Err("Download URL must be https".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Download URL must not contain credentials".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Download URL has no host".to_string())?;
    if !is_allowed_host(host) {
        return Err(format!("Download host '{host}' is not allowed"));
    }
    if let Some(port) = url.port() {
        if port != 443 {
            return Err(format!("Download port {port} is not allowed"));
        }
    }
    Ok(())
}

/// Parse `raw` once with the shared URL grammar, then enforce https + the
/// host allowlist. Returns the parsed URL for the download loop.
fn validate_download_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|e| format!("Invalid download URL: {e}"))?;
    validate_parsed(&url)?;
    Ok(url)
}

/// Resolve a `Location` header against the current URL (WHATWG join, so
/// relative references resolve the way a browser would) and re-validate
/// the resolved target before the next hop.
fn resolve_redirect(current: &Url, location: &str) -> Result<Url, String> {
    let next = current
        .join(location)
        .map_err(|e| format!("Invalid redirect Location: {e}"))?;
    validate_parsed(&next)?;
    Ok(next)
}

/// GET `start_url`, following at most 5 redirects with each hop resolved
/// and re-validated (https + host allowlist). The body is capped at
/// MAX_DOWNLOAD_BYTES.
fn download_validated(start_url: &str) -> Result<Vec<u8>, String> {
    use std::io::Read;

    let agent = ureq::AgentBuilder::new()
        .redirects(0)
        .timeout_connect(std::time::Duration::from_secs(10))
        .timeout_read(std::time::Duration::from_secs(120))
        .build();

    let mut url = validate_download_url(start_url)?;
    for _ in 0..5 {
        let resp = match agent.get(url.as_str()).call() {
            Ok(resp) => resp,
            Err(ureq::Error::Status(_, resp)) => resp, // 3xx arrives here with redirects(0)
            Err(e) => return Err(format!("Download failed: {e}")),
        };
        let status = resp.status();
        if (300..400).contains(&status) {
            let location = resp
                .header("Location")
                .ok_or_else(|| "Redirect without Location".to_string())?;
            url = resolve_redirect(&url, location)?;
            continue;
        }
        if status != 200 {
            return Err(format!("Download failed with status {status}"));
        }
        let mut buf = Vec::new();
        resp.into_reader()
            .take(MAX_DOWNLOAD_BYTES + 1)
            .read_to_end(&mut buf)
            .map_err(|e| e.to_string())?;
        if buf.len() as u64 > MAX_DOWNLOAD_BYTES {
            return Err("Download exceeds the size limit".to_string());
        }
        return Ok(buf);
    }
    Err("Too many redirects".to_string())
}

/// Verify `data` against a `tauri signer sign` .sig file, using a pubkey in
/// the tauri.conf.json format (both are base64-wrapped minisign text).
fn verify_with_pubkey(data: &[u8], sig_file: &str, pubkey_b64: &str) -> Result<(), String> {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD;

    let sig_text = b64
        .decode(sig_file.trim())
        .map_err(|e| format!("Bad signature encoding: {e}"))?;
    let sig_text = String::from_utf8(sig_text).map_err(|e| e.to_string())?;
    let signature =
        minisign_verify::Signature::decode(&sig_text).map_err(|e| format!("Bad signature: {e}"))?;

    // The pubkey base64-decodes to the minisign.pub text format
    // ("untrusted comment: ...\n<key base64>"), which PublicKey::decode reads.
    let key_text = b64
        .decode(pubkey_b64.trim())
        .map_err(|e| format!("Bad pubkey encoding: {e}"))?;
    let key_text = String::from_utf8(key_text).map_err(|e| e.to_string())?;
    let pubkey =
        minisign_verify::PublicKey::decode(&key_text).map_err(|e| format!("Bad pubkey: {e}"))?;

    pubkey
        .verify(data, &signature, false)
        .map_err(|e| format!("Signature verification failed: {e}"))
}

/// The GitHub repository releases are fetched from. The manifest binds every
/// update to this value, so a manifest signed for a different repo is worthless.
const RELEASE_REPO: &str = "LiuTouo/Mnemark";

/// Signed update manifest, produced by the release workflow next to the
/// portable exe (`<asset>.manifest.json` + `.sig`, same minisign key). It
/// binds the release to a repository, exact version, channel, architecture,
/// and the artifact's file name, byte length, and SHA-256 — so a re-uploaded
/// old artifact can't pass as a newer release, and an artifact can't be
/// swapped or truncated under a valid signature. The signature covers the
/// raw manifest bytes; the manifest is parsed only after they verify.
#[derive(Debug, Deserialize, PartialEq)]
struct UpdateManifest {
    repository: String,
    version: String,
    channel: String,
    architecture: String,
    file: String,
    length: u64,
    sha256: String,
}

fn parse_manifest(bytes: &[u8]) -> Result<UpdateManifest, String> {
    serde_json::from_slice(bytes).map_err(|e| format!("Invalid update manifest: {e}"))
}

/// Compare dotted numeric versions ("1.2.3", leading 'v' tolerated). Same lax
/// semantics as the About page's cmpSemver: up to three parts, missing = 0.
fn cmp_version(a: &str, b: &str) -> std::cmp::Ordering {
    let parse = |s: &str| -> Vec<u64> {
        s.trim_start_matches('v')
            .split('.')
            .map(|p| p.parse().unwrap_or(0))
            .collect()
    };
    let (pa, pb) = (parse(a), parse(b));
    for i in 0..3 {
        match pa
            .get(i)
            .copied()
            .unwrap_or(0)
            .cmp(&pb.get(i).copied().unwrap_or(0))
        {
            std::cmp::Ordering::Equal => continue,
            other => return other,
        }
    }
    std::cmp::Ordering::Equal
}

/// All field-binding and strict-upgrade checks the verified manifest must
/// pass against this installation: the release must come from our repo, be
/// a portable x86_64 artifact, and be strictly newer than the running exe.
fn check_manifest(manifest: &UpdateManifest, running: &str) -> Result<(), String> {
    if manifest.repository != RELEASE_REPO {
        return Err(format!(
            "Manifest repository '{}' is not '{RELEASE_REPO}'",
            manifest.repository
        ));
    }
    if manifest.channel != "portable" {
        return Err(format!(
            "Manifest channel '{}' is not 'portable'",
            manifest.channel
        ));
    }
    if manifest.architecture != std::env::consts::ARCH {
        return Err(format!(
            "Manifest architecture '{}' is not '{}'",
            manifest.architecture,
            std::env::consts::ARCH
        ));
    }
    if cmp_version(&manifest.version, running) != std::cmp::Ordering::Greater {
        return Err(format!(
            "Manifest version v{} is not newer than the running v{running}",
            manifest.version
        ));
    }
    // File-name binding: the artifact must be exactly the portable exe this
    // version should ship as. One equality check pins the CI naming
    // convention AND rules out path tricks ("../", separators) in one go —
    // anything else simply cannot equal the expected name.
    let expected_file = format!("Mnemark_v{}_x64-portable.exe", manifest.version);
    if manifest.file != expected_file {
        return Err(format!(
            "Manifest file '{}' does not match the expected portable artifact '{expected_file}'",
            manifest.file
        ));
    }
    Ok(())
}

/// Artifact download URL, derived ONLY from the signature-verified manifest —
/// never from a URL the webview supplied.
fn artifact_url(manifest: &UpdateManifest) -> Result<String, String> {
    let url = format!(
        "https://github.com/{RELEASE_REPO}/releases/download/v{}/{}",
        manifest.version, manifest.file
    );
    validate_download_url(&url)?;
    Ok(url)
}

/// Length + SHA-256 binding: the downloaded bytes must be exactly what the
/// signed manifest describes.
fn verify_artifact(bytes: &[u8], manifest: &UpdateManifest) -> Result<(), String> {
    if bytes.len() as u64 != manifest.length {
        return Err(format!(
            "Downloaded artifact is {} bytes, manifest says {}",
            bytes.len(),
            manifest.length
        ));
    }
    use sha2::Digest;
    let digest = hex::encode(sha2::Sha256::digest(bytes));
    if digest != manifest.sha256.to_ascii_lowercase() {
        return Err(format!(
            "Artifact SHA-256 mismatch: got {digest}, manifest says {}",
            manifest.sha256
        ));
    }
    Ok(())
}

/// Where a downloaded portable update is staged: next to the running exe.
fn portable_update_dest() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()?
        .parent()
        .map(|dir| dir.join("mnemark-update.exe"))
}

/// Write `bytes` to `staging`, flush it to disk, then atomically replace
/// `dest` by rename. `staging` must live in the same directory as `dest` so
/// the rename cannot cross volumes. On any failure the staging file is
/// removed and `dest` is left exactly as it was — a half-written update
/// never becomes the file the user runs.
fn stage_atomic(
    dest: &std::path::Path,
    staging: &std::path::Path,
    bytes: &[u8],
) -> Result<(), String> {
    use std::io::Write;

    if let Err(e) = std::fs::File::create(staging).and_then(|mut f| {
        f.write_all(bytes)?;
        f.sync_all()
    }) {
        let _ = std::fs::remove_file(staging);
        return Err(format!("Failed to stage update: {e}"));
    }
    // Windows rename (MoveFileEx with REPLACE_EXISTING) replaces an existing
    // dest atomically; a reader either sees the old file or the new one.
    if let Err(e) = std::fs::rename(staging, dest) {
        let _ = std::fs::remove_file(staging);
        return Err(format!("Failed to apply staged update: {e}"));
    }
    Ok(())
}

/// Delete a leftover portable-update exe next to the current one. Runs at
/// startup: mnemark-update.exe only ever holds a downloaded update pending
/// manual overwrite, so once Mnemark is running again the file is either
/// already applied (a stale duplicate) or abandoned. Trade-off accepted per
/// release flow: a downloaded-but-not-yet-applied update must be fetched
/// again (~15 MB).
pub fn cleanup_stale_portable_update() {
    if let Some(stale) = portable_update_dest() {
        if stale.exists() {
            let _ = std::fs::remove_file(&stale);
        }
        // A staging file left behind by a failed/interrupted stage_atomic.
        let _ = std::fs::remove_file(stale.with_extension("staging"));
    }
}

/// Download the newer portable exe next to the running one. Rust-side
/// because GitHub's asset CDN omits CORS headers, so webview fetch fails.
///
/// The webview supplies only the manifest URL; every trust decision happens
/// here: verify the manifest signature over its raw bytes, parse it, bind it
/// to this repo/channel/architecture and a strictly newer version than the
/// running exe, derive the artifact URL from the verified manifest, verify
/// the downloaded bytes against the manifest's length + SHA-256 — and only
/// then is an unverified byte ever written. Returns the dest path.
#[tauri::command]
pub async fn download_portable_update(
    app: tauri::AppHandle,
    manifest_url: String,
) -> Result<String, String> {
    if is_installed_build() {
        return Err("Portable download is only for portable builds".to_string());
    }
    validate_download_url(&manifest_url)?;
    let dest = portable_update_dest().ok_or_else(|| "No exe dir".to_string())?;
    let running = app.package_info().version.to_string();

    tauri::async_runtime::spawn_blocking(move || {
        // The manifest and its signature arrive together and must verify
        // before anything else is fetched or decided.
        let manifest_bytes = download_validated(&manifest_url)?;
        let sig_url = format!("{manifest_url}.sig");
        let sig_bytes = download_validated(&sig_url)?;
        let sig_text = String::from_utf8(sig_bytes).map_err(|e| e.to_string())?;
        verify_with_pubkey(&manifest_bytes, &sig_text, UPDATE_PUBKEY)?;
        let manifest = parse_manifest(&manifest_bytes)?;
        check_manifest(&manifest, &running)?;

        let exe_bytes = download_validated(&artifact_url(&manifest)?)?;
        verify_artifact(&exe_bytes, &manifest)?;
        let staging = dest.with_extension("staging");
        stage_atomic(&dest, &staging, &exe_bytes)?;
        Ok(dest.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct UpdateCheck {
    /// "up_to_date" | "available"
    pub status: String,
    pub version: Option<String>,
}

#[tauri::command]
pub async fn check_for_updates(app: tauri::AppHandle) -> Result<UpdateCheck, String> {
    use tauri_plugin_updater::UpdaterExt;

    if !is_installed_build() {
        return Err("Updater is only available in installed builds".to_string());
    }
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    Ok(match update {
        Some(u) => UpdateCheck {
            status: "available".to_string(),
            version: Some(u.version),
        },
        None => UpdateCheck {
            status: "up_to_date".to_string(),
            version: None,
        },
    })
}

/// Download and install the pending update. On Windows, the updater exits this
/// process before installation and the passive NSIS installer relaunches it.
#[tauri::command]
pub async fn install_update(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_updater::UpdaterExt;

    if !is_installed_build() {
        return Err("Updater is only available in installed builds".to_string());
    }
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No update available".to_string())?;
    let version = update.version.clone();
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    Ok(version)
}

#[tauri::command]
pub fn restart_app(app: tauri::AppHandle) {
    tauri::process::restart(&app.env());
}

struct UpdateLabels {
    title: &'static str,
    restart_body: &'static str,
}

/// Localized MessageBox strings, mirroring tray_labels() in lib.rs.
fn update_labels(lang: &str) -> UpdateLabels {
    if lang == "en" {
        UpdateLabels {
            title: "Mnemark Update",
            restart_body: "A new version has been installed. Restart Mnemark now?",
        }
    } else {
        UpdateLabels {
            title: "Mnemark 更新",
            restart_body: "已安裝新版本。現在重新啟動 Mnemark 嗎？",
        }
    }
}

/// Yes/No system dialog. Returns true on Yes.
fn msg_box_yes_no(title: &str, body: &str) -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDYES, MB_DEFBUTTON2, MB_ICONINFORMATION, MB_YESNO,
    };

    let title_w = to_wide(title);
    let body_w = to_wide(body);
    unsafe {
        MessageBoxW(
            HWND(std::ptr::null_mut()),
            PCWSTR(body_w.as_ptr()),
            PCWSTR(title_w.as_ptr()),
            MB_YESNO | MB_ICONINFORMATION | MB_DEFBUTTON2,
        ) == IDYES
    }
}

/// Called once from setup(). No-op unless auto_update is on AND this is an
/// installed build. Everything is automatic except one confirmation click
/// before the restart; errors (including a 404 latest.json before the first
/// CI release exists) are logged, never shown at startup.
pub fn spawn_auto_update_check(app: tauri::AppHandle, config: Arc<Mutex<AppConfig>>) {
    let (enabled, lang) = {
        let cfg = crate::lock(&config);
        (cfg.auto_update, cfg.language.clone())
    };
    if !enabled || !is_installed_build() {
        return;
    }

    tauri::async_runtime::spawn(async move {
        use tauri_plugin_updater::UpdaterExt;

        // Let the app settle before hitting the network.
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;

        let update = match app.updater().map_err(|e| e.to_string()) {
            Ok(u) => match u.check().await {
                Ok(Some(update)) => update,
                Ok(None) => return, // up to date
                Err(e) => {
                    crate::log(&format!("[Mnemark] auto-update check failed: {e}"));
                    return;
                }
            },
            Err(e) => {
                crate::log(&format!("[Mnemark] auto-update unavailable: {e}"));
                return;
            }
        };

        crate::log(&format!(
            "[Mnemark] auto-update: installing v{}",
            update.version
        ));
        if let Err(e) = update
            .download_and_install(|_chunk, _total| {}, || {})
            .await
        {
            crate::log(&format!("[Mnemark] auto-update install failed: {e}"));
            return;
        }

        // On Windows the NSIS updater may have already replaced/relaunched
        // the process; if we're still running, offer the restart.
        let labels = update_labels(&lang);
        if msg_box_yes_no(labels.title, labels.restart_body) {
            tauri::process::restart(&app.env());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fixture generated with `npx tauri signer generate` + `npx tauri signer
    // sign` — the exact formats the CI release pipeline uploads and that
    // tauri.conf.json's updater pubkey uses (base64-wrapped minisign text).
    const TEST_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDlDRDFFNTQ5OTdDNDExQTUKUldTbEVjU1hTZVhSbkwrR3FaVWNMejFiTDROak9PL1RNeGliak81WW9ENTltQXFxTEI4MlJ3Q1QK";
    const TEST_SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTbEVjU1hTZVhSbk50c0Y4dmYzNVlzZmh2Z3FYaTk2V0RQNW43VUxicjMvMEsraXhBSzFOcDhKcURKUXVmREFMYzVvaG1RUU13K3ArTjVhVkVqMklVUnNiMWVLRUdsVmc0PQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzg0NzgyMTAyCWZpbGU6ZHVtbXkuZXhlClRibDZJK20rRGFoekUwS25TZ01pSGdYZnA0Si9jQkNKampHTFphYmdOSnUyVXVpMzlTb0MzRDVFVVYxT082MjIxbFhoOUVESk14RTJjM1ZvZ1JzRERBPT0K";
    const TEST_DATA: &[u8] = b"dummy-portable-exe-bytes-for-signature-test";

    // A second keypair + a signed manifest, generated with `npx tauri signer
    // generate/sign` — same formats the release pipeline emits. FULL_MANIFEST
    // describes TEST_DATA (length 43, its SHA-256) at version 0.9.0, so the
    // signature, field binding, and digest checks can all pass together.
    const MANIFEST_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDU1MUUwQ0RGOUY5NDhGODAKUldTQWo1U2Yzd3dlVlFDR3paOWtmbXVrZWcveGVFMFN0ekF5ZERqTTIwVVVHTGFLTko2Q2dhMHEK";
    const FULL_MANIFEST: &str = "{\"architecture\":\"x86_64\",\"channel\":\"portable\",\"file\":\"Mnemark_v0.9.0_x64-portable.exe\",\"length\":43,\"repository\":\"LiuTouo/Mnemark\",\"sha256\":\"f64bd477ab66e2d4d60545eb4a163d991d6f932a94739fbd7abda4bb056204e8\",\"version\":\"0.9.0\"}";
    const FULL_MANIFEST_SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTQWo1U2Yzd3dlVlp1ZUoxa1pjVHY1UnduZ2k1QmVMZlloSUovYlhuRjRYcXZORHB4TW1CQmdLdVhEUThPZHJsY2h6RjJOaTkvNWRlaUJROS8vVmE3SXVPT205YnhpandrPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzg4NDk3Mzc2CWZpbGU6ZnVsbC5qc29uCml6Z3ovMzk5WHJiaDBUVG5aNXJ2dDlMUDZ6aXlQMUVETk5KaU9VbDg4QU8ya0tpYnVRb1ZNWmQ3a09VcS82dEN6N0RwQzQxQ1cxbDhYNW1pakN5d0RnPT0K";

    /// A manifest every check accepts on this machine (arch = build arch,
    /// version 0.9.0 > the 0.8.0 running version the tests pass in).
    fn valid_manifest() -> UpdateManifest {
        UpdateManifest {
            repository: RELEASE_REPO.to_string(),
            version: "0.9.0".to_string(),
            channel: "portable".to_string(),
            architecture: std::env::consts::ARCH.to_string(),
            file: "Mnemark_v0.9.0_x64-portable.exe".to_string(),
            length: TEST_DATA.len() as u64,
            sha256: "f64bd477ab66e2d4d60545eb4a163d991d6f932a94739fbd7abda4bb056204e8".to_string(),
        }
    }

    #[test]
    fn verifies_a_real_tauri_cli_signature() {
        verify_with_pubkey(TEST_DATA, TEST_SIG, TEST_PUBKEY).unwrap();
    }

    #[test]
    fn rejects_tampered_data() {
        let mut bad = TEST_DATA.to_vec();
        bad[0] ^= 0xFF;
        assert!(verify_with_pubkey(&bad, TEST_SIG, TEST_PUBKEY).is_err());
    }

    #[test]
    fn rejects_a_signature_from_another_key() {
        // The project's real update keypair did not sign this fixture.
        assert!(verify_with_pubkey(TEST_DATA, TEST_SIG, UPDATE_PUBKEY).is_err());
    }

    fn wide(s: &str) -> Vec<u16> {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        OsStr::new(s).encode_wide().collect()
    }

    #[test]
    fn reg_sz_with_terminator_is_decoded() {
        let mut buf = wide("C:\\Apps\\Mnemark");
        buf.push(0);
        let len_bytes = buf.len() * 2;
        assert_eq!(
            parse_reg_sz(&buf, len_bytes).as_deref(),
            Some("C:\\Apps\\Mnemark")
        );
    }

    #[test]
    fn reg_sz_without_terminator_is_decoded_whole() {
        // The API does not guarantee a terminating null for every type.
        let buf = wide("C:\\Apps\\Mnemark");
        let len_bytes = buf.len() * 2;
        assert_eq!(
            parse_reg_sz(&buf, len_bytes).as_deref(),
            Some("C:\\Apps\\Mnemark")
        );
    }

    #[test]
    fn reg_sz_rejects_malformed_lengths() {
        let buf = wide("AB");
        assert_eq!(parse_reg_sz(&buf, 3), None); // odd byte count
        assert_eq!(parse_reg_sz(&buf, 0), None); // empty
        assert_eq!(parse_reg_sz(&[0u16], 2), None); // terminator only
    }

    #[test]
    fn url_validation_accepts_only_https_github_hosts() {
        for good in [
            "https://github.com/LiuTouo/Mnemark/releases/download/v1.0.0/Mnemark_v1.0.0_x64-portable.exe",
            "https://objects.githubusercontent.com/github-production-release-asset/abc",
            "https://release-assets.githubusercontent.com/github-production/abc",
            "https://github.com:443/x",
        ] {
            assert!(validate_download_url(good).is_ok(), "should accept: {good}");
        }
        for bad in [
            "http://github.com/x", // plain http
            "https://evil.com/x",
            "https://github.com.evil.com/x", // lookalike suffix
            "https://github.com@evil.com/x", // userinfo hides the real host
            "https://evilgithubusercontent.com/x",
            "ftp://github.com/x",
            "github.com/x",   // no scheme
            "https:///x",     // empty host
            "/relative/path", // redirects must stay absolute
        ] {
            assert!(validate_download_url(bad).is_err(), "should reject: {bad}");
        }
    }

    /// The old hand-rolled splitter validated whatever sat after the first
    /// '/', so a host lookalike in the query or fragment passed while the
    /// HTTP client connected to the real (attacker) host. With the shared
    /// grammar, the authority ends at '?', '#' and '\' — same as ureq.
    #[test]
    fn query_or_fragment_lookalike_host_is_rejected() {
        for bad in [
            "https://attacker.example?@github.com/",
            "https://attacker.example#@github.com/",
        ] {
            assert!(validate_download_url(bad).is_err(), "should reject: {bad}");
        }
    }

    /// The validated host must equal the host the request API would
    /// connect to — encoded delimiters and backslashes stay out of the
    /// authority under the shared grammar.
    #[test]
    fn validated_host_matches_the_grammar_the_client_parses() {
        // Encoded '?' is path data, not a query delimiter.
        let encoded = validate_download_url("https://github.com/%3f@evil.com").unwrap();
        assert_eq!(encoded.host_str(), Some("github.com"));

        // WHATWG: '\' ends the authority like '/' for special schemes.
        let backslash = validate_download_url("https://github.com\\@evil.com/x").unwrap();
        assert_eq!(backslash.host_str(), Some("github.com"));

        // IPv6 hosts never satisfy the allowlist, bracketed or not.
        for bad in ["https://[::1]/x", "https://[2001:db8::]/x"] {
            assert!(validate_download_url(bad).is_err(), "should reject: {bad}");
        }
    }

    #[test]
    fn non_default_port_is_rejected() {
        assert!(validate_download_url("https://github.com:8443/x").is_err());
        assert!(validate_download_url("https://github.com:443/x").is_ok());
    }

    /// Credentials are rejected even when the host itself is allowed —
    /// unlike `github.com@evil.com`, where the host check fires first.
    #[test]
    fn credentials_on_an_allowed_host_are_rejected() {
        assert!(validate_download_url("https://user:pass@github.com/x").is_err());
        assert!(validate_download_url("https://user@github.com/x").is_err());
    }

    /// A relative `Location` resolves against the current URL (browser
    /// rules) and the resolved target is re-validated before the next hop.
    #[test]
    fn relative_redirect_resolves_and_revalidates() {
        let start = validate_download_url(
            "https://github.com/LiuTouo/Mnemark/releases/download/v1.0.0/x.exe",
        )
        .unwrap();

        let next = resolve_redirect(&start, "../../v1.2.0/x.exe").unwrap();
        assert_eq!(
            next.as_str(),
            "https://github.com/LiuTouo/Mnemark/releases/v1.2.0/x.exe"
        );

        for bad in [
            "https://attacker.example/x", // absolute cross-host hop
            "//attacker.example/x",       // scheme-relative hop
            "http://github.com/x",        // downgrade
        ] {
            let target = start.join(bad).unwrap();
            assert!(
                resolve_redirect(&start, bad).is_err(),
                "should reject redirect to: {target}"
            );
        }
    }

    /// Unique scratch dir per test (no tempfile dev-dependency): temp_dir +
    /// test name + pid, wiped if left over from a previous run.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("mnemark-stage-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn staged_update_replaces_dest_and_leaves_no_staging_file() {
        let dir = scratch("ok");
        let dest = dir.join("mnemark-update.exe");
        let staging = dir.join("mnemark-update.staging");
        std::fs::write(&dest, b"old-exe").unwrap();

        stage_atomic(&dest, &staging, b"new-exe-bytes").unwrap();

        assert_eq!(std::fs::read(&dest).unwrap(), b"new-exe-bytes");
        assert!(!staging.exists(), "staging file must be gone after rename");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn staging_failure_cleans_up_and_preserves_existing_dest() {
        let dir = scratch("create-fail");
        let dest = dir.join("mnemark-update.exe");
        std::fs::write(&dest, b"old-exe").unwrap();
        // Force the staging write to fail: the staging path is a directory.
        let staging = dir.join("mnemark-update.staging");
        std::fs::create_dir(&staging).unwrap();

        assert!(stage_atomic(&dest, &staging, b"new-exe").is_err());

        assert_eq!(
            std::fs::read(&dest).unwrap(),
            b"old-exe",
            "existing dest must survive a failed staging"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_failure_removes_staging_and_preserves_dest() {
        let dir = scratch("rename-fail");
        // Force the final rename to fail: dest is a non-empty directory.
        let dest = dir.join("mnemark-update.exe");
        std::fs::create_dir(&dest).unwrap();
        std::fs::write(dest.join("keep.txt"), b"x").unwrap();
        let staging = dir.join("mnemark-update.staging");

        assert!(stage_atomic(&dest, &staging, b"new-exe").is_err());

        assert!(
            !staging.exists(),
            "staging file must be cleaned up on rename failure"
        );
        assert!(dest.join("keep.txt").exists(), "dest must be untouched");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- Signed update manifest (issue #32) -------------------------------

    /// The happy path a release ships: signature over the raw manifest bytes
    /// verifies, the parsed manifest passes every field binding, and the
    /// artifact the manifest describes matches TEST_DATA exactly.
    #[test]
    fn signed_manifest_verifies_and_binds_the_artifact() {
        verify_with_pubkey(FULL_MANIFEST.as_bytes(), FULL_MANIFEST_SIG, MANIFEST_PUBKEY).unwrap();
        let manifest = parse_manifest(FULL_MANIFEST.as_bytes()).unwrap();
        assert_eq!(manifest, valid_manifest());
        check_manifest(&manifest, "0.8.0").unwrap();
        verify_artifact(TEST_DATA, &manifest).unwrap();
    }

    #[test]
    fn tampered_manifest_bytes_are_rejected() {
        let mut bytes = FULL_MANIFEST.as_bytes().to_vec();
        bytes[10] ^= 0x01;
        assert!(verify_with_pubkey(&bytes, FULL_MANIFEST_SIG, MANIFEST_PUBKEY).is_err());
    }

    #[test]
    fn manifest_signed_by_another_key_is_rejected() {
        // The production UPDATE_PUBKEY did not sign this fixture.
        assert!(
            verify_with_pubkey(FULL_MANIFEST.as_bytes(), FULL_MANIFEST_SIG, UPDATE_PUBKEY).is_err()
        );
    }

    #[test]
    fn parse_manifest_rejects_garbage_and_missing_fields() {
        assert!(parse_manifest(b"not json").is_err());
        assert!(parse_manifest(b"{}").is_err());
        let no_channel = r#"{"architecture":"x86_64","file":"x.exe","length":1,"repository":"LiuTouo/Mnemark","sha256":"ab","version":"0.9.0"}"#;
        assert!(parse_manifest(no_channel.as_bytes()).is_err());
    }

    #[test]
    fn version_binding_rejects_an_old_artifact_under_a_new_tag() {
        // The replay: a release writer re-uploads a genuinely signed old
        // manifest under a newer tag. The tag is unsigned and the backend
        // never sees it — only the version INSIDE the manifest counts.
        let mut old = valid_manifest();
        old.version = "0.8.0".to_string();
        assert!(check_manifest(&old, "0.8.0").is_err());
        old.version = "0.7.9".to_string();
        assert!(check_manifest(&old, "0.8.0").is_err());
    }

    #[test]
    fn field_bindings_reject_wrong_repository_channel_and_architecture() {
        let mut wrong = valid_manifest();
        wrong.repository = "EvilCorp/Mnemark".to_string();
        assert!(check_manifest(&wrong, "0.8.0").is_err());

        wrong = valid_manifest();
        wrong.channel = "installed".to_string();
        assert!(check_manifest(&wrong, "0.8.0").is_err());

        wrong = valid_manifest();
        wrong.architecture = "aarch64".to_string();
        assert!(check_manifest(&wrong, "0.8.0").is_err());

        // File-name binding: any name other than the convention for this
        // version is rejected — including path escapes like "../x.exe",
        // which could otherwise redirect the artifact fetch.
        wrong = valid_manifest();
        wrong.file = "other.exe".to_string();
        assert!(check_manifest(&wrong, "0.8.0").is_err());

        wrong = valid_manifest();
        wrong.file = "../Mnemark_v0.9.0_x64-portable.exe".to_string();
        assert!(check_manifest(&wrong, "0.8.0").is_err());
    }

    #[test]
    fn digest_binding_rejects_a_swapped_or_truncated_artifact() {
        let manifest = valid_manifest();

        // Same length, different bytes: a valid signature over DIFFERENT
        // bytes must not make this artifact pass.
        let mut swapped = TEST_DATA.to_vec();
        swapped[0] ^= 0xFF;
        assert!(verify_artifact(&swapped, &manifest).is_err());

        let truncated = &TEST_DATA[..TEST_DATA.len() - 1];
        assert!(verify_artifact(truncated, &manifest).is_err());

        assert!(verify_artifact(TEST_DATA, &manifest).is_ok());
    }

    #[test]
    fn artifact_url_is_derived_from_the_verified_manifest() {
        assert_eq!(
            artifact_url(&valid_manifest()).unwrap(),
            "https://github.com/LiuTouo/Mnemark/releases/download/v0.9.0/Mnemark_v0.9.0_x64-portable.exe"
        );
    }

    #[test]
    fn cmp_version_compares_numerically_and_tolerates_a_v_prefix() {
        use std::cmp::Ordering;
        assert_eq!(cmp_version("0.9.0", "0.8.0"), Ordering::Greater);
        assert_eq!(cmp_version("v0.9.0", "0.9.0"), Ordering::Equal);
        assert_eq!(cmp_version("1.2.3", "1.2.10"), Ordering::Less);
        assert_eq!(cmp_version("1.2", "1.2.0"), Ordering::Equal);
    }
}
