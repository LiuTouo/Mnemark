import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-shell";
import { resourceDir } from "@tauri-apps/api/path";
import { applyI18n, t } from "./i18n";
import { configBootstrap } from "./config";

const REPO = "LiuTouo/Mnemark";

interface UpdateCheck {
  status: string; // "up_to_date" | "available"
  version: string | null;
}

interface GhAsset {
  name: string;
  browser_download_url: string;
}

/** Compare two semver-ish strings ("v1.2.3" or "1.2.3"): >0 if a is newer. */
function cmpSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function setStatus(text: string) {
  document.getElementById("update-status")!.textContent = text;
}

function show(id: string, visible: boolean) {
  document.getElementById(id)!.classList.toggle("hidden", !visible);
}

/** Installed build: check → install → automatic relaunch via the updater plugin. */
async function installedCheck() {
  setStatus(t("checkingUpdate"));
  try {
    const result = await invoke<UpdateCheck>("check_for_updates");
    if (result.status === "available" && result.version) {
      setStatus(t("updateAvailable", { v: result.version }));
      show("btn-install-update", true);
    } else {
      setStatus(t("updateUpToDate"));
    }
  } catch (err) {
    console.error("Update check failed:", err);
    setStatus(t("updateError"));
  }
}

async function installedInstall() {
  show("btn-install-update", false);
  setStatus(t("installing"));
  try {
    await invoke<string>("install_update");
    // Windows exits during install; this is only a fallback if the platform's
    // updater returns without relaunching.
    show("btn-restart", true);
  } catch (err) {
    console.error("Install failed:", err);
    setStatus(t("updateError"));
  }
}

/** Portable build: GitHub API check → download new exe next to the current
 * one → user quits and overwrites manually (a running exe can't be replaced). */
async function portableCheck() {
  setStatus(t("checkingUpdate"));
  let data: { tag_name: string; assets: GhAsset[] };
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (res.status === 404) {
      setStatus(t("noReleaseYet"));
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.error("Release check failed:", err);
    setStatus(t("updateError"));
    return;
  }

  const current = await getVersion();
  const latest = data.tag_name.replace(/^v/, "");
  if (cmpSemver(latest, current) <= 0) {
    setStatus(t("updateUpToDate"));
    return;
  }

  // CI uploads a signed manifest binding the exe to this repo, an exact
  // version, channel, architecture, and the artifact's file name/length/
  // SHA-256. The backend (download_portable_update) verifies the signature
  // and enforces every binding — including that the manifest version is
  // strictly newer than the running one — so the tag check above is only a
  // cheap pre-filter, not the trust decision.
  const manifest = data.assets.find((a) => a.name.endsWith(".manifest.json"));
  if (!manifest) {
    setStatus(t("portableManifestMissing"));
    return;
  }

  setStatus(t("updateAvailable", { v: latest }));
  await portableDownload(manifest);
}

/** The actual download runs in Rust (update::download_portable_update):
 * GitHub's asset CDN omits CORS headers, so webview fetch always fails. */
async function portableDownload(manifest: GhAsset) {
  setStatus(t("downloadingUpdate"));
  try {
    const path = await invoke<string>("download_portable_update", {
      manifestUrl: manifest.browser_download_url,
    });
    setStatus(t("portableUpdateReady", { path }));
    show("btn-open-folder", true);
  } catch (err) {
    console.error("Portable download failed:", err);
    setStatus(t("updateError"));
  }
}

async function init() {
  let autoUpdate = true;
  try {
    const config = await configBootstrap.loadAndApply();
    autoUpdate = config.auto_update !== false;
  } catch (_) {}
  applyI18n();
  document.title = t("aboutTitle");

  // Version comes from the single source of truth (Cargo.toml via app config).
  try {
    const version = await getVersion();
    document.getElementById("about-version")!.textContent = `v${version}`;
  } catch (_) {}

  // Open links in the system browser instead of navigating the webview.
  const openLink = async (e: Event, url: string) => {
    e.preventDefault();
    try {
      await open(url);
    } catch (err) {
      console.error("Failed to open link:", err);
    }
  };
  document.getElementById("link-github")!.addEventListener("click", (e) =>
    openLink(e, "https://github.com/LiuTouo/Mnemark")
  );
  document.getElementById("link-changelog")!.addEventListener("click", (e) =>
    openLink(e, "https://github.com/LiuTouo/Mnemark/blob/main/CHANGELOG.md")
  );

  // Update section: the backend reports which channel this binary serves.
  let channel = "portable";
  try {
    channel = await invoke<string>("update_channel");
  } catch (_) {}

  const runCheck = channel === "installed" ? installedCheck : portableCheck;
  document.getElementById("btn-check-update")!.addEventListener("click", () => {
    show("btn-install-update", false);
    show("btn-restart", false);
    show("btn-open-folder", false);
    runCheck();
  });
  document.getElementById("btn-install-update")!.addEventListener("click", installedInstall);
  document.getElementById("btn-restart")!.addEventListener("click", () => invoke("restart_app"));
  document.getElementById("btn-open-folder")!.addEventListener("click", async () => {
    try {
      await open(await resourceDir());
    } catch (err) {
      console.error("Failed to open folder:", err);
    }
  });

  // Auto-check on open when enabled (installed builds also get a background
  // updater pass at app startup; this just surfaces the result here).
  if (autoUpdate) runCheck();
}

window.addEventListener("DOMContentLoaded", init);
