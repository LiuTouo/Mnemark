import { test, expect } from "@playwright/test";

for (const [feature, minimum] of [
  ["capture", 1],
  ["search", 1],
  ["drawers", 2],
  ["pin", 2],
  ["preview", 3],
  ["batch", 6],
  ["settings", 3],
] as const) {
  test(`${feature} clicks land on the actual displayed controls`, async ({
    page,
  }) => {
    await page.goto(`./#feature-${feature}`);
    await page.evaluate(() => document.fonts.ready);
    const result = await page
      .locator(`#feature-${feature}`)
      .evaluate(async (chapter) => {
        const actions = new Set<string>();
        let maximumError = 0;
        const pointer =
          chapter.querySelector<HTMLElement>(".demo-cue-pointer")!;
        (chapter.querySelector("[data-replay]") as HTMLElement).click();
        const started = performance.now();
        await new Promise<void>((resolve) => {
          const sample = () => {
            if (
              pointer.dataset.kind === "click" &&
              pointer.dataset.pressing === "true"
            ) {
              const target = chapter.querySelector(".cue-target");
              const svg = pointer.querySelector("svg")!;
              if (target) {
                const rect = target.getBoundingClientRect();
                const tip = new DOMPoint(2, 2).matrixTransform(
                  svg.getScreenCTM()!,
                );
                maximumError = Math.max(
                  maximumError,
                  Math.hypot(
                    tip.x - rect.left - rect.width / 2,
                    tip.y - rect.top - rect.height / 2,
                  ),
                );
                actions.add(pointer.dataset.action!);
              }
            }
            if (performance.now() - started < 7400)
              requestAnimationFrame(sample);
            else resolve();
          };
          requestAnimationFrame(sample);
        });
        return { actions: [...actions], maximumError };
      });
    expect(result.actions.length).toBeGreaterThanOrEqual(minimum);
    expect(result.maximumError).toBeLessThan(4);
  });
}

test("search displays every shortcut in the sequence", async ({ page }) => {
  await page.goto("./#feature-search");
  const seen = await page
    .locator("#feature-search")
    .evaluate(async (chapter) => {
      const keys = new Set<string>();
      (chapter.querySelector("[data-replay]") as HTMLElement).click();
      const start = performance.now();
      await new Promise<void>((resolve) => {
        const sample = () => {
          if (chapter.querySelector(".demo-cue-hud.is-pressed")) {
            const combination = [
              ...chapter.querySelectorAll(".demo-cue-hud kbd"),
            ]
              .map((key) => key.textContent)
              .join("+");
            if (combination) keys.add(combination);
          }
          if (performance.now() - start < 7000) requestAnimationFrame(sample);
          else resolve();
        };
        requestAnimationFrame(sample);
      });
      return [...keys];
    });
  expect(seen).toEqual(expect.arrayContaining(["Ctrl+Shift+V", "/"]));
  expect(seen).not.toContain("↓");
  expect(seen).not.toContain("Enter");
});

test("dragging shows a held pointer and the dragged card follows it", async ({
  page,
}) => {
  await page.goto("./#feature-drawers");
  const lesson = page.locator("#feature-drawers");
  await lesson.locator("[data-replay]").click();
  await expect(lesson.locator(".demo-cue-pointer")).toHaveClass(/is-holding/, {
    timeout: 6000,
  });
  const before = await lesson
    .locator(".drag-chip")
    .evaluate((el) => el.getBoundingClientRect().left);
  await page.waitForTimeout(350);
  const after = await lesson
    .locator(".drag-chip")
    .evaluate((el) => el.getBoundingClientRect().left);
  expect(Math.abs(after - before)).toBeGreaterThan(10);
  await expect(lesson.locator(".demo-cue-hud")).toContainText("放開滑鼠", {
    timeout: 3000,
  });
});
