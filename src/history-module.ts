// History's frontend orchestration boundary. The Rust aggregate remains the
// authority for persistence and capacity decisions; this module owns the one
// coherent Panel view and every command-driven mutation of that view.

import type { Clip, ClipboardUpdate } from "./types";

export interface HistorySource {
  read(): Promise<Clip[]>;
  remove(id: string): Promise<void>;
  restore(id: string): Promise<void>;
  removeBatch(ids: readonly string[]): Promise<void>;
  restoreBatch(ids: readonly string[]): Promise<void>;
  setPinned(id: string, pinned: boolean): Promise<void>;
}

export interface HistoryUndo {
  undo(): Promise<void>;
}

function ordered(clips: readonly Clip[]): Clip[] {
  return [...clips].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.captured_at - a.captured_at,
  );
}

export class HistoryModule {
  private clips: Clip[] = [];

  constructor(private readonly source: HistorySource) {}

  get view(): readonly Clip[] {
    return this.clips;
  }

  async load(): Promise<void> {
    this.clips = ordered(await this.source.read());
  }

  applyCapture({ clip, evicted }: ClipboardUpdate): void {
    const evictedIds = new Set(evicted);
    this.clips = ordered([
      clip,
      ...this.clips.filter(
        (current) => current.content_hash !== clip.content_hash && !evictedIds.has(current.id),
      ),
    ]);
  }

  async remove(id: string): Promise<HistoryUndo | null> {
    try {
      await this.source.remove(id);
    } catch (error) {
      if (!String(error).includes("Clip not found")) throw error;
      this.clips = this.clips.filter((clip) => clip.id !== id);
      return null;
    }
    this.clips = this.clips.filter((clip) => clip.id !== id);
    return this.undoWith(() => this.source.restore(id));
  }

  async removeBatch(ids: readonly string[]): Promise<HistoryUndo> {
    await this.source.removeBatch(ids);
    const removed = new Set(ids);
    this.clips = this.clips.filter((clip) => !removed.has(clip.id));
    return this.undoWith(() => this.source.restoreBatch(ids));
  }

  async togglePin(id: string): Promise<void> {
    const clip = this.clips.find((candidate) => candidate.id === id);
    if (!clip) return;
    const pinned = !clip.pinned;
    await this.source.setPinned(id, pinned);
    this.clips = ordered(this.clips.map((candidate) => (
      candidate.id === id ? { ...candidate, pinned } : candidate
    )));
  }

  publishNote(id: string, note: string | null): void {
    this.clips = this.clips.map((clip) => clip.id === id ? { ...clip, note } : clip);
  }

  private undoWith(restore: () => Promise<void>): HistoryUndo {
    return {
      undo: async () => {
        await restore();
        await this.load();
      },
    };
  }
}
