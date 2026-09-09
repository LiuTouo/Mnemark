import { test, expect } from "@playwright/test";

test("background runs by default even with the previous saved preference", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() =>
    localStorage.setItem("mnemark-site-motion", "reduced"),
  );
  await page.goto("./");
  await expect(page.locator(".motion-toggle")).toHaveCount(0);
  const track = page.locator(".cloud-track").first();
  const before = await track.evaluate((el) => getComputedStyle(el).transform);
  await page.waitForTimeout(400);
  expect(await track.evaluate((el) => getComputedStyle(el).transform)).not.toBe(
    before,
  );
});

test("a normal laptop browser viewport plays the demo inside the pinned lesson", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 657 });
  await page.goto("./");
  const chapter = page.locator("#feature-search");
  await chapter.evaluate((el) =>
    scrollTo(0, el.getBoundingClientRect().top + scrollY + 400),
  );
  await expect(chapter).toHaveAttribute("data-progress", /0\.[1-9]/);
  await expect(chapter).toHaveAttribute("data-playing", "true");
  expect(
    await chapter
      .locator(".demo-bottom")
      .evaluate((el) => el.getBoundingClientRect().bottom),
  ).toBeLessThanOrEqual(657);
});

test("Services-style product illustration rises and straightens before the demo", async ({
  page,
}) => {
  await page.goto("./");
  await page.evaluate(() => document.fonts.ready);
  const chapter = page.locator("#feature-drawers");
  const top = await chapter.evaluate(
    (el) => el.getBoundingClientRect().top + scrollY,
  );
  await page.evaluate((y) => scrollTo(0, y), top - 700);
  await page.waitForTimeout(100);
  const angle = await chapter.locator(".demo-wrap").evaluate((el) => {
    const matrix = new DOMMatrix(getComputedStyle(el).transform);
    return (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI;
  });
  expect(angle).toBeLessThan(-1);
  await page.evaluate((y) => scrollTo(0, y), top - 88);
  await page.waitForTimeout(100);
  const final = await chapter
    .locator(".demo-wrap")
    .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform));
  expect(final.b).toBeCloseTo(0, 2);
  expect(final.f).toBeCloseTo(0, 0);
});

test("each feature opens on its own task instead of the same clipboard list", async ({
  page,
}) => {
  await page.goto("./");
  const startingScenes = await page
    .locator('.feature-chapter .demo-frame[data-frame="0"]')
    .allTextContents();
  expect(
    new Set(startingScenes.map((text) => text.replace(/\s/g, ""))).size,
  ).toBe(7);
});
