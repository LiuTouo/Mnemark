import type { ClipLocator } from "./types";

export type LocatedClipCommand = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

export type CopyOutcome = "copied" | "missing-files-text-fallback";

const LOCATED_CLIP_ERROR_CODE_VALUES = [
  "not_found",
  "drawer_unavailable",
  "history_persistence",
  "missing_content",
  "deferred_expired",
  "clipboard_write",
  "preview_disabled",
  "preview_publication",
  "drawer_mutation",
] as const;

export type LocatedClipErrorCode = typeof LOCATED_CLIP_ERROR_CODE_VALUES[number];

const LOCATED_CLIP_ERROR_CODES = new Set<string>(LOCATED_CLIP_ERROR_CODE_VALUES);

export class LocatedClipCommandError extends Error {
  constructor(
    readonly code: LocatedClipErrorCode,
    readonly detail: string | null,
  ) {
    super(code);
    this.name = "LocatedClipCommandError";
  }
}

function decodeCommandError(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return error;
  const candidate = error as { code?: unknown; detail?: unknown };
  if (typeof candidate.code !== "string"
    || !LOCATED_CLIP_ERROR_CODES.has(candidate.code)) return error;
  return new LocatedClipCommandError(
    candidate.code as LocatedClipErrorCode,
    typeof candidate.detail === "string" ? candidate.detail : null,
  );
}

export type NoteCompletion =
  | { status: "published"; note: string | null }
  | { status: "committed-stale"; note: string | null };

export interface LocatedClipDependencies {
  invoke: LocatedClipCommand;
  publishHistoryNote(id: string, note: string | null): void;
  refreshDrawer(): Promise<boolean>;
  presentCopyOutcome(outcome: CopyOutcome): void;
  isPreviewActive(locator: ClipLocator): boolean;
  reportDiagnostic(context: string, error: unknown): void;
}

/**
 * Frontend interface for actions targeting either History or Drawer content.
 * Origin-specific publication stays behind this facade; Panel callers only
 * provide a locator and the behavior-specific input.
 */
export class LocatedClipFacade {
  constructor(private readonly dependencies: LocatedClipDependencies) {}

  async paste(locator: ClipLocator): Promise<void> {
    await this.command("paste_located_clip", { locator });
  }

  async copy(locator: ClipLocator): Promise<void> {
    const outcome = await this.command("copy_located_clip", { locator }) as CopyOutcome;
    this.dependencies.presentCopyOutcome(outcome);
  }

  async preview(locator: ClipLocator): Promise<void> {
    await this.command("show_located_clip_preview", { locator });
  }

  async setNote(locator: ClipLocator, note: string): Promise<NoteCompletion> {
    const committedNote = await this.command("set_located_clip_note", {
      locator,
      note,
    }) as string | null;

    let status: NoteCompletion["status"] = "published";
    if (locator.scope === "history") {
      this.dependencies.publishHistoryNote(locator.id, committedNote);
    } else if (!await this.dependencies.refreshDrawer()) {
      status = "committed-stale";
    }

    if (this.dependencies.isPreviewActive(locator)) {
      void this.preview(locator).catch((error) => {
        this.dependencies.reportDiagnostic("Failed to refresh preview note", error);
      });
    }

    return { status, note: committedNote };
  }

  private async command(command: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.dependencies.invoke(command, args);
    } catch (error) {
      throw decodeCommandError(error);
    }
  }
}
