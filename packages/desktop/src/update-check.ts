// "Is there a newer Jarvis?" — asked once at launch and once a day while
// the app runs (updater.ts), and from Settings' Check now. The user chose
// automatic checks. It is one GET to GitHub's public releases API: no
// token, nothing about this machine in it.

import { isNewer, type ReleaseAsset } from "@jarvis/wire";

export { isNewer, type ReleaseAsset } from "@jarvis/wire";

export const RELEASES_API = "https://api.github.com/repos/mmAbdelhay/jarvis/releases/latest";

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
