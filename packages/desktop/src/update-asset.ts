// Which file of a release this computer would install, and where Jarvis is
// willing to download it from. A release's asset list comes from GitHub's
// API and is not trusted on its own: only files under the project's own
// release downloads are ever fetched, and the only redirects followed are to
// GitHub's asset CDN, which is where those downloads actually live.

import type { ReleaseAsset } from "./update-check.js";

/** The checksum file every release carries (sha256sum format). */
export const SUMS_NAME = "SHA256SUMS";

const DOWNLOAD_HOST = "github.com";
const DOWNLOAD_PATH = "/mmAbdelhay/jarvis/releases/download/";
const REDIRECT_HOSTS = new Set([
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

/** `testOrigin` (e.g. `http://127.0.0.1:4567`) additionally allows a local
 *  release server; it is a development override and never set in a build. */
export type AllowOptions = { testOrigin?: string };

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** https on the default port, no credentials, exactly this host. */
function isPlainHttps(parsed: URL, host: string): boolean {
  return (
    parsed.protocol === "https:" &&
    parsed.hostname === host &&
    parsed.port === "" &&
    parsed.username === "" &&
    parsed.password === ""
  );
}

/** Whether `parsed` is on the development release server's origin. */
function onTestOrigin(parsed: URL, opts: AllowOptions): boolean {
  if (opts.testOrigin === undefined) return false;
  // An opaque origin ("null", e.g. file:) would match every other opaque one.
  const origin = parse(opts.testOrigin)?.origin;
  return origin !== undefined && origin !== "null" && parsed.origin === origin;
}

export function isAllowedDownloadUrl(url: string, opts: AllowOptions = {}): boolean {
  const parsed = parse(url);
  if (parsed === undefined) return false;
  if (onTestOrigin(parsed, opts)) return true;
  // URL has already resolved any "../", so the path check cannot be walked out of.
  return isPlainHttps(parsed, DOWNLOAD_HOST) && parsed.pathname.startsWith(DOWNLOAD_PATH);
}

/** An allowed download that is exactly this release's file: GitHub serves it
 *  at `…/download/v<version>/<name>`, so an API answer that points the asset
 *  at another tag's file (an older, vulnerable build) is refused. The local
 *  test server lays its files out as it likes. */
function isReleaseFile(url: string, version: string, name: string, opts: AllowOptions): boolean {
  if (!isAllowedDownloadUrl(url, opts)) return false;
  const parsed = parse(url) as URL;
  return onTestOrigin(parsed, opts) || parsed.pathname === `${DOWNLOAD_PATH}v${version}/${name}`;
}

export function isAllowedRedirect(url: string): boolean {
  const parsed = parse(url);
  return (
    parsed !== undefined &&
    REDIRECT_HOSTS.has(parsed.hostname) &&
    isPlainHttps(parsed, parsed.hostname)
  );
}

/** The installer's file name for this platform/arch, or undefined where
 *  Jarvis does not ship one (Intel Macs, arm64 Linux). */
function assetName(version: string, platform: NodeJS.Platform, arch: string): string | undefined {
  if (platform === "darwin" && arch === "arm64") return `Jarvis-${version}-arm64.dmg`;
  if (platform === "linux" && arch === "x64") return `Jarvis-${version}.AppImage`;
  if (platform === "win32") return `Jarvis-Setup-${version}.exe`;
  return undefined;
}

export function pickAsset(
  assets: ReleaseAsset[],
  version: string,
  platform: NodeJS.Platform,
  arch: string,
  opts: AllowOptions = {},
): ReleaseAsset | undefined {
  const bare = version.replace(/^v/, "");
  const name = assetName(bare, platform, arch);
  if (name === undefined) return undefined;
  return assets.find((asset) => asset.name === name && isReleaseFile(asset.url, bare, name, opts));
}
