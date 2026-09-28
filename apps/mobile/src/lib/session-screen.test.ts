import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STRINGS, t, type MessageKey } from "./i18n";
import {
  isEnded,
  KEY_CAPS,
  KEY_LABEL_KEYS,
  notFoundText,
  sendResultKey,
  sendResultText,
  sessionRouteId,
  streamStatusKey,
  trimmedAmount,
} from "./session-screen";
import type { SessionStreamView } from "./session-stream";
import { KEY_BAR } from "./terminal-keys";

const EMPTY_VIEW: SessionStreamView = {
  phase: "idle",
  gapCount: 0,
  droppedBytes: 0,
  ignoredCount: 0,
};

describe("sessionRouteId", () => {
  it.each([
    ["abc-123", "abc-123"],
    [["a"], undefined],
    [7, undefined],
    ["", undefined],
    ["../x", undefined],
    ["a b", undefined],
    ["a".repeat(129), undefined],
  ])("accepts only a subscription-key string: %j", (param, expected) => {
    expect(sessionRouteId(param)).toBe(expected);
  });
});

describe("sendResultKey", () => {
  it.each([
    [{ kind: "sent" }, undefined],
    [{ kind: "empty" }, undefined],
    [{ kind: "failed", text: "server text" }, undefined],
    [{ kind: "ended" }, "session.ended"],
    [{ kind: "offline" }, "session.offline"],
    [{ kind: "uncertain" }, "session.uncertain"],
    [{ kind: "rateLimited" }, "session.rateLimited"],
    [{ kind: "tooLong" }, "session.tooLong"],
    [{ kind: "ctrlInvalid" }, "session.ctrlInvalid"],
  ] as const)("maps %o to %s", (result, expected) => {
    expect(sendResultKey(result)).toBe(expected);
  });
});

describe("sendResultText", () => {
  it.each([
    [{ kind: "sent" }, ""],
    [{ kind: "empty" }, ""],
    [{ kind: "ended" }, t("en", "session.ended")],
    [{ kind: "offline" }, t("en", "session.offline")],
  ] as const)("renders %o as %j for en", (result, expected) => {
    expect(sendResultText(result, "en")).toBe(expected);
  });

  it("shows the server's own text verbatim for a failed send, untranslated", () => {
    expect(sendResultText({ kind: "failed", text: "server said no" }, "en")).toBe("server said no");
  });
});

describe("streamStatusKey", () => {
  it.each([
    ["attaching", "session.attaching"],
    ["waiting", "session.waiting"],
    ["failed", "session.attachFailed"],
    ["live", undefined],
    ["idle", undefined],
  ] as const)("maps %s to %s", (phase, expected) => {
    expect(streamStatusKey({ ...EMPTY_VIEW, phase })).toBe(expected);
  });
});

describe("isEnded", () => {
  it.each([
    ["starting", false],
    ["running", false],
    ["waiting", false],
    ["done", true],
    ["dead", true],
    [undefined, false],
  ] as const)("treats %s as ended=%s", (state, expected) => {
    expect(isEnded(state)).toBe(expected);
  });
});

describe("trimmedAmount", () => {
  it("omits an amount when no output was dropped", () => {
    expect(trimmedAmount(EMPTY_VIEW)).toBe("");
  });

  it("formats dropped output with ASCII binary units", () => {
    expect(trimmedAmount({ ...EMPTY_VIEW, droppedBytes: 2048 })).toBe("2.0 KiB");
  });
});

describe("notFoundText (final review M5)", () => {
  it("shows the loading copy while the list is loading, regardless of any stale error", () => {
    expect(notFoundText({ loading: true }, "en")).toBe(t("en", "session.attaching"));
    expect(notFoundText({ loading: true, error: { kind: "offline" } }, "en")).toBe(
      t("en", "session.attaching"),
    );
  });

  it("shows the plain not-found copy once loading is done with no error", () => {
    expect(notFoundText({ loading: false }, "en")).toBe(t("en", "session.notFound"));
  });

  it(
    "shows the laptop's own remote-error text verbatim, not the connection-status copy " +
      "[bite-proof: fall through to session.waiting for a remote error and this fails]",
    () => {
      expect(
        notFoundText(
          {
            loading: false,
            error: { kind: "remote", code: "internal", text: "boom", language: "en" },
          },
          "en",
        ),
      ).toBe("boom");
    },
  );

  it.each([["offline"], ["timeout"], ["unsupported"]] as const)(
    "shows a translated listFailed message for a %s error, not session.waiting",
    (kind) => {
      expect(notFoundText({ loading: false, error: { kind } }, "en")).toBe(
        t("en", "session.listFailed"),
      );
      expect(notFoundText({ loading: false, error: { kind } }, "en")).not.toBe(
        t("en", "session.waiting"),
      );
    },
  );
});

