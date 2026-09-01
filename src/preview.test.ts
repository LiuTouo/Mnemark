import { describe, expect, it, vi } from "vitest";

describe("Preview renderer module", () => {
  it("imports without browser globals or bootstrap side effects", async () => {
    vi.resetModules();
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("window", undefined);

    const previewRenderer = await import("./preview");

    expect(previewRenderer.mountPreview).toBeTypeOf("function");
  });
});
