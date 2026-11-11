/** Pure geometry for mouse marquee selection over list rows. */

export interface MarqueeRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Screen-space rectangle spanned by a drag, in any direction. */
export function marqueeRect(
  start: { x: number; y: number },
  end: { x: number; y: number },
): MarqueeRect {
  return {
    left: Math.min(start.x, end.x),
    top: Math.min(start.y, end.y),
    right: Math.max(start.x, end.x),
    bottom: Math.max(start.y, end.y),
  };
}

/** Clip a marquee to the visible list box; null when nothing is left. */
export function clipRect(rect: MarqueeRect, bounds: MarqueeRect): MarqueeRect | null {
  const left = Math.max(rect.left, bounds.left);
  const top = Math.max(rect.top, bounds.top);
  const right = Math.min(rect.right, bounds.right);
  const bottom = Math.min(rect.bottom, bounds.bottom);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

/** Ids of every row the marquee touches (edge contact alone does not count). */
export function idsInRect(
  rect: MarqueeRect,
  rows: readonly { id: string; rect: MarqueeRect }[],
): string[] {
  if (rect.right <= rect.left || rect.bottom <= rect.top) return [];
  return rows
    .filter((row) => row.rect.right > rect.left
      && row.rect.left < rect.right
      && row.rect.bottom > rect.top
      && row.rect.top < rect.bottom)
    .map((row) => row.id);
}
