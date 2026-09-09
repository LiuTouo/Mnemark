import { test, expect } from "@playwright/test";

test("hover previews the image before text without clicking", async ({
  page,
}) => {
  await page.goto("./#feature-preview");
  const seen = await page
    .locator("#feature-preview")
    .evaluate(async (chapter) => {
      const states = new Set<string>();
      (chapter.querySelector("[data-replay]") as HTMLElement).click();
      const start = performance.now();
      await new Promise<void>((resolve) => {
        const sample = () => {
          const pointer =
            chapter.querySelector<HTMLElement>(".demo-cue-pointer")!;
          for (const frame of chapter.querySelectorAll("[data-frame]")) {
            if (
              +getComputedStyle(frame).opacity < 0.9 ||
              pointer.dataset.kind !== "hover"
            )
              continue;
            if (
              pointer.dataset.action === "hover-image" &&
              frame.querySelector(".show-image") &&
              +getComputedStyle(frame.querySelector(".preview-image")!)
                .opacity > 0.8
            )
              states.add("image");
            if (
              pointer.dataset.action === "hover-text" &&
              frame.querySelector(".show-text") &&
              +getComputedStyle(
                frame.querySelector(".app-preview:not(.preview-image)")!,
              ).opacity > 0.8
            )
              states.add("text");
          }
          if (performance.now() - start < 2200) requestAnimationFrame(sample);
          else resolve();
        };
        requestAnimationFrame(sample);
      });
      return [...states];
    });
  expect(seen).toEqual(["image", "text"]);
});
