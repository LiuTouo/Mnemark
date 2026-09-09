import { test, expect } from "@playwright/test";

for (const locale of ["./", "./en/"]) {
  test(`capture copies all three types and filters the matching history: ${locale}`, async ({
    page,
  }) => {
    await page.goto(`${locale}#feature-capture`);
    await page.evaluate(() => document.fonts.ready);
    const lesson = page.locator("#feature-capture");
    const copied = await lesson.evaluate(async (chapter) => {
      const seen = new Set<string>();
      (chapter.querySelector("[data-replay]") as HTMLElement).click();
      const start = performance.now();
      await new Promise<void>((resolve) => {
        const sample = () => {
          for (const frame of chapter.querySelectorAll<HTMLElement>(
            "[data-frame]",
          )) {
            if (Number(getComputedStyle(frame).opacity) < 0.8) continue;
            for (const card of frame.querySelectorAll<HTMLElement>(
              ".copy-source.is-copying",
            )) {
              const original = card.querySelector(".copy-original")!;
              const shortcut = card.querySelector(".copy-shortcut")!;
              if (
                Number(getComputedStyle(original).opacity) < 0.5 &&
                Number(getComputedStyle(shortcut).opacity) > 0.8 &&
                shortcut.textContent === "Ctrl+C"
              ) {
                seen.add(card.dataset.copyKind!);
              }
            }
          }
          if (performance.now() - start < 3900) requestAnimationFrame(sample);
          else resolve();
        };
        requestAnimationFrame(sample);
      });
      return [...seen];
    });
    expect(copied).toEqual(["text", "image", "file"]);
    const history = lesson.locator('[data-frame="2"]');
    await expect(history.locator(".copy-source.is-copied")).toHaveCount(3);
    const text = await history.locator(".source-text p").textContent();
    const file = await history.locator(".copy-filename").textContent();
    const entries = history.locator(".app-row .row-main p");
    await expect(entries).toHaveCount(3);
    expect(await entries.allTextContents()).toEqual([
      file,
      locale === "./" ? "專案靈感.png" : "Project inspiration.png",
      text,
    ]);
    const filtered = lesson.locator('[data-frame="3"]');
    await expect(filtered).toHaveCSS("opacity", "1", { timeout: 4000 });
    await expect(filtered.locator(".app-tabs > span:nth-child(3)")).toHaveClass(
      /selected/,
    );
    await expect(filtered.locator(".app-row")).toHaveCount(1);
    await expect(filtered.locator(".row-selected .kind-image")).toHaveCount(1);
    await expect(filtered.locator(".app-row .row-main p")).toHaveText(
      locale === "./" ? "專案靈感.png" : "Project inspiration.png",
    );
  });
}
