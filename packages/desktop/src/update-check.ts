// "Is there a newer Jarvis?" — asked only when the user presses Check for
// updates in Settings, never in the background: Jarvis's promise is that
// nothing leaves the laptop that was not already going to, and a silent
// call home on every launch would break it. One GET to GitHub's public
// releases API, no token, nothing about this machine in it.

export const RELEASES_API = "https://api.github.com/repos/mmAbdelhay/jarvis/releases/latest";

/** One file attached to a release. Not yet trusted: which of these may be
 *  downloaded is decided by `update-asset.ts`, not here. */
export type ReleaseAsset = { name: string; url: string; size: number };

export type UpdateCheck =
  | { kind: "current"; current: string }
  | {
      kind: "newer";
      current: string;
      latest: string;
      url: string;
      notes: string;
      assets: ReleaseAsset[];
    }
  | { kind: "failed"; current: string };

/** Release notes are shown in Settings; a runaway body is cut, not refused. */
const MAX_NOTES = 4000;

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

export async function checkForUpdate(deps: {
  current: string;
  /** Defaults to RELEASES_API; overridden only to test against a local server. */
  api?: string;
  fetch: (
    url: string,
    init: { headers: Record<string, string> },
  ) => Promise<{
    ok: boolean;
    json(): Promise<unknown>;
  }>;
}): Promise<UpdateCheck> {
  const { current } = deps;
  try {
    const response = await deps.fetch(deps.api ?? RELEASES_API, {
      headers: { accept: "application/vnd.github+json", "user-agent": "jarvis-desktop" },
    });
    if (!response.ok) return { kind: "failed", current };
    const body = (await response.json()) as Record<string, unknown> | null;
    const tag = body?.["tag_name"];
    const url = body?.["html_url"];
    // Only a release page on github.com is ever offered as a link.
    if (
      typeof tag !== "string" ||
      typeof url !== "string" ||
      !url.startsWith("https://github.com/mmAbdelhay/jarvis/releases/")
    ) {
      return { kind: "failed", current };
    }
    const latest = tag.replace(/^v/, "");
    if (!isNewer(latest, current)) return { kind: "current", current };
    const notes = typeof body?.["body"] === "string" ? body["body"].slice(0, MAX_NOTES) : "";
    return { kind: "newer", current, latest, url, notes, assets: parseAssets(body?.["assets"]) };
  } catch {
    return { kind: "failed", current };
  }
}
