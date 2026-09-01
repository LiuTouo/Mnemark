import { describe, expect, it } from "vitest";
import { clipLocator } from "./drag";
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
  it("maps a FavoriteItem to a favorite locator", () => {
    expect(clipLocator(favoriteFixture("hash-x"))).toEqual({ scope: "favorite", id: "hash-x" });
  });
});
