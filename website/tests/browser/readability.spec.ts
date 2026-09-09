import { test, expect } from "@playwright/test";

test("larger text stays readable inside pinned lessons and workflow cards", async ({ page }) => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1366, height: 657 }]) {
    await page.setViewportSize(viewport);
    for (const locale of ["./", "en/"]) {
      await page.goto(locale);
      await page.evaluate(() => document.fonts.ready);
      for (const chapter of await page.locator(".feature-chapter").all()) {
        await chapter.evaluate(el => scrollTo(0, el.getBoundingClientRect().top + scrollY + 150));
        await page.waitForTimeout(60);
        const bounds = await chapter.locator(".feature-story").evaluate(el => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom }));
        expect(bounds.top).toBeGreaterThanOrEqual(88);
        expect(bounds.bottom).toBeLessThanOrEqual(viewport.height);
      }
      await page.locator("#workflows").evaluate(el => scrollTo(0, el.getBoundingClientRect().top + scrollY + 150));
      await page.waitForTimeout(100);
      expect(await page.locator(".workflow-stage").evaluate(el => el.getBoundingClientRect().bottom)).toBeLessThanOrEqual(viewport.height);
    }
  }
});
