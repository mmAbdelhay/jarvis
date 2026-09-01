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

/** The reporting placeholders are no longer in the default greeting, so the
 *  tests that cover their formatting ask for them explicitly. */
const REPORTING = {
  en: "{ready}\n{lastSession}\n{uncommitted}",
  ar: "{ready}\n{lastSession}\n{uncommitted}",
};

describe("greetingText", () => {
  it("greets the morning between 05:00 and 11:59", () => {
    const at = new Date("2026-08-31T09:00:00").getTime();

    expect(greetingText({ now: at, history: [], dirtyProjects: [] }, "en")).toContain(
      "Good morning sir",
    );
  });

  it("greets the afternoon between 12:00 and 16:59", () => {
    const at = new Date("2026-08-31T13:00:00").getTime();

    expect(greetingText({ now: at, history: [], dirtyProjects: [] }, "en")).toContain(
      "Good afternoon sir",
    );
  });

  it("greets the evening from 17:00", () => {
    expect(greetingText({ now: EVENING, history: [], dirtyProjects: [] }, "en")).toContain(
      "Good evening sir",
    );
  });

  // 03:00 is not morning in any language. The small hours belong to the
  // evening greeting rather than getting a fourth one of their own.
  it("greets the small hours as evening", () => {
    const at = new Date("2026-08-31T03:00:00").getTime();

    expect(greetingText({ now: at, history: [], dirtyProjects: [] }, "en")).toContain(
      "Good evening sir",
    );
  });

  it("renders {ready} when a template asks for it", () => {
    expect(
      greetingText({ now: EVENING, history: [], dirtyProjects: [], template: REPORTING }, "en"),
    ).toContain("Jarvis is ready.");
  });

  // The store returns history most-recently-active first, so the head of the
  // list is the session the user was last in.
  it("names the last session's project, agent and clock time", () => {
    const text = greetingText(
      { now: EVENING, history: [session()], dirtyProjects: [], template: REPORTING },
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
        template: REPORTING,
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
        template: REPORTING,
      },
      "en",
    );

    expect(text).toContain("Uncommitted — acme: 4, storefront: 2");
  });

  it("omits the uncommitted line when every project is clean", () => {
    const text = greetingText({ now: EVENING, history: [], dirtyProjects: [] }, "en");

    expect(text).not.toContain("Uncommitted");
  });

  it("puts each part of a multi-line template on its own line", () => {
    const text = greetingText(
      {
        now: EVENING,
        history: [session()],
        dirtyProjects: [{ project: "acme", changedFiles: 4 }],
        template: REPORTING,
      },
      "en",
    );

    expect(text.split("\n")).toHaveLength(3);
  });

  // A placeholder with nothing to say should not leave the greeting opening
  // on a blank line.
  it("drops a line whose only placeholder had nothing to say", () => {
    const text = greetingText(
      { now: EVENING, history: [], dirtyProjects: [], template: REPORTING },
      "en",
    );

    expect(text).toBe("Jarvis is ready.");
  });

  it("uses the configured template over the default", () => {
    const text = greetingText(
      { now: EVENING, history: [], dirtyProjects: [], template: { en: "Evening, boss." } },
      "en",
    );

    expect(text).toBe("Evening, boss.");
  });

  it("falls back to the default when the configured template is blank", () => {
    const text = greetingText(
      { now: EVENING, history: [], dirtyProjects: [], template: { en: "   " } },
      "en",
    );

    expect(text).toBe("Good evening sir, how can I help you today?");
  });

  // A typo in a template should show as itself rather than vanishing, so it
  // can be seen and fixed.
  it("leaves an unknown placeholder alone", () => {
    const text = greetingText(
      { now: EVENING, history: [], dirtyProjects: [], template: { en: "Hello {nope}." } },
      "en",
    );

    expect(text).toBe("Hello {nope}.");
  });

  describe("in Arabic", () => {
    it("greets the morning", () => {
      const at = new Date("2026-08-31T09:00:00").getTime();

      expect(greetingText({ now: at, history: [], dirtyProjects: [] }, "ar")).toContain(
        "صباح الخير",
      );
    });

    // Arabic has no separate afternoon greeting — مساء الخير covers both the
    // afternoon and the evening, so the two English cases collapse into one
    // here rather than being forced into an invented third form.
    it("greets the afternoon and the evening with the same phrase", () => {
      const afternoon = new Date("2026-08-31T13:00:00").getTime();

      expect(
        greetingText({ now: afternoon, history: [], dirtyProjects: [] }, "ar"),
      ).toContain("مساء الخير");
      expect(greetingText({ now: EVENING, history: [], dirtyProjects: [] }, "ar")).toContain(
        "مساء الخير",
      );
    });

    it("renders {ready} when a template asks for it", () => {
      expect(
        greetingText({ now: EVENING, history: [], dirtyProjects: [], template: REPORTING }, "ar"),
      ).toContain("جارفِس جاهز.");
    });

    // صباح الخير is not decomposable into an adjective and a noun the way
    // "good morning" is, so Arabic's {timeOfDay} carries the whole phrase.
    it("gives {timeOfDay} the whole phrase, not a bare word", () => {
      const text = greetingText(
        { now: EVENING, history: [], dirtyProjects: [], template: { ar: "{timeOfDay} يا سيدي" } },
        "ar",
      );

      expect(text).toBe("مساء الخير يا سيدي");
    });

    it("names the last session with the value at the clause tail", () => {
      const text = greetingText(
        { now: EVENING, history: [session()], dirtyProjects: [], template: REPORTING },
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
          template: REPORTING,
        },
        "ar",
      );

      expect(text).toContain("تغييرات غير محفوظة — acme: 4");
    });
  });
});
