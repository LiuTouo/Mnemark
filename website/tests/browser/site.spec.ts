import { test, expect } from "@playwright/test";

test("hero duplicate tracks meet without a jump at the loop seam", async ({
  page,
}) => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("./");
    await page.evaluate(() => document.fonts.ready);
    const seams = await page.locator(".cloud-track").evaluateAll((tracks) =>
      tracks.map((track) => {
        const items = track.children;
        return Math.abs(
          (track as HTMLElement).offsetHeight / 2 -
            ((items[3] as HTMLElement).offsetTop -
              (items[0] as HTMLElement).offsetTop),
        );
      }),
    );
    seams.forEach((seam) => expect(seam).toBeLessThanOrEqual(1));
  }
});

test("both static locales expose all seven chapters and real download destinations", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const route of ["./", "en/"]) {
    await page.goto(route);
    await expect(page.locator("h1")).toHaveText("Mnemark.");
    await expect(page.locator(".feature-chapter")).toHaveCount(7);
    await expect(page.locator(".workflow-card")).toHaveCount(4);
    expect(
      await page
        .locator(".brand img")
        .evaluate(
          (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
        ),
    ).toBe(true);
    await expect(page.locator(".button-primary").first()).toHaveAttribute(
      "href",
      /^https:\/\/github.com\/LiuTouo\/Mnemark\/releases\//,
    );
    await page.locator(".all-features summary").click();
    await expect(page.locator(".facts-grid")).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      /liutouo\.github\.io\/Mnemark\//,
    );
  }
  expect(errors).toEqual([]);
});

test("each visible lesson autoplays without a scroll-controlled playhead", async ({
  page,
}) => {
  await page.goto("./");
  await page.evaluate(() => document.fonts.ready);
  for (const chapter of await page.locator(".feature-chapter").all()) {
    await chapter.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await expect(chapter).toHaveAttribute("data-playing", "true");
    await page.waitForTimeout(250);
    expect(Number(await chapter.getAttribute("data-progress"))).toBeGreaterThan(
      0,
    );
    const opacity = await chapter
      .locator(".demo-frame")
      .evaluateAll((frames) =>
        frames.reduce(
          (sum, el) => sum + Number(getComputedStyle(el).opacity),
          0,
        ),
      );
    expect(opacity).toBeCloseTo(1, 1);
  }
});

test("demo panel chrome stays inside the illustration on desktop and mobile", async ({
  page,
}) => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("./");
    await page.evaluate(() => document.fonts.ready);
    const clipped = await page
      .locator(".feature-chapter")
      .evaluateAll((chapters) =>
        chapters.flatMap((chapter) => {
          const canvas = chapter
            .querySelector(".demo-canvas")!
            .getBoundingClientRect();
          return [...chapter.querySelectorAll(".app-panel")]
            .filter(
              (panel) =>
                panel.getBoundingClientRect().bottom > canvas.bottom + 1,
            )
            .map(() => chapter.id);
        }),
      );
    expect(clipped).toEqual([]);
  }
});

test("language switch preserves the current feature chapter", async ({
  page,
}) => {
  await page.goto("./#feature-drawers");
  await expect(page.locator(".locale-link")).toHaveAttribute(
    "href",
    /en\/#feature-drawers$/,
  );
  await page.locator(".locale-link").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page).toHaveURL(/en\/#feature-drawers$/);
});

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 360, height: 800 },
]) {
  test(`responsive page has no viewport overflow at ${viewport.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("en/");
    await page.evaluate(() => document.fonts.ready);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    if (viewport.width < 1100) {
      await page.locator(".menu-toggle").click();
      await expect(page.locator("#site-nav")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator(".menu-toggle")).toBeFocused();
      await expect(page.locator("#site-nav")).not.toBeVisible();
    }
  });
}

test("mobile demos can pause their autoplay and workflow controls reach the end", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./#feature-search");
  const chapter = page.locator("#feature-search");
  await chapter.locator("[data-play]").scrollIntoViewIfNeeded();
  await page.waitForTimeout(1900);
  expect(Number(await chapter.getAttribute("data-progress"))).toBeGreaterThan(
    0.15,
  );
  await chapter.locator("[data-play]").click();
  const progress = await chapter.getAttribute("data-progress");
  await page.waitForTimeout(200);
  expect(await chapter.getAttribute("data-progress")).toBe(progress);
  await page.locator("[data-next]").scrollIntoViewIfNeeded();
  for (let i = 0; i < 3; i++) {
    await page.locator("[data-next]").click();
    await page.waitForTimeout(500);
  }
  await expect(page.locator("[data-next]")).toBeDisabled();
  await expect(page.locator(".workflow-controls > span")).toHaveText("04 — 04");
});

test("without JavaScript both locales remain readable and downloadable", async ({
  browser,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  for (const route of ["", "en/"]) {
    await page.goto(`http://127.0.0.1:4173/Mnemark/${route}`);
    await expect(page.locator(".feature-chapter")).toHaveCount(7);
    await expect(page.locator(".button-primary").first()).toBeVisible();
    await page.locator(".all-features summary").click();
    await expect(page.locator(".facts-grid")).toBeVisible();
  }
  await context.close();
});
