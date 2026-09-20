import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { failedText, noticeText, sessionIdToReopen, shouldClearDraft } from "./changes-screen";
import {
  ENDED_SESSION_NOTICE,
  MUTATION_OFFLINE_NOTICE,
  MUTATION_SESSION_CHANGED_NOTICE,
  UNSUPPORTED_NOTICE,
  type ChangesState,
} from "./changes-store";
import { t } from "./i18n";
import { MALFORMED_REPLY_NOTICE } from "./workspace-results";

const BASE: ChangesState = { phase: "idle", stale: false, busy: false, uncertain: false };

describe("sessionIdToReopen (Behaviour 2 / Important 2, Fix round 2 New Breakage 1)", () => {
  it("reopens the store's own session when no route id is given", () => {
    expect(sessionIdToReopen({ ...BASE, sessionId: "s1" }, undefined, undefined)).toBe("s1");
  });

  it("has nothing to reopen when no session was ever chosen", () => {
    expect(sessionIdToReopen(BASE, undefined, undefined)).toBeUndefined();
  });

  it(
    "an unconsumed route id (from a session-detail link) wins over the store's own session " +
      "[bite-proof: drop the `routeId !== lastConsumedRouteId` half of the check and this still " +
      "passes, but the next test — the actual regression — fails]",
    () => {
      expect(sessionIdToReopen({ ...BASE, sessionId: "s1" }, "s2", undefined)).toBe("s2");
    },
  );

  it(
    "a route id already consumed no longer overrides a session the user chose afterward " +
      "[bite-proof: this is exactly Fix round 2's New Breakage 1 — before the fix, " +
      "sessionIdToReopen was `routeId ?? state.sessionId` with no consumed-tracking at all, " +
      "so this returned 's2' forever instead of the chip the user tapped]",
    () => {
      // Arrived via a link to s2 (consumed on the first focus); the user
      // then tapped a different chip, so the store's own sessionId is s1.
      // On the *next* refocus, the same route id "s2" is still on the
      // stack entry, but it was already consumed — s1 must win.
      expect(sessionIdToReopen({ ...BASE, sessionId: "s1" }, "s2", "s2")).toBe("s1");
    },
  );

  it("a genuinely new route id (a different link) wins again even after a previous one was consumed", () => {
    expect(sessionIdToReopen({ ...BASE, sessionId: "s1" }, "s3", "s2")).toBe("s3");
  });
});

describe("shouldClearDraft (Behaviour 3 / Important 1)", () => {
  it("clears the draft on a connected, notice-free outcome (success)", () => {
    expect(shouldClearDraft({ ...BASE, uncertain: false, notice: undefined })).toBe(true);
  });

  it(
    "keeps the draft when the store refused the mutation offline " +
      "[bite-proof: this is exactly the Important-1 regression — before the fix, an offline " +
      "refusal set no notice and this wrongly returned true]",
    () => {
      expect(shouldClearDraft({ ...BASE, uncertain: false, notice: MUTATION_OFFLINE_NOTICE })).toBe(
        false,
      );
    },
  );

  it("keeps the draft on an uncertain (timeout/mid-flight-close) outcome", () => {
    expect(shouldClearDraft({ ...BASE, uncertain: true, notice: undefined })).toBe(false);
  });

  it("keeps the draft when the server rejected the commit with its own text", () => {
    expect(shouldClearDraft({ ...BASE, uncertain: false, notice: "nothing staged" })).toBe(false);
  });
});

describe("noticeText", () => {
  it.each([
    [ENDED_SESSION_NOTICE, "changes.endedWarning"],
    [MUTATION_OFFLINE_NOTICE, "changes.offline"],
    [MUTATION_SESSION_CHANGED_NOTICE, "changes.sessionChanged"],
    [UNSUPPORTED_NOTICE, "changes.unsupported"],
    [MALFORMED_REPLY_NOTICE, "changes.malformedReply"],
  ] as const)("translates the %s sentinel via %s", (notice, key) => {
    expect(noticeText(notice, "en")).toBe(t("en", key));
    expect(noticeText(notice, "ar")).toBe(t("ar", key));
  });

  it("shows real server text verbatim, untranslated, in either language", () => {
    expect(noticeText("لا يوجد شيء محفوظ", "en")).toBe("لا يوجد شيء محفوظ");
    expect(noticeText("nothing staged", "ar")).toBe("nothing staged");
  });
});

describe("failedText (Important 3)", () => {
  it("shows the store's notice when it set one", () => {
    expect(failedText({ ...BASE, phase: "failed", notice: "boom" }, "en")).toBe("boom");
  });

  it("translates a sentinel notice rather than showing it raw", () => {
    expect(failedText({ ...BASE, phase: "failed", notice: UNSUPPORTED_NOTICE }, "ar")).toBe(
      t("ar", "changes.unsupported"),
    );
  });

  it(
    "falls back to a generic localized message for a bare timeout/offline failure " +
      "[bite-proof: a `git:changes` timeout sets `phase: 'failed'` with no notice — " +
      "before this fallback the screen rendered nothing at all]",
    () => {
      expect(failedText({ ...BASE, phase: "failed", notice: undefined }, "en")).toBe(
        t("en", "common.loadFailed"),
      );
    },
  );
});

describe(
  "diff block stays LTR under the Arabic UI (Important 4) " +
    '[bite-proof: drop `direction: "ltr"` from diffContent or the two ' +
    '`writingDirection: "ltr"` style entries and this fails]',
  () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const screenSource = readFileSync(resolve(here, "../../app/changes.tsx"), "utf8");

    it("forces the horizontally-scrolled diff container to ltr layout", () => {
      expect(screenSource).toMatch(/diffContent:\s*\{[^}]*direction:\s*"ltr"/);
    });

    it("forces ltr writing direction on both the hunk header and diff line text", () => {
      const occurrences = screenSource.match(/writingDirection:\s*"ltr"/g) ?? [];
      expect(occurrences.length).toBeGreaterThanOrEqual(2);
    });
  },
);
