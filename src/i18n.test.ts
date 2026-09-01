import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localizeBackendError, localizeLocatedClipError, setLanguage } from "./i18n";
import { LocatedClipFacade, type LocatedClipDependencies } from "./located-clip";
import type { ClipLocator } from "./types";

function rejectingFacade(code: string): LocatedClipFacade {
  const dependencies: LocatedClipDependencies = {
    invoke: vi.fn(async () => {
      throw { code, detail: null };
    }),
    publishHistoryNote: vi.fn(),
    refreshDrawer: vi.fn(async () => true),
    presentCopyOutcome: vi.fn(),
    isPreviewActive: vi.fn(() => false),
    reportDiagnostic: vi.fn(),
  };
  return new LocatedClipFacade(dependencies);
}

describe("located Clip error localization", () => {
  beforeEach(() => {
    vi.stubGlobal("document", { documentElement: { lang: "" } });
    setLanguage("zh-TW");
  });

  afterEach(() => vi.unstubAllGlobals());

  it("maps source-independent not-found errors without parsing an origin", () => {
    expect(localizeBackendError("located_clip.not_found")).toBe("項目已不存在");
  });

  it("preserves the fallback for unknown backend errors", () => {
    expect(localizeBackendError("unmapped failure")).toBe("unmapped failure");
  });

  it("maps every structured action error category through one decoder", () => {
    expect(localizeLocatedClipError({ code: "clipboard_write", detail: null }, "copyFailed"))
      .toBe("複製失敗，請重試（剪貼簿可能被其他程式佔用）");
    expect(localizeLocatedClipError({ code: "preview_disabled", detail: null }))
      .toBe("預覽功能已停用");
    expect(localizeLocatedClipError({ code: "preview_publication", detail: null }))
      .toBe("無法更新預覽");
  });

  it.each<ClipLocator>([
    { scope: "history", id: "missing-history" },
    { scope: "drawer", id: "missing-drawer" },
  ])("localizes $scope not-found after wire and facade decoding", async (locator) => {
    const error = await rejectingFacade("not_found").paste(locator).catch((failure) => failure);

    expect(localizeLocatedClipError(error)).toBe("項目已不存在");
  });

  it("localizes Drawer unavailable after wire and facade decoding", async () => {
    const error = await rejectingFacade("drawer_unavailable")
      .copy({ scope: "drawer", id: "snapshot" })
      .catch((failure) => failure);

    expect(localizeLocatedClipError(error)).toBe("抽屜暫時無法使用");
  });

  it("localizes History persistence failure after wire and facade decoding", async () => {
    const error = await rejectingFacade("history_persistence")
      .setNote({ scope: "history", id: "clip" }, "memo")
      .catch((failure) => failure);

    expect(localizeLocatedClipError(error)).toBe("歷史備註無法儲存");
  });
});
