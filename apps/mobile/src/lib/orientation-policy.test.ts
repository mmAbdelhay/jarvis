import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { orientationPolicy } from "./orientation-policy";

describe("orientationPolicy", () => {
  it.each([
    [360, "portrait-lock"],
    [412, "portrait-lock"],
    [599, "portrait-lock"],
    [600, "free"],
    [744, "free"],
    [1024, "free"],
  ] as const)("short side %i → %s", (shortSide, policy) => {
    expect(orientationPolicy({ shortSide })).toBe(policy);
  });
});

// Every screen that (re-)locks portrait must ask the device's policy first,
// or a tablet gets locked the moment one of them loses focus.
const MOBILE = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOCKING_SOURCES = [
  "app/_layout.tsx",
  "app/sidecar-view.tsx",
  "src/screens/SessionDetail.tsx",
  "src/screens/TerminalPane.tsx",
];

describe.each(LOCKING_SOURCES)("%s: portrait lock only on a phone", (file) => {
  const source = readFileSync(join(MOBILE, file), "utf8");
  it("gates every PORTRAIT_UP lock on the device's orientation policy", () => {
    const locks = source.match(/ScreenOrientation\.lockAsync\(/g) ?? [];
    const gates = source.match(/deviceOrientationPolicy\(\) !== "portrait-lock"\) return;/g) ?? [];
    expect(locks.length).toBeGreaterThan(0);
    expect(gates.length).toBe(locks.length);
  });
});
