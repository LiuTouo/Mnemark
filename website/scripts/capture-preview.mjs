import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Start the development server first. Screenshots are website artifacts, not reference-site assets.
const site = process.env.PREVIEW_URL || "http://127.0.0.1:5173/Mnemark/";
const output = fileURLToPath(new URL("../docs/previews/", import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(site, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: `${output}/desktop.png` });
await page
  .locator("#feature-search")
  .evaluate((element) =>
    scrollTo(0, element.getBoundingClientRect().top + scrollY + 400),
  );
await page.waitForTimeout(100);
await page.screenshot({ path: `${output}/feature.png` });
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(site, { waitUntil: "networkidle" });
await page.screenshot({ path: `${output}/mobile.png` });
await page.setViewportSize({ width: 1200, height: 630 });
await page.goto(site, { waitUntil: "networkidle" });
await page.addStyleTag({
  content:
    ".site-header,.hero-bottom,.hero .download-actions,.hero-meta{display:none!important}.hero{height:630px!important;min-height:630px!important;padding-top:0!important}.hero-center{padding-top:110px!important}.hero h1{font-size:185px!important;margin:20px 0 35px!important}.hero-line{font-size:30px!important}.eyebrow{font-size:13px!important}",
});
await page.screenshot({
  path: fileURLToPath(new URL("../public/social.png", import.meta.url)),
});
await browser.close();
console.log("Saved desktop, feature, mobile and social previews.");
