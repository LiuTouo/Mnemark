import { describe, expect, it } from "vitest";
import { clipLocator, isFavoriteItem } from "./drag";
import type { Clip, FavoriteItem } from "./types";

function clipFixture(id: string): Clip {
  return {
    id,
    kind: "Text",
    text_content: null,
    file_paths: null,
    thumbnail_base64: null,
    content_hash: id,
    preview: "",
    note: null,
    truncated: false,
    source_exe: "",
    source_title: "",
    source_icon: null,
    captured_at: 0,
    pinned: false,
    byte_size: 0,
  };
}

function favoriteFixture(id: string): FavoriteItem {
  return {
    origin: "favorite",
    id,
    kind: "Text",
    text_content: null,
    file_paths: null,
    thumbnail_base64: null,
    content_hash: id,
    preview: "",
    note: null,
    truncated: false,
    source_exe: "",
    source_title: "",
    source_icon: null,
    captured_at: 0,
    byte_size: 0,
    added_at: null,
  };
}

describe("clipLocator", () => {
  it("maps a history Clip to a history locator", () => {
    expect(clipLocator(clipFixture("clip-a"))).toEqual({ scope: "history", id: "clip-a" });
  });
  it("maps a FavoriteItem to a Drawer snapshot locator", () => {
    expect(clipLocator(favoriteFixture("hash-x"))).toEqual({ scope: "drawer", id: "hash-x" });
  });
});

describe("isFavoriteItem", () => {
  it("classifies a Clip as history even if it lacked the pinned field", () => {
    // Regression: the old guard inferred favorites from `!("pinned" in item)`,
    // so a Clip that dropped `pinned` silently became a Drawer snapshot.
    const pinless = { ...clipFixture("clip-b"), pinned: undefined } as unknown as Clip;
    expect(isFavoriteItem(pinless)).toBe(false);
  });
});
