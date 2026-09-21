// Regenerates public/altstore/source.json (served by the docs site at
// https://mmabdelhay.github.io/jarvis/altstore/source.json) from the
// public GitHub releases API — one AltStore/SideStore version entry per
// release that carries a jarvis-mobile-*.ipa asset. Run after each
// release with an IPA: `node scripts/update-altstore-source.mjs`, then
// commit the JSON. No token, no dependencies.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RELEASES_URL = "https://api.github.com/repos/mmAbdelhay/jarvis/releases";
const OUTPUT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../public/altstore/source.json",
);

export function buildSource(releases) {
  const versions = releases.flatMap((release) => {
    const ipa = release.assets.find((asset) => /^jarvis-mobile-.*\.ipa$/i.test(asset.name));
    if (!ipa) return [];

    return [
      {
        version: release.tag_name.replace(/^v/, ""),
        date: release.published_at,
        downloadURL: ipa.browser_download_url,
        size: ipa.size,
        minOSVersion: "15.1",
      },
    ];
  });

  return {
    name: "Jarvis",
    identifier: "dev.jarvis.source",
    apps: [
      {
        name: "Jarvis",
        bundleIdentifier: "dev.jarvis.mobile",
        developerName: "Muhammad AbdElHay",
        subtitle: "Your machine, in your pocket — companion app for the Jarvis desktop",
        localizedDescription: "Your machine, in your pocket — companion app for the Jarvis desktop",
        iconURL:
          "https://raw.githubusercontent.com/mmAbdelhay/jarvis/master/apps/mobile/assets/icon.png",
        versions,
      },
    ],
  };
}

function nextPage(response) {
  const match = response.headers.get("link")?.match(/<([^>]+)>; rel="next"/);
  return match?.[1];
}

async function fetchReleases() {
  const releases = [];
  let url = RELEASES_URL;

  while (url) {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub releases request failed: ${response.status} ${response.statusText}`);
    }

    releases.push(...(await response.json()));
    url = nextPage(response);
  }

  return releases;
}

async function main() {
  const source = buildSource(await fetchReleases());
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(source, null, 2)}\n`);
  console.log(`Wrote ${source.apps[0].versions.length} version(s) to ${OUTPUT_PATH}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
