import { describe, expect, it, vi } from "vitest";
import { ConfigBootstrap, clampOpacityPercent } from "./config";
import type { AppConfig } from "./config";

describe("ConfigBootstrap", () => {
  it.each([
    [Number.NaN, 99],
    [20, 50],
    [75, 75],
    [140, 100],
  ])("clamps opacity %s to %s", (input, expected) => {
    expect(clampOpacityPercent(input)).toBe(expected);
  });

  it("loads once and applies language, theme, then clamped opacity", async () => {
    const order: string[] = [];
    const config = {
      language: "en",
      theme: "dark",
      ui_opacity_percent: 140,
    } as AppConfig;
    const bootstrap = new ConfigBootstrap({
      load: vi.fn(async () => {
        order.push("load");
        return config;
      }),
      applyLanguage: (language) => order.push(`language:${language}`),
      applyTheme: (theme) => order.push(`theme:${theme}`),
      applyOpacity: (opacity) => order.push(`opacity:${opacity}`),
    });

    await expect(bootstrap.loadAndApply()).resolves.toBe(config);
    expect(order).toEqual(["load", "language:en", "theme:dark", "opacity:100"]);
  });

  it("applies the same ordered defaults before surfacing a load failure", async () => {
    const order: string[] = [];
    const failure = new Error("offline");
    const bootstrap = new ConfigBootstrap({
      load: vi.fn(async () => { throw failure; }),
      applyLanguage: (language) => order.push(`language:${language}`),
      applyTheme: (theme) => order.push(`theme:${theme}`),
      applyOpacity: (opacity) => order.push(`opacity:${opacity}`),
    });

    await expect(bootstrap.loadAndApply()).rejects.toBe(failure);
    expect(order).toEqual(["language:zh-TW", "theme:system", "opacity:99"]);
  });

  it("does not apply a load superseded by a newer bootstrap", async () => {
    const effects = vi.fn();
    let current = true;
    const config = { language: "en", theme: "dark", ui_opacity_percent: 80 } as AppConfig;
    const bootstrap = new ConfigBootstrap({
      load: vi.fn(async () => config),
      applyLanguage: effects,
      applyTheme: effects,
      applyOpacity: effects,
    });
    current = false;

    await expect(bootstrap.loadAndApply(() => current)).resolves.toBe(config);
    expect(effects).not.toHaveBeenCalled();
  });
});
