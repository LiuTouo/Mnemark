import { describe, expect, it } from "vitest";
import { HistoryModule, type HistorySource } from "./history-module";
import type { Clip, ClipboardUpdate } from "./types";

function clip(id: string, overrides: Partial<Clip> = {}): Clip {
  return {
    id,
    kind: "Text",
    text_content: id,
    file_paths: null,
    thumbnail_base64: null,
    content_hash: `hash-${id}`,
    preview: id,
    note: null,
    truncated: false,
    source_exe: "source.exe",
    source_title: "Source",
    source_icon: null,
    captured_at: 1,
    pinned: false,
    byte_size: 1,
    ...overrides,
  };
}

class MemoryHistorySource implements HistorySource {
  clips: Clip[];
  private undo: Clip[] | null = null;

  constructor(clips: Clip[]) {
    this.clips = clips;
  }

  async read(): Promise<Clip[]> {
    return this.clips.map((item) => ({ ...item }));
  }

  async remove(id: string): Promise<void> {
    this.undo = this.clips.filter((item) => item.id === id).map((item) => ({ ...item }));
    this.clips = this.clips.filter((item) => item.id !== id);
  }

  async restore(id: string): Promise<void> {
    if (!this.undo || this.undo.length !== 1 || this.undo[0].id !== id) throw new Error("Nothing to undo");
    this.clips.push(...this.undo.map((item) => ({ ...item })));
    this.undo = null;
  }

  async removeBatch(ids: readonly string[]): Promise<void> {
    const removed = new Set(ids);
    this.undo = ids
      .map((id) => this.clips.find((item) => item.id === id))
      .filter((item): item is Clip => item !== undefined)
      .map((item) => ({ ...item }));
    this.clips = this.clips.filter((item) => !removed.has(item.id));
  }

  async restoreBatch(ids: readonly string[]): Promise<void> {
    if (!this.undo || this.undo.map((item) => item.id).join() !== [...ids].join()) {
      throw new Error("Nothing to undo");
    }
    this.clips.push(...this.undo.map((item) => ({ ...item })));
    this.undo = null;
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    const item = this.clips.find((candidate) => candidate.id === id);
    if (item) item.pinned = pinned;
  }
}

class ScriptedCaptureFeed {
  constructor(private readonly history: HistoryModule) {}

  play(...updates: ClipboardUpdate[]): void {
    updates.forEach((update) => this.history.applyCapture(update));
  }
}

describe("HistoryModule", () => {
  it("deduplicates a recapture by content hash and refreshes its order and source", async () => {
    const source = new MemoryHistorySource([
      clip("older", { content_hash: "same", captured_at: 10, source_exe: "old.exe" }),
      clip("other", { captured_at: 20 }),
    ]);
    const history = new HistoryModule(source);
    await history.load();

    new ScriptedCaptureFeed(history).play({
      clip: clip("recaptured", {
        content_hash: "same",
        captured_at: 30,
        source_exe: "new.exe",
      }),
      evicted: [],
    });

    expect(history.view.map((item) => item.id)).toEqual(["recaptured", "other"]);
    expect(history.view[0].source_exe).toBe("new.exe");
  });

  it.each([
    ["image count", ["image-oldest"]],
    ["image memory", ["image-large", "image-next"]],
  ])("applies authoritative %s capacity evictions from the capture feed", async (_limit, evicted) => {
    const pinned = clip("pinned", { kind: "Image", pinned: true, captured_at: 1 });
    const source = new MemoryHistorySource([
      pinned,
      clip("image-oldest", { kind: "Image", captured_at: 2 }),
      clip("image-large", { kind: "Image", captured_at: 3, byte_size: 20 }),
      clip("image-next", { kind: "Image", captured_at: 4, byte_size: 10 }),
    ]);
    const history = new HistoryModule(source);
    await history.load();

    new ScriptedCaptureFeed(history).play({
      clip: clip("new-image", { kind: "Image", captured_at: 5 }),
      evicted,
    });

    expect(history.view.map((item) => item.id)).toContain("pinned");
    expect(history.view.map((item) => item.id)).not.toEqual(expect.arrayContaining(evicted));
  });

  it("routes single and batch deletion through one undo shape that reloads the authoritative view", async () => {
    const initial = [clip("a", { captured_at: 3 }), clip("b", { captured_at: 2 }), clip("c")];
    const source = new MemoryHistorySource(initial.map((item) => ({ ...item })));
    const history = new HistoryModule(source);
    await history.load();

    const one = await history.remove("a");
    expect(history.view.map((item) => item.id)).toEqual(["b", "c"]);
    await one!.undo();
    expect(history.view.map((item) => item.id)).toEqual(["a", "b", "c"]);

    const batch = await history.removeBatch(["a", "c"]);
    expect(history.view.map((item) => item.id)).toEqual(["b"]);
    await batch.undo();
    expect(history.view.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("toggles pin through the module and publishes pinned-first order", async () => {
    const source = new MemoryHistorySource([
      clip("newest", { captured_at: 20 }),
      clip("older", { captured_at: 10 }),
    ]);
    const history = new HistoryModule(source);
    await history.load();

    await history.togglePin("older");

    expect(history.view.map((item) => [item.id, item.pinned])).toEqual([
      ["older", true],
      ["newest", false],
    ]);
  });

  it("drops a locally stale item when the backend says it is already gone", async () => {
    const source = new MemoryHistorySource([clip("stale")]);
    source.remove = async () => {
      throw new Error("Clip not found");
    };
    const history = new HistoryModule(source);
    await history.load();

    await expect(history.remove("stale")).resolves.toBeNull();
    expect(history.view).toEqual([]);
  });
});
