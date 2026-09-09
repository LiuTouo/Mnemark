import { test, expect } from "@playwright/test";

test("wheel input eases toward its target after the wheel stops", async ({
  page,
}) => {
  await page.goto("./");
  await page.mouse.move(1000, 400);
  await page.mouse.wheel(0, 480);
  await page.waitForTimeout(60);
  const early = await page.evaluate(() => scrollY);
  expect(early).toBeGreaterThan(0);
  expect(early).toBeLessThan(430);
  await page.waitForTimeout(180);
  const coasting = await page.evaluate(() => scrollY);
  expect(coasting).toBeGreaterThan(early + 15);
  await page.waitForTimeout(1100);
  expect(await page.evaluate(() => scrollY)).toBeCloseTo(480, 0);
  await page.mouse.wheel(0, -200);
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => scrollY)).toBeCloseTo(280, 0);
});

test("a chapter link cancels pending wheel inertia instead of snapping back", async ({
  page,
}) => {
  await page.goto("./");
  await page.mouse.move(1000, 400);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(80);
  await page.locator('#site-nav a[href="#features"]').click();
  await page.waitForTimeout(150);
  const target = await page.evaluate(() => scrollY);
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => scrollY)).toBeCloseTo(target, 0);
  expect(
    await page
      .locator("#features")
      .evaluate((el) => el.getBoundingClientRect().top),
  ).toBeCloseTo(110, 0);
});
