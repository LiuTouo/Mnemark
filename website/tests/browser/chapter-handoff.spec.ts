import { test, expect } from "@playwright/test";

test("previous lesson stays still while the next lesson slides up over it", async ({
  page,
}) => {
  await page.goto("./");
  await page.evaluate(() => document.fonts.ready);
  const previous = page.locator("#feature-search .feature-stage");
  const next = page.locator("#feature-drawers .feature-stage");
  const top = await page
    .locator("#feature-drawers")
    .evaluate((el) => el.getBoundingClientRect().top + scrollY);
  for (const gap of [550, 300, 88]) {
    await page.evaluate((y) => scrollTo(0, y), top - gap);
    await page.waitForTimeout(100);
    expect(
      await previous.evaluate((el) => el.getBoundingClientRect().top),
    ).toBeCloseTo(88, 0);
    expect(
      await next.evaluate((el) => el.getBoundingClientRect().top),
    ).toBeCloseTo(gap, 0);
    // The entering lesson must be the actual topmost surface below its leading edge.
    const covering = await next.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return document
        .elementFromPoint(20, Math.min(innerHeight - 20, rect.top + 20))
        ?.closest(".feature-chapter")?.id;
    });
    expect(covering).toBe("feature-drawers");
  }
  // Reverse scrolling reveals the previous lesson in the same fixed location.
  await page.evaluate((y) => scrollTo(0, y), top - 300);
  await page.waitForTimeout(100);
  expect(
    await previous.evaluate((el) => el.getBoundingClientRect().top),
  ).toBeCloseTo(88, 0);
});

test("demo operation playback lasts eleven seconds before looping", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./#feature-search");
  const chapter = page.locator("#feature-search");
  await chapter.locator("[data-play]").scrollIntoViewIfNeeded();
  await chapter.locator("[data-replay]").click();
  await page.waitForTimeout(2500);
  const progress = Number(await chapter.getAttribute("data-progress"));
  expect(progress).toBeGreaterThan(0.18);
  expect(progress).toBeLessThan(0.29);
});

test("the stack releases after the last lesson and rebuilds after a mobile resize", async ({
  page,
}) => {
  await page.goto("./#for-you");
  await page.evaluate(() => document.fonts.ready);
  const covering = await page.evaluate(
    () => document.elementFromPoint(30, 200)?.closest(".feature-chapter")?.id,
  );
  expect(covering).toBeUndefined();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".feature-chapters .pin-spacer")).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator(".feature-chapters .pin-spacer")).toHaveCount(7);
  await page
    .locator("#feature-drawers")
    .evaluate((el) =>
      scrollTo(0, el.getBoundingClientRect().top + scrollY - 300),
    );
  await page.waitForTimeout(100);
  expect(
    await page
      .locator("#feature-search .feature-stage")
      .evaluate((el) => el.getBoundingClientRect().top),
  ).toBeCloseTo(88, 0);
});
