// Asserts the shape of `../app.config.ts` that the expo-camera (M6) and
// expo-audio (M8 Task 6) permission strings depend on: bilingual usage
// text, the Android permission list, no background-audio opt-in, and that
// this task did not drop an existing plugin. `app.config.ts` has no native
// code of its own — plain data — so it is safe to import directly here,
// unlike a `native-*.ts(x)` file.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import config from "../app.config";
import { theme } from "./lib/theme";

const AR_CODE_POINT = /[؀-ۿ]/;
const LATIN_LETTER = /[A-Za-z]/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function findPlugin(name: string): [string, Record<string, unknown>] | undefined {
  const plugins = config.plugins ?? [];
  for (const plugin of plugins) {
    if (Array.isArray(plugin) && plugin[0] === name) {
      return plugin as [string, Record<string, unknown>];
    }
  }
  return undefined;
}

function findExpoAudioPlugin(): [string, Record<string, unknown>] | undefined {
  return findPlugin("expo-audio");
}

describe("app.config.ts", () => {
  test("plugins contains an expo-audio entry with a bilingual microphonePermission", () => {
    const entry = findExpoAudioPlugin();
    expect(entry).toBeDefined();
    const microphonePermission = entry?.[1].microphonePermission;
    expect(typeof microphonePermission).toBe("string");
    const text = microphonePermission as string;
    // [bite-proof: an English-only string]
    expect(AR_CODE_POINT.test(text)).toBe(true);
    expect(LATIN_LETTER.test(text)).toBe(true);
  });

  test("android.permissions includes RECORD_AUDIO and CAMERA", () => {
    expect(config.android?.permissions).toContain("RECORD_AUDIO");
    expect(config.android?.permissions).toContain("CAMERA");
  });

  test("ios.infoPlist has no UIBackgroundModes", () => {
    expect(config.ios?.infoPlist?.UIBackgroundModes).toBeUndefined();
  });

  // Fix round 1, Important #1: the source config having no `UIBackgroundModes`
  // is not enough — the expo-audio plugin's own default (`true`) writes it
  // into the built Info.plist regardless. This guards the option that
  // actually controls the prebuild output.
  test("the expo-audio entry disables background playback and recording", () => {
    const entry = findExpoAudioPlugin();
    expect(entry?.[1].enableBackgroundPlayback).toBe(false);
    expect(entry?.[1].enableBackgroundRecording).not.toBe(true);
  });

  test("the existing plugins are still present", () => {
    const names = (config.plugins ?? []).map((plugin) =>
      Array.isArray(plugin) ? plugin[0] : plugin,
    );
    expect(names).toContain("expo-router");
    expect(names).toContain("expo-secure-store");
    expect(names).toContain("expo-camera");
  });
});

// M10 Task 5, Files: `src/app-config.test.ts` ("an expo-notifications
// plugin entry exists; extra.eas.projectId is a UUID").
describe("app.config.ts: push (M10 Task 5)", () => {
  test("plugins contains an expo-notifications entry with a color", () => {
    const entry = findPlugin("expo-notifications");
    expect(entry).toBeDefined();
    const color = entry?.[1].color;
    expect(typeof color).toBe("string");
    expect((color as string).length).toBeGreaterThan(0);
  });

  // Fix round 1, Important #1: the color is a literal in app.config.ts (an
  // `import { theme }` there breaks Expo's own config loader), so this is
  // the one place that literal is checked against theme.ts's real value —
  // a future theme change that forgets to update app.config.ts fails here.
  test("the expo-notifications color literal never drifts from theme.colors.primary", () => {
    const entry = findPlugin("expo-notifications");
    expect(entry?.[1].color).toBe(theme.colors.primary);
  });

  test("extra.eas.projectId is a UUID", () => {
    const projectId = config.extra?.eas?.projectId;
    expect(typeof projectId).toBe("string");
    expect(UUID_PATTERN.test(projectId as string)).toBe(true);
  });

  test("android.googleServicesFile is set only when the file exists on disk", () => {
    const has = existsSync(fileURLToPath(new URL("../google-services.json", import.meta.url)));
    if (has) {
      expect(config.android?.googleServicesFile).toBe("./google-services.json");
    } else {
      expect(config.android?.googleServicesFile).toBeUndefined();
    }
  });
});

// Sidecar landscape fix: the app locks portrait itself (expo-screen-
// orientation, app/_layout.tsx) rather than relying on this native config
// field, so the sidecar screen can unlock to landscape — a native
// `orientation: "portrait"` here would override that regardless of what
// the JS side asks for. This is a native config change: it takes effect
// only in a new EAS build, not an OTA/JS update.
describe("app.config.ts: orientation (sidecar landscape fix)", () => {
  test('orientation is "default", not "portrait" [bite-proof: revert this and the sidecar can never rotate]', () => {
    expect(config.orientation).toBe("default");
  });

  test("expo-screen-orientation is a real dependency, not just imported and hoped for", () => {
    const packageJson = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(packageJson.dependencies?.["expo-screen-orientation"]).toBeDefined();
  });
});
