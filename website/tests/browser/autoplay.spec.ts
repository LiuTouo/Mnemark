import { test, expect } from "@playwright/test";

test("desktop demo advances without scrolling and scrolling does not seek it", async ({
  page,
}) => {
  await page.goto("./#feature-search");
  await page.evaluate(() => document.fonts.ready);
  const lesson = page.locator("#feature-search");
  const before = Number(await lesson.getAttribute("data-progress"));
  const scroll = await page.evaluate(() => scrollY);
  await page.waitForTimeout(600);
  const advancing = Number(await lesson.getAttribute("data-progress"));
  expect(advancing - before).toBeGreaterThan(0.025);
  expect(await page.evaluate(() => scrollY)).toBe(scroll);
  await page.evaluate(() => scrollBy(0, 500));
  await page.waitForTimeout(100);
  const forward = Number(await lesson.getAttribute("data-progress"));
  expect(forward - advancing).toBeLessThan(0.07);
  await page.evaluate(() => scrollBy(0, -500));
  await page.waitForTimeout(100);
  expect(
    Number(await lesson.getAttribute("data-progress")),
  ).toBeGreaterThanOrEqual(forward);
});

test("demo loops automatically with no blank frame at the seam", async ({
  page,
}) => {
  await page.goto("./#feature-search");
  const lesson = page.locator("#feature-search");
  await expect(lesson).toHaveAttribute("data-cycle", "2", { timeout: 15000 });
  for (let i = 0; i < 5; i++) {
    const opacity = await lesson
      .locator(".demo-frame")
      .evaluateAll((frames) =>
        frames.reduce(
          (sum, frame) => sum + Number(getComputedStyle(frame).opacity),
          0,
        ),
      );
    expect(opacity).toBeGreaterThan(0.9);
    expect(opacity).toBeLessThan(1.1);
    await page.waitForTimeout(50);
  }
});

test("mobile autoplays and resumes its position after leaving the viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./#feature-search");
  const lesson = page.locator("#feature-search");
  await lesson.locator(".demo-canvas").scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  expect(Number(await lesson.getAttribute("data-progress"))).toBeGreaterThan(
    0.025,
  );
  await page.locator("#download").evaluate((el) => el.scrollIntoView());
  await page.waitForTimeout(100);
  const paused = Number(await lesson.getAttribute("data-progress"));
  await page.waitForTimeout(400);
  expect(Number(await lesson.getAttribute("data-progress"))).toBe(paused);
  await lesson.locator(".demo-canvas").scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  const resumed = Number(await lesson.getAttribute("data-progress"));
  expect(resumed).toBeGreaterThan(paused);
  expect(resumed - paused).toBeLessThan(0.1);
});
