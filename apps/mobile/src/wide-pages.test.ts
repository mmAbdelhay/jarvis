// Source scans for the wide layout's secondary pages (2026-09-28 plan,
// Task 6): the routes are React components with no pure logic left to
// unit test, so these pin the wiring the model tests can't see.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MOBILE = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(MOBILE, file), "utf8");

describe.each([
  "app/history.tsx",
  "app/transcript/[id].tsx",
  "app/sidecars/[project].tsx",
  "app/docker/[project].tsx",
  "app/api/[project].tsx",
  "app/changes.tsx",
])("%s inside the wide shell", (file) => {
  it("draws the shell and a centred WidePanel", () => {
    const source = read(file);
    expect(source).toMatch(/<WideShell>/);
    expect(source).toMatch(/<WidePanel[\s>]/);
  });
});

describe("app/(tabs)/voice.tsx", () => {
  it("centres its content in a WidePanel (the tabs layout already draws the shell)", () => {
    expect(read("app/(tabs)/voice.tsx")).toMatch(/<WidePanel[\s>]/);
  });
});

describe.each(["app/unlock.tsx", "app/unlock.web.tsx", "app/pair.tsx", "app/pair.web.tsx"])(
  "%s",
  (file) => {
    it("sits in an AuthCard", () => {
      expect(read(file)).toMatch(/<AuthCard>/);
    });
  },
);

describe("app/_layout.tsx", () => {
  it.each(["history", "transcript/[id]", "sidecars/[project]", "docker/[project]"])(
    "hides %s's native header on a wide screen",
    (name) => {
      const source = read("app/_layout.tsx");
      const start = source.indexOf(`name="${name}"`);
      expect(start).toBeGreaterThan(-1);
      const entry = source.slice(start, source.indexOf("/>", start));
      expect(entry).toMatch(/headerShown: !wide/);
    },
  );
});

describe("app/_layout.tsx screens with their own ScreenHeader", () => {
  it.each(["changes", "session/[id]", "terminal/[paneKey]"])(
    "never shows %s's native header (phone draws ScreenHeader, wide its panel title)",
    (name) => {
      const source = read("app/_layout.tsx");
      const start = source.indexOf(`name="${name}"`);
      expect(start).toBeGreaterThan(-1);
      expect(source.slice(start, source.indexOf("/>", start))).toMatch(/headerShown: false/);
    },
  );
});

describe("app/(tabs)/dashboard.tsx", () => {
  it("keeps the error line inside the 1180 measure on a wide screen", () => {
    expect(read("app/(tabs)/dashboard.tsx")).toMatch(
      /style=\{\[styles\.error, wide && styles\.errorWide\]\}/,
    );
    expect(read("app/(tabs)/dashboard.tsx")).toMatch(
      /errorWide: \{[^}]*maxWidth: WIDE_PANEL_MAX_WIDTH/,
    );
  });
});

describe("src/screens/SettingsSections.tsx", () => {
  it("keeps the phone's 8px gap above the restart notice (no extra marginTop)", () => {
    expect(read("src/screens/SettingsSections.tsx")).toMatch(
      /notice: \{ color: theme\.colors\.warning, fontSize: theme\.font\.size\.sm \}/,
    );
  });
});

// Final review I1: on a phone the AuthCard's non-scrolling ScrollView must
// pin its content to the screen height (`flex: 1`), so the page's own
// `flex: 1` ScrollView gets a bounded height and scrolls. `flexGrow: 1`
// let react-native-web's content container (`flex-shrink: 0`) grow to the
// content, which clipped a tall unlock page in a phone browser.
describe("src/components/WidePanel.tsx AuthCard", () => {
  it("gives the phone content container flex: 1, not flexGrow: 1", () => {
    const source = read("src/components/WidePanel.tsx");
    expect(source).toMatch(
      /contentContainerStyle=\{frame\.scrolls \? undefined : styles\.fillContent\}/,
    );
    expect(source).toMatch(/fillContent: \{ flex: 1 \}/);
  });
});
