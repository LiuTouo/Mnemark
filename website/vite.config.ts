import { defineConfig, type UserConfig } from "vite";
import { resolve } from "node:path";
import { renderPage } from "./src/page";
import { getRelease } from "./src/release.mjs";

export default defineConfig(async (): Promise<UserConfig> => {
  const base = process.env.SITE_BASE || "/Mnemark/";
  const release = await getRelease();
  return {
    base,
    plugins: [
      {
        name: "mnemark-static-locales",
        transformIndexHtml: {
          order: "post",
          handler(html, context) {
            const locale = context.filename
              .replaceAll("\\", "/")
              .endsWith("/en/index.html")
              ? "en"
              : "zh";
            const page = renderPage(locale, base, release);
            return html
              .replace("<!-- SITE_HEAD -->", page.head)
              .replace("<!-- SITE_BODY -->", page.body);
          },
        },
      },
    ],
    build: {
      rollupOptions: {
        input: {
          zh: resolve(import.meta.dirname, "index.html"),
          en: resolve(import.meta.dirname, "en/index.html"),
        },
      },
    },
  };
});
