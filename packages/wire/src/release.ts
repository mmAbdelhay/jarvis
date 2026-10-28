// Pure release metadata and checksum rules shared by desktop and phone.

export type ReleaseAsset = { name: string; url: string; size: number };

/** `0.1.5` / `v0.1.5` → [0, 1, 5]; undefined for anything else. A
 *  pre-release suffix ("-beta.2") is not newer than its own release. */
function parseVersion(version: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (a === undefined || b === undefined) return false;
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** One sha256sum line: 64 hex, then "  name" (text) or " *name" (binary). */
const SUM_LINE = /^([0-9a-fA-F]{64}) [ *](.+)$/;

/** SHA256SUMS text → file name → lowercase hex. Malformed lines are skipped,
 *  and a name listed twice with different hashes is dropped as ambiguous. */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  const conflicted = new Set<string>();
  for (const line of text.split("\n")) {
    const match = SUM_LINE.exec(line.replace(/\r$/, ""));
    if (match === null) continue;
    const hex = (match[1] as string).toLowerCase();
    const name = match[2] as string;
    const seen = sums.get(name);
    if (seen !== undefined && seen !== hex) conflicted.add(name);
    sums.set(name, hex);
  }
  for (const name of conflicted) sums.delete(name);
  return sums;
}

/** Only this project's HTTPS download for exactly this version and file. */
export function isReleaseDownloadUrl(url: string, version: string, name: string): boolean {
  return url === `https://github.com/mmAbdelhay/jarvis/releases/download/v${version}/${name}`;
}

/** GitHub's `assets` array → the well-formed entries; anything else → []. */
function parseAssets(raw: unknown): ReleaseAsset[] {
  if (!Array.isArray(raw)) return [];
  const assets: ReleaseAsset[] = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, browser_download_url: url, size } = entry as Record<string, unknown>;
    if (typeof name !== "string" || typeof url !== "string") continue;
    if (typeof size !== "number" || !Number.isFinite(size) || size < 0) continue;
    assets.push({ name, url, size });
  }
  return assets;
}

export type ReleaseList =
  | {
      kind: "newer";
      version: string;
      notes: string;
      pageUrl: string;
      apk: ReleaseAsset;
      sums: ReleaseAsset;
    }
  | { kind: "current" }
  | { kind: "failed" };

/** Select the newest stable release carrying both trusted phone update files. */
export function parseReleaseList(raw: unknown, current: string): ReleaseList {
  if (!Array.isArray(raw)) return { kind: "failed" };
  let chosen: ReleaseList = { kind: "current" };
  for (const entry of raw as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const release = entry as Record<string, unknown>;
    if (release["draft"] || release["prerelease"]) continue;
    const tag = release["tag_name"];
    const pageUrl = release["html_url"];
    if (
      typeof tag !== "string" ||
      /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag)?.[0] !== tag ||
      typeof pageUrl !== "string" ||
      !pageUrl.startsWith("https://github.com/mmAbdelhay/jarvis/releases/")
    )
      continue;
    const version = tag.replace(/^v/, "");
    if (!isNewer(version, chosen.kind === "newer" ? chosen.version : current)) continue;
    const assets = parseAssets(release["assets"]);
    const apkName = `jarvis-mobile-${version}.apk`;
    const apk = assets.find(
      (asset) => asset.name === apkName && isReleaseDownloadUrl(asset.url, version, apkName),
    );
    const sums = assets.find(
      (asset) =>
        asset.name === "SHA256SUMS" && isReleaseDownloadUrl(asset.url, version, "SHA256SUMS"),
    );
    if (apk === undefined || sums === undefined) continue;
    const body = release["body"];
    chosen = {
      kind: "newer",
      version,
      pageUrl,
      notes: typeof body === "string" ? body.slice(0, 4000) : "",
      apk,
      sums,
    };
  }
  return chosen;
}
