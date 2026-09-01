import { describe, expect, it, vi } from "vitest";
import {
  LocatedClipCommandError,
  LocatedClipFacade,
  type LocatedClipDependencies,
} from "./located-clip";
import type { ClipLocator } from "./types";

function dependencies() {
  const values: LocatedClipDependencies = {
    invoke: vi.fn(async () => undefined),
    publishHistoryNote: vi.fn(),
    refreshDrawer: vi.fn(async () => true),
    presentCopyOutcome: vi.fn(),
    isPreviewActive: vi.fn(() => false),
    reportDiagnostic: vi.fn(),
  };
  return values;
}

describe("LocatedClipFacade", () => {
  it.each<ClipLocator>([
    { scope: "history", id: "clip-a" },
    { scope: "drawer", id: "hash-b" },
  ])("routes $scope paste through the located Clip command", async (locator) => {
    const deps = dependencies();
    const locatedClip = new LocatedClipFacade(deps);

    await locatedClip.paste(locator);

    expect(deps.invoke).toHaveBeenCalledWith("paste_located_clip", { locator });
  });

  it("presents the backend copy outcome without exposing origin or kind to the caller", async () => {
    const deps = dependencies();
    vi.mocked(deps.invoke).mockResolvedValueOnce("missing-files-text-fallback");
    const locatedClip = new LocatedClipFacade(deps);
    const locator = { scope: "drawer", id: "hash-files" } satisfies ClipLocator;

    await locatedClip.copy(locator);

    expect(deps.invoke).toHaveBeenCalledWith("copy_located_clip", { locator });
    expect(deps.presentCopyOutcome).toHaveBeenCalledWith("missing-files-text-fallback");
  });

  it("uses one preview command for a Drawer locator", async () => {
    const deps = dependencies();
    const locatedClip = new LocatedClipFacade(deps);
    const locator = { scope: "drawer", id: "hash-preview" } satisfies ClipLocator;

    await locatedClip.preview(locator);

    expect(deps.invoke).toHaveBeenCalledWith("show_located_clip_preview", { locator });
  });

  it("publishes a History note and refreshes the active preview through the same facade", async () => {
    const deps = dependencies();
    vi.mocked(deps.invoke).mockResolvedValueOnce("memo").mockResolvedValueOnce(undefined);
    vi.mocked(deps.isPreviewActive).mockReturnValue(true);
    const locatedClip = new LocatedClipFacade(deps);
    const locator = { scope: "history", id: "clip-note" } satisfies ClipLocator;

    await expect(locatedClip.setNote(locator, "memo")).resolves.toEqual({
      status: "published",
      note: "memo",
    });

    expect(deps.publishHistoryNote).toHaveBeenCalledWith("clip-note", "memo");
    expect(deps.refreshDrawer).not.toHaveBeenCalled();
    expect(deps.invoke).toHaveBeenNthCalledWith(2, "show_located_clip_preview", { locator });
  });

  it.each([
    [true, "published"],
    [false, "committed-stale"],
  ] as const)("maps a Drawer note barrier result to %s=%s", async (fresh, status) => {
    const deps = dependencies();
    vi.mocked(deps.invoke).mockResolvedValueOnce(null);
    vi.mocked(deps.refreshDrawer).mockResolvedValueOnce(fresh);
    const locatedClip = new LocatedClipFacade(deps);
    const locator = { scope: "drawer", id: "hash-note" } satisfies ClipLocator;

    await expect(locatedClip.setNote(locator, "  ")).resolves.toEqual({ status, note: null });

    expect(deps.refreshDrawer).toHaveBeenCalledOnce();
    expect(deps.publishHistoryNote).not.toHaveBeenCalled();
  });

  it("does not publish when the note command fails", async () => {
    const deps = dependencies();
    const failure = new Error("located_clip.history_persistence");
    vi.mocked(deps.invoke).mockRejectedValueOnce(failure);
    const locatedClip = new LocatedClipFacade(deps);
    const locator = { scope: "history", id: "clip-note" } satisfies ClipLocator;

    await expect(locatedClip.setNote(locator, "memo")).rejects.toBe(failure);

    expect(deps.publishHistoryNote).not.toHaveBeenCalled();
    expect(deps.refreshDrawer).not.toHaveBeenCalled();
  });

  it("does not refresh preview when another locator is active", async () => {
    const deps = dependencies();
    vi.mocked(deps.invoke).mockResolvedValueOnce("memo");
    const locatedClip = new LocatedClipFacade(deps);
    const locator = { scope: "history", id: "clip-note" } satisfies ClipLocator;

    await locatedClip.setNote(locator, "memo");

    expect(deps.invoke).toHaveBeenCalledOnce();
    expect(deps.isPreviewActive).toHaveBeenCalledWith(locator);
  });

  it("decodes structured command failures once for every facade behavior", async () => {
    const deps = dependencies();
    vi.mocked(deps.invoke).mockRejectedValueOnce({
      code: "missing_content",
      detail: "raw image unavailable",
    });
    const locatedClip = new LocatedClipFacade(deps);

    const failure = await locatedClip
      .copy({ scope: "drawer", id: "broken-image" })
      .catch((error) => error);

    expect(failure).toBeInstanceOf(LocatedClipCommandError);
    expect(failure).toMatchObject({
      code: "missing_content",
      detail: "raw image unavailable",
    });
    expect(deps.presentCopyOutcome).not.toHaveBeenCalled();
  });
});
