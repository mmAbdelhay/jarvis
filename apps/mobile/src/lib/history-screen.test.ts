import { describe, expect, it } from "vitest";
import { historyListDisplay, transcriptDisplay, withLrmPrefixes } from "./history-screen";
import type { HistoryState } from "./history-store";
import { t } from "./i18n";

const BASE: HistoryState = { sessions: [], transcript: [], stale: false, loading: false };
const SESSION = {
  id: "s1",
  project: "jarvis",
  projectPath: "/repo",
  agentId: "codex",
  state: "done" as const,
  summary: "جلسة سابقة",
  startedAt: 1,
  lastActivityAt: 10,
};

describe("historyListDisplay (Important 3)", () => {
  it("shows the list once any session has loaded, regardless of stale/loading", () => {
    expect(historyListDisplay({ ...BASE, sessions: [SESSION] }, "en")).toEqual({ kind: "list" });
    expect(historyListDisplay({ ...BASE, sessions: [SESSION], stale: true }, "en")).toEqual({
      kind: "list",
    });
  });

  it("shows loading while the first fetch is in flight", () => {
    expect(historyListDisplay({ ...BASE, loading: true }, "en")).toEqual({ kind: "loading" });
  });

  it("shows the plain empty copy once loading finished with no error", () => {
    expect(historyListDisplay(BASE, "en")).toEqual({ kind: "empty" });
  });

  it(
    "shows a failure, not the empty copy, when the list is empty because the fetch failed " +
      "[bite-proof: this is the Important-3 regression — before the fix, a timed-out " +
      "history:list rendered the same 'No saved sessions.' text as a genuinely empty account]",
    () => {
      expect(historyListDisplay({ ...BASE, stale: true }, "en")).toEqual({
        kind: "failed",
        text: t("en", "common.loadFailed"),
      });
    },
  );

  it("prefers the server's own remote-error text over the generic fallback", () => {
    expect(historyListDisplay({ ...BASE, stale: true, notice: "boom" }, "en")).toEqual({
      kind: "failed",
      text: "boom",
    });
  });
});

describe("transcriptDisplay (Important 3)", () => {
  it("shows loading while the history list itself hasn't resolved yet", () => {
    expect(transcriptDisplay({ ...BASE, loading: true }, "s1", "en")).toEqual({ kind: "loading" });
  });

  it("shows not-found for an id genuinely absent from a loaded, non-empty list", () => {
    expect(transcriptDisplay({ ...BASE, sessions: [SESSION] }, "missing", "en")).toEqual({
      kind: "notFound",
    });
  });

  it(
    "shows a failure instead of a false not-found when the session list itself never loaded " +
      "[bite-proof: before the fix, this state ('the list is stale and empty, so we don't " +
      "actually know if s1 exists') rendered the same 'Session not found.' as a confirmed absence]",
    () => {
      expect(transcriptDisplay({ ...BASE, stale: true }, "s1", "en")).toEqual({
        kind: "failed",
        text: t("en", "common.loadFailed"),
      });
    },
  );

  it("shows loading while the transcript fetch for the selected id is in flight", () => {
    expect(transcriptDisplay({ ...BASE, sessions: [SESSION], loading: true }, "s1", "en")).toEqual({
      kind: "loading",
    });
  });

  it("shows a genuinely empty transcript once loaded successfully with no entries", () => {
    expect(
      transcriptDisplay({ ...BASE, sessions: [SESSION], selectedId: "s1" }, "s1", "en"),
    ).toEqual({ kind: "empty" });
  });

  it(
    "shows a failure, not the empty-transcript copy, when the fetch for the selected id failed " +
      "[bite-proof: a session:transcript timeout leaves `transcript: []` with no notice — " +
      "before the fix this rendered 'No transcript entries.' instead of an error]",
    () => {
      expect(
        transcriptDisplay(
          { ...BASE, sessions: [SESSION], selectedId: "s1", stale: true },
          "s1",
          "en",
        ),
      ).toEqual({ kind: "failed", text: t("en", "common.loadFailed") });
    },
  );

  it("shows the entries once loaded", () => {
    expect(
      transcriptDisplay(
        {
          ...BASE,
          sessions: [SESSION],
          selectedId: "s1",
          transcript: [{ role: "user", text: "hi", tools: [] }],
        },
        "s1",
        "en",
      ),
    ).toEqual({ kind: "entries" });
  });
});

describe("withLrmPrefixes (M12 Task 8, rule 10)", () => {
  it("never touches text when the UI is en (LTR)", () => {
    expect(withLrmPrefixes("const x = 1;", "en")).toBe("const x = 1;");
    expect(withLrmPrefixes("مرحبا", "en")).toBe("مرحبا");
  });

  it("leaves Arabic-script lines alone under an RTL UI", () => {
    expect(withLrmPrefixes("مرحبا بك", "ar")).toBe("مرحبا بك");
  });

  it(
    "prefixes an LTR code/diff line with U+200E under an RTL UI " +
      "[bite-proof: keep the iOS-only writingDirection style instead; this line is unmarked]",
    () => {
      expect(withLrmPrefixes("const x = 1;", "ar")).toBe("‎const x = 1;");
      expect(withLrmPrefixes("diff --git a/x b/x", "ar")).toBe("‎diff --git a/x b/x");
    },
  );

  it("prefixes each line independently in a mixed-content reply", () => {
    const text = "شرح قصير:\nconst x = 1;\nنهاية الشرح";
    expect(withLrmPrefixes(text, "ar")).toBe("شرح قصير:\n‎const x = 1;\nنهاية الشرح");
  });

  it("leaves a line with no strong-LTR character (pure digits/punctuation) unmarked", () => {
    expect(withLrmPrefixes("123.45", "ar")).toBe("123.45");
  });
});
