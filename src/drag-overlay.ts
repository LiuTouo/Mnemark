// Inline drag card for the single main WebView. Drawer drag owns session
// freshness; this adapter only renders the visual facts it receives.

import { invoke } from "@tauri-apps/api/core";
import type {
  DrawerDragPoint,
  DrawerDragStart,
  DrawerDragVisual,
} from "./drawer-drag";
import { setLanguage, t } from "./i18n";
import { applyTheme } from "./theme";

interface AppConfig {
  language?: string;
  theme?: string;
}

const CARD_WIDTH = 288;
const CARD_HEIGHT = 112;
const CURSOR_OFFSET = 14;
const card = document.getElementById("drag-overlay-card")!;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

function renderVisual(visual: DrawerDragVisual): void {
  card.replaceChildren();
  const visualEl = document.createElement("div");
  if (visual.kind === "Image" && visual.thumbnailBase64) {
    visualEl.className = "item-drag-preview-visual image";
    const image = document.createElement("img");
    image.src = visual.thumbnailBase64;
    image.alt = "";
    visualEl.append(image);
  } else {
    visualEl.className = "item-drag-preview-visual kind";
    visualEl.textContent = visual.kind === "FilePaths" ? "F" : "T";
  }
  const copy = document.createElement("div");
  copy.className = "item-drag-preview-copy";
  const label = document.createElement("span");
  label.className = "item-drag-preview-label";
  label.textContent = t("draggingItem");
  const preview = document.createElement("span");
  preview.className = "item-drag-preview-text";
  preview.textContent = visual.preview || t("emptyPreview");
  copy.append(label, preview);
  const add = document.createElement("span");
  add.className = "item-drag-preview-add";
  add.textContent = "+";
  card.append(visualEl, copy, add);
}

function moveCard(point: { x: number; y: number }): void {
  const maxX = Math.max(0, innerWidth - CARD_WIDTH);
  const maxY = Math.max(0, innerHeight - CARD_HEIGHT);
  card.style.left = `${Math.min(maxX, Math.max(0, point.x + CURSOR_OFFSET))}px`;
  card.style.top = `${Math.min(maxY, Math.max(0, point.y + CURSOR_OFFSET))}px`;
}

export function beginInlineDragCard(
  start: Pick<DrawerDragStart<unknown>, "visual" | "x" | "y">,
): void {
  if (hideTimer) clearTimeout(hideTimer);
  renderVisual(start.visual);
  moveCard(start);
  card.classList.remove("hidden", "dropping", "leaving");
}

export function moveInlineDragCard(point: DrawerDragPoint): void {
  moveCard(point);
}

export function finishInlineDragCard(cancelled: boolean): void {
  if (hideTimer) clearTimeout(hideTimer);
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (cancelled || reduceMotion) {
    card.classList.add("hidden");
    card.classList.remove("dropping", "leaving");
    return;
  }
  card.classList.add("dropping");
  hideTimer = setTimeout(() => {
    card.classList.add("hidden");
    card.classList.remove("dropping", "leaving");
  }, 180);
}

async function init(): Promise<void> {
  try {
    const config = await invoke<AppConfig>("get_config");
    setLanguage(config.language || "zh-TW");
    applyTheme(config.theme || "system");
  } catch {
    setLanguage("zh-TW");
  }
}

window.addEventListener("DOMContentLoaded", () => { void init(); });
