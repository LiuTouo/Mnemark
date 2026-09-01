// Inline drag card for the single main WebView. Drawer drag owns session
// freshness; this adapter only renders the visual facts it receives.

import type {
  DrawerDragPoint,
  DrawerDragStart,
  DrawerDragVisual,
} from "./drawer-drag";
import { t } from "./i18n";

const CARD_WIDTH = 288;
const CARD_HEIGHT = 112;
const CURSOR_OFFSET = 14;

export interface InlineDragCard {
  begin(start: Pick<DrawerDragStart<unknown>, "visual" | "x" | "y">): void;
  move(point: DrawerDragPoint): void;
  finish(cancelled: boolean): void;
}

export function createInlineDragCard(card: HTMLElement): InlineDragCard {
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

  function moveCard(point: DrawerDragPoint): void {
    const maxX = Math.max(0, innerWidth - CARD_WIDTH);
    const maxY = Math.max(0, innerHeight - CARD_HEIGHT);
    card.style.left = `${Math.min(maxX, Math.max(0, point.x + CURSOR_OFFSET))}px`;
    card.style.top = `${Math.min(maxY, Math.max(0, point.y + CURSOR_OFFSET))}px`;
  }

  return {
    begin(start): void {
      if (hideTimer) clearTimeout(hideTimer);
      renderVisual(start.visual);
      moveCard(start);
      card.classList.remove("hidden", "dropping", "leaving");
    },
    move(point): void {
      moveCard(point);
    },
    finish(cancelled): void {
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
    },
  };
}
