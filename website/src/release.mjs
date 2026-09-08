export const RELEASES_URL =
  "https://github.com/LiuTouo/Mnemark/releases/latest";

// Only public GitHub release assets can become download destinations. Never guess filenames.
export function parseRelease(data) {
  const fallback = {
    version: "",
    installer: RELEASES_URL,
    portable: RELEASES_URL,
    direct: false,
  };
  if (!data || data.draft || data.prerelease || !Array.isArray(data.assets))
    return fallback;
  const allowed = "https://github.com/LiuTouo/Mnemark/releases/download/";
  const find = (pattern) =>
    data.assets.find(
      (asset) =>
        typeof asset.name === "string" &&
        pattern.test(asset.name) &&
        typeof asset.browser_download_url === "string" &&
        asset.browser_download_url.startsWith(allowed),
    )?.browser_download_url;
  const installer = find(/^Mnemark_[\w.-]+_x64-setup\.exe$/);
  const portable = find(/^Mnemark_[\w.-]+_x64-portable\.exe$/);
  if (!installer || !portable) return fallback;
  return {
    version: typeof data.tag_name === "string" ? data.tag_name : "",
    installer,
    portable,
    direct: true,
  };
}

export async function getRelease(fetcher = fetch) {
  try {
    const response = await fetcher(
      "https://api.github.com/repos/LiuTouo/Mnemark/releases/latest",
      {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(8000),
      },
    );
    return response.ok
      ? parseRelease(await response.json())
      : parseRelease(null);
  } catch {
    return parseRelease(null);
  }
}