describe("key-bar presentation metadata", () => {
  it("covers every key-bar control with a visible cap and localized label", () => {
    expect(Object.keys(KEY_CAPS)).toEqual(KEY_BAR);
    expect(Object.keys(KEY_LABEL_KEYS)).toEqual(KEY_BAR);
    for (const key of KEY_BAR) {
      const labelKey: MessageKey = KEY_LABEL_KEYS[key];
      expect(STRINGS[labelKey]).toBeDefined();
    }
  });
});

function sessionScreenFiles(here: string): string {
  return (
    readFileSync(resolve(here, "../../app/session/[id].tsx"), "utf8") +
    readFileSync(resolve(here, "../screens/SessionDetail.tsx"), "utf8")
  );
}

describe("session route input boundary", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  // The route is a thin wrapper since the wide layout; the screen's body
  // lives in SessionDetail.tsx, so the scan reads both, route first.
  const screenSource = sessionScreenFiles(here);
  const composeSource = readFileSync(resolve(here, "../components/ComposeBar.tsx"), "utf8");

  it("passes the sole local route param through sessionRouteId and never includes CR", () => {
    expect(screenSource.match(/useLocalSearchParams\(\)/g)).toHaveLength(1);
    expect(screenSource).toContain("sessionRouteId(useLocalSearchParams().id)");
    expect(screenSource).not.toContain("\\r");
  });

  it("does not let the compose control add a CR", () => {
    expect(composeSource).not.toContain("\\r");
  });

  it("does not reopen a reset stream cursor over a surviving terminal", () => {
    expect(screenSource).toMatch(/sink\.reset\(\);\s+stream\.open\(sink\);/);
  });

  it("keeps missing rows from opening a stream and marks ended rows in input", () => {
    const foundGuard = screenSource.indexOf("if (!found) return;");
    const inputCreation = screenSource.lastIndexOf("createSessionInput");
    expect(foundGuard).toBeGreaterThan(-1);
    expect(inputCreation).toBeGreaterThan(foundGuard);
    expect(screenSource).toContain("input.setEnded(endedRef.current);");
  });
});

// Bug 10: app/_layout.tsx locks PORTRAIT_UP globally; the session and
// terminal screens unlock on focus and re-lock on blur/unmount, the exact
// pattern sidecar-view.tsx already proved out (sidecar-screen.test.ts
// ~150-177) — same source-scan style, since app/ isn't under vitest's
// test.include and these screens can't be imported and rendered directly.
describe("app/session/[id].tsx and app/terminal/[paneKey].tsx source scan: landscape orientation", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const sessionScreenSource = sessionScreenFiles(here);
  const terminalScreenSource = readFileSync(
    resolve(here, "../../app/terminal/[paneKey].tsx"),
    "utf8",
  );

  for (const [name, source] of [
    ["session/[id].tsx", sessionScreenSource],
    ["terminal/[paneKey].tsx", terminalScreenSource],
  ] as const) {
    describe(name, () => {
      it(
        "unlocks orientation inside a useFocusEffect " +
          "[bite-proof: unlock outside focus tracking and every other screen could rotate too]",
        () => {
          expect(source).toMatch(/useFocusEffect\(/);
          expect(source).toMatch(/ScreenOrientation\.unlockAsync\(\)/);
        },
      );

      it(
        "re-locks to PORTRAIT_UP in that same effect's cleanup (covers both blur and unmount) " +
          "[bite-proof: useFocusEffect's cleanup fires for both]",
        () => {
          expect(source).toMatch(
            /ScreenOrientation\.lockAsync\(ScreenOrientation\.OrientationLock\.PORTRAIT_UP\)/,
          );
        },
      );

      it("imports expo-screen-orientation, the package pinned in package.json", () => {
        expect(source).toMatch(
          /import \* as ScreenOrientation from ["']expo-screen-orientation["']/,
        );
      });

      it("tolerates a rejected native call the same way sidecar-view.tsx does (try/catch, no rethrow)", () => {
        expect(source).toMatch(/try\s*\{\s*await ScreenOrientation\.unlockAsync\(\);\s*\}\s*catch/);
        expect(source).toMatch(
          /try\s*\{\s*await ScreenOrientation\.lockAsync\(ScreenOrientation\.OrientationLock\.PORTRAIT_UP\);\s*\}\s*catch/,
        );
      });
    });
  }
});
