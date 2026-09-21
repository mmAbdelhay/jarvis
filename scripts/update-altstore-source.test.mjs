// Runs under node:test, not vitest (the root vitest include only covers
// packages/*): execute with `node --test scripts/update-altstore-source.test.mjs`.
import assert from "node:assert/strict";
import test from "node:test";

import { buildSource } from "./update-altstore-source.mjs";

test("buildSource includes only releases with IPA assets", () => {
  const releases = [
    {
      tag_name: "v0.2.0",
      published_at: "2026-09-21T12:34:56Z",
      assets: [
        {
          name: "jarvis-mobile-0.2.0.ipa",
          browser_download_url:
            "https://github.com/mmAbdelhay/jarvis/releases/download/v0.2.0/jarvis-mobile-0.2.0.ipa",
          size: 123456,
        },
      ],
    },
    {
      tag_name: "v0.1.4",
      published_at: "2026-09-01T10:00:00Z",
      assets: [
        {
          name: "jarvis-mobile-0.1.4.apk",
          browser_download_url:
            "https://github.com/mmAbdelhay/jarvis/releases/download/v0.1.4/jarvis-mobile-0.1.4.apk",
          size: 654321,
        },
      ],
    },
  ];

  assert.deepEqual(buildSource(releases).apps[0].versions, [
    {
      version: "0.2.0",
      date: "2026-09-21T12:34:56Z",
      downloadURL:
        "https://github.com/mmAbdelhay/jarvis/releases/download/v0.2.0/jarvis-mobile-0.2.0.ipa",
      size: 123456,
      minOSVersion: "15.1",
    },
  ]);
});

test("buildSource emits a subscribable app with no versions", () => {
  const source = buildSource([]);

  assert.equal(source.name, "Jarvis");
  assert.equal(source.identifier, "dev.jarvis.source");
  assert.deepEqual(source.apps[0].versions, []);
});
