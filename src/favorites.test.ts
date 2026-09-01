import { describe, expect, it, vi } from "vitest";

describe("Drawer renderer module", () => {
  it("imports without browser globals or bootstrap side effects", async () => {
    vi.resetModules();
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("window", undefined);

    const drawerRenderer = await import("./favorites");

    expect(drawerRenderer.mountDrawerRenderer).toBeTypeOf("function");
  });
});
