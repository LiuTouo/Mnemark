import { test, expect } from "@playwright/test";

test("search result highlights on click and immediately pastes", async ({
  page,
}) => {
  await page.goto("./#feature-search");
  const states = await page
    .locator("#feature-search")
    .evaluate(async (chapter) => {
      const seen = new Set<string>();
      const frame = chapter.querySelector('[data-frame="2"]')!;
      const row = frame.querySelector(".search-matches .app-row")!;
      (chapter.querySelector("[data-replay]") as HTMLElement).click();
      const start = performance.now();
      await new Promise<void>((resolve) => {
        const sample = () => {
          if (
            +getComputedStyle(frame).opacity > 0.9 &&
            !frame.querySelector(".search-pending")
          ) {
            if (
              !row.classList.contains("row-selected") &&
              !row.classList.contains("cue-target")
            )
              seen.add("unselected");
            if (
              row.classList.contains("row-selected") &&
              chapter.querySelector(
                '.demo-cue-pointer[data-action="paste"][data-kind="click"][data-pressing="true"]',
              ) &&
              chapter.querySelector(".demo-cue-hud.is-pressed")
            )
              seen.add("selected-on-click");
          }
          const pasted = chapter.querySelector(
            '[data-frame="3"] .pasted-text',
          )!;
          if (
            +getComputedStyle(chapter.querySelector('[data-frame="3"]')!)
              .opacity > 0.9 &&
            +getComputedStyle(pasted).opacity > 0.8
          )
            seen.add("pasted");
          if (performance.now() - start < 6500) requestAnimationFrame(sample);
          else resolve();
        };
        requestAnimationFrame(sample);
      });
      return [...seen];
    });
  expect(states).toEqual(["unselected", "selected-on-click", "pasted"]);
});

test("search shows mixed history before narrowing to the matching record", async ({
  page,
}) => {
  await page.goto("./#feature-search");
  const lesson = page.locator("#feature-search");
  const observed = await lesson.evaluate(async (chapter) => {
    const states = new Set<string>();
    (chapter.querySelector("[data-replay]") as HTMLElement).click();
    const frame = chapter.querySelector('[data-frame="1"]')!;
    const panel = frame.querySelector(".app-panel")!;
    const start = performance.now();
    await new Promise<void>((resolve) => {
      const sample = () => {
        if (+getComputedStyle(frame).opacity > 0.9) {
          const query = frame.querySelector(".app-search > span")!.textContent;
          if (
            panel.classList.contains("search-pending") &&
            !query &&
            getComputedStyle(frame.querySelector(".search-history")!)
              .visibility === "visible"
          )
            states.add("history");
          if (
            !panel.classList.contains("search-pending") &&
            query === "摘要" &&
            getComputedStyle(frame.querySelector(".search-matches")!)
              .visibility === "visible"
          )
            states.add("matches");
        }
        if (performance.now() - start < 3600) requestAnimationFrame(sample);
        else resolve();
      };
      requestAnimationFrame(sample);
    });
    return [...states];
  });
  expect(observed).toEqual(["history", "matches"]);
  await expect(lesson.locator(".search-history .app-row")).toHaveCount(6);
  const result = lesson.locator('[data-frame="1"] .search-matches .row-main p');
  await expect(result).toHaveText("摘要這份文件的三個重點");
  expect(
    await lesson.locator(".search-history .row-main p").allTextContents(),
  ).toContain(await result.textContent());
});
