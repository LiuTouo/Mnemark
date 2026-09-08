import test from "node:test";
import assert from "node:assert/strict";
import { getRelease, parseRelease, RELEASES_URL } from "../src/release.mjs";

const asset = (name) => ({
  name,
  browser_download_url: `https://github.com/LiuTouo/Mnemark/releases/download/v0.8.1/${name}`,
});
const assets = [
  asset("Mnemark_0.8.1_x64-setup.exe"),
  asset("Mnemark_v0.8.1_x64-portable.exe"),
  asset("Mnemark_0.8.1_x64-setup.exe.sig"),
];
test("only complete stable Windows release assets produce direct download links", () => {
  const release = parseRelease({ tag_name: "v0.8.1", assets });
  assert.equal(release.direct, true);
  assert.equal(release.installer, assets[0].browser_download_url);
  assert.equal(release.portable, assets[1].browser_download_url);
});
test("missing portable asset or draft release falls back without guessing filenames", () => {
  for (const data of [
    { assets: [assets[0]] },
    { assets, draft: true },
    { assets, prerelease: true },
    null,
  ]) {
    assert.equal(parseRelease(data).direct, false);
    assert.equal(parseRelease(data).installer, RELEASES_URL);
  }
});
test("untrusted download origins cannot become CTA links", () => {
  assert.equal(
    parseRelease({
      assets: [
        { ...assets[0], browser_download_url: "https://example.com/file.exe" },
        assets[1],
      ],
    }).direct,
    false,
  );
});
test("offline and rate-limited builds retain a useful download destination", async () => {
  for (const fetcher of [
    async () => {
      throw new Error("offline");
    },
    async () => ({ ok: false, status: 403 }),
  ]) {
    assert.equal((await getRelease(fetcher)).installer, RELEASES_URL);
  }
});
