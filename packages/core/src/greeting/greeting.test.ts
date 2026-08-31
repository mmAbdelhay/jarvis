import { describe, expect, it } from "vitest";
import type { Session } from "../session/types.js";
import { greetingText } from "./greeting.js";

// A fixed local moment used as "now" unless a test needs another: an evening,
// so the default case is the one the app is most often opened in.
const EVENING = new Date("2026-08-31T19:20:00").getTime();

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    project: "acme",
    projectPath: "/Users/x/projects/acme",
    agentId: "claude-acme",
    state: "dead",
    summary: "",
    startedAt: new Date("2026-08-31T14:00:00").getTime(),
    lastActivityAt: new Date("2026-08-31T14:32:00").getTime(),
    ...overrides,
  };
}

describe("greetingText", () => {
  it("greets the morning between 05:00 and 11:59", () => {
    const at = new Date("2026-08-31T09:00:00").getTime();

    expect(greetingText({ now: at, history: [], dirtyProjects: [] }, "en")).toContain(
      "Good morning.",
    );
  });

  it("greets the afternoon between 12:00 and 16:59", () => {
    const at = new Date("2026-08-31T13:00:00").getTime();

    expect(greetingText({ now: at, history: [], dirtyProjects: [] }, "en")).toContain(
      "Good afternoon.",
    );
  });

  it("greets the evening from 17:00", () => {
    expect(greetingText({ now: EVENING, history: [], dirtyProjects: [] }, "en")).toContain(
      "Good evening.",
    );
  });

  // 03:00 is not morning in any language. The small hours belong to the
  // evening greeting rather than getting a fourth one of their own.
  it("greets the small hours as evening", () => {
    const at = new Date("2026-08-31T03:00:00").getTime();

    expect(greetingText({ now: at, history: [], dirtyProjects: [] }, "en")).toContain(
      "Good evening.",
    );
  });

  it("says Jarvis is ready", () => {
    expect(greetingText({ now: EVENING, history: [], dirtyProjects: [] }, "en")).toContain(
      "Jarvis is ready.",
    );
  });

  // The store returns history most-recently-active first, so the head of the
  // list is the session the user was last in.
  it("names the last session's project, agent and clock time", () => {
    const text = greetingText(
      { now: EVENING, history: [session()], dirtyProjects: [] },
      "en",
    );

    expect(text).toContain("Last session: acme · claude-acme · 14:32");
  });

  // A bare "14:32" on a session from last week reads as this afternoon. The
  // date is added exactly when the clock alone would mislead — never counted
  // in words ("3 days ago"), which Arabic cannot render without agreement.
  it("adds the date when the last session was not today", () => {
    const text = greetingText(
      {
        now: EVENING,
        history: [session({ lastActivityAt: new Date("2026-08-28T14:32:00").getTime() })],
        dirtyProjects: [],
      },
      "en",
    );

    expect(text).toContain("Last session: acme · claude-acme · 28/08 14:32");
  });

  it("omits the last-session line when there is no history", () => {
    const text = greetingText({ now: EVENING, history: [], dirtyProjects: [] }, "en");

    expect(text).not.toContain("Last session");
  });

  // Label-value, count at the clause tail: "4 files" would need Arabic
  // counted-noun agreement that changes with the number (ruling P30).
  it("lists uncommitted work per project", () => {
    const text = greetingText(
      {
        now: EVENING,
        history: [],
        dirtyProjects: [
          { project: "acme", changedFiles: 4 },
          { project: "storefront", changedFiles: 2 },
        ],
      },
      "en",
    );

    expect(text).toContain("Uncommitted — acme: 4, storefront: 2");
  });

  it("omits the uncommitted line when every project is clean", () => {
    const text = greetingText({ now: EVENING, history: [], dirtyProjects: [] }, "en");

    expect(text).not.toContain("Uncommitted");
  });

  it("puts each part on its own line", () => {
    const text = greetingText(
      {
        now: EVENING,
        history: [session()],
        dirtyProjects: [{ project: "acme", changedFiles: 4 }],
      },
      "en",
    );

    expect(text.split("\n")).toHaveLength(3);
  });

  describe("in Arabic", () => {
    it("greets the morning", () => {
      const at = new Date("2026-08-31T09:00:00").getTime();

      expect(greetingText({ now: at, history: [], dirtyProjects: [] }, "ar")).toContain(
        "صباح الخير.",
      );
    });

    // Arabic has no separate afternoon greeting — مساء الخير covers both the
    // afternoon and the evening, so the two English cases collapse into one
    // here rather than being forced into an invented third form.
    it("greets the afternoon and the evening with the same phrase", () => {
      const afternoon = new Date("2026-08-31T13:00:00").getTime();

      expect(
        greetingText({ now: afternoon, history: [], dirtyProjects: [] }, "ar"),
      ).toContain("مساء الخير.");
      expect(greetingText({ now: EVENING, history: [], dirtyProjects: [] }, "ar")).toContain(
        "مساء الخير.",
      );
    });

    it("says Jarvis is ready", () => {
      expect(greetingText({ now: EVENING, history: [], dirtyProjects: [] }, "ar")).toContain(
        "جارفِس جاهز.",
      );
    });

    it("names the last session with the value at the clause tail", () => {
      const text = greetingText(
        { now: EVENING, history: [session()], dirtyProjects: [] },
        "ar",
      );

      expect(text).toContain("آخر جلسة: acme · claude-acme · 14:32");
    });

    it("lists uncommitted work as label-value", () => {
      const text = greetingText(
        {
          now: EVENING,
          history: [],
          dirtyProjects: [{ project: "acme", changedFiles: 4 }],
        },
        "ar",
      );

      expect(text).toContain("تغييرات غير محفوظة — acme: 4");
    });
  });
});
