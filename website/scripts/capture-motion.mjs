import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = `${root}/docs/previews`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: {
    dir: `${root}/.cache/motion`,
    size: { width: 1280, height: 800 },
  },
});
const page = await context.newPage();
await page.goto(process.env.PREVIEW_URL || "http://127.0.0.1:5173/Mnemark/", {
  waitUntil: "networkidle",
});
await page.evaluate(() => document.fonts.ready);
await page
  .locator("#feature-search")
  .evaluate((el) =>
    scrollTo(0, el.getBoundingClientRect().top + scrollY - 700),
  );
await page.waitForTimeout(300);
await page.evaluate(async () => {
  const first = document.getElementById("feature-search");
  const last = document.getElementById("feature-drawers");
  const from = first.getBoundingClientRect().top + scrollY - 700;
  const to = last.getBoundingClientRect().bottom + scrollY - innerHeight;
  const start = performance.now();
  await new Promise((resolve) => {
    function frame(now) {
      const progress = Math.min(1, (now - start) / 15000);
      scrollTo(0, from + (to - from) * progress);
      if (progress < 1) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
});
await page.waitForTimeout(500);
const video = page.video();
await context.close();
const input = await video.path();
await browser.close();
const result = spawnSync(
  "ffmpeg",
  [
    "-y",
    "-i",
    input,
    "-an",
    "-c:v",
    "libx264",
    "-crf",
    "25",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    `${output}/motion.mp4`,
  ],
  { stdio: "pipe", windowsHide: true },
);
if (result.error || result.status !== 0)
  throw new Error(result.error?.message || result.stderr.toString());
console.log(`Saved ${output}/motion.mp4`);
