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

describe("session route input boundary", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const screenSource = readFileSync(resolve(here, "../../app/session/[id].tsx"), "utf8");
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
