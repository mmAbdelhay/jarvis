import { describe, expect, it } from "vitest";
import { shouldTrigger } from "./trigger.js";
import { DEFAULT_REVIEWS_CONFIG, prKey, REVIEW_MARKER } from "./types.js";
import type { ReviewComment, ReviewsConfig } from "./types.js";

function comment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: "1",
    kind: "issue",
    author: "reviewer",
    isBot: false,
    body: "Please fix this.",
    createdAt: 1,
    ...overrides,
  };
}

function config(overrides: Partial<ReviewsConfig> = {}): ReviewsConfig {
  return { ...DEFAULT_REVIEWS_CONFIG, ...overrides };
}

describe("shouldTrigger", () => {
  it("rejects the login's own comments regardless of case", () => {
    expect(shouldTrigger(comment({ author: "OWNER" }), "owner", config())).toBe(false);
  });

  it("rejects bodies containing the automatic reply marker", () => {
    expect(shouldTrigger(comment({ body: `Done. ${REVIEW_MARKER}` }), "owner", config())).toBe(
      false,
    );
  });

  it("rejects bots when ignoreBots is on", () => {
    expect(shouldTrigger(comment({ isBot: true }), "owner", config())).toBe(false);
  });

  it("rejects authors outside a non-empty allowlist", () => {
    expect(shouldTrigger(comment(), "owner", config({ authors: ["colleague"] }))).toBe(false);
  });

  it("rejects bodies missing the required text", () => {
    expect(shouldTrigger(comment(), "owner", config({ requireText: "@jarvis" }))).toBe(false);
  });

  it("accepts an allowlisted author with required text regardless of case", () => {
    expect(
      shouldTrigger(
        comment({ body: "@JARVIS please fix" }),
        "owner",
        config({ authors: ["reviewer"], requireText: "@jarvis" }),
      ),
    ).toBe(true);
  });

  it("accepts any other author when the allowlist is empty", () => {
    expect(shouldTrigger(comment(), "owner", config())).toBe(true);
  });

  it("accepts bots when ignoreBots is off", () => {
    expect(shouldTrigger(comment({ isBot: true }), "owner", config({ ignoreBots: false }))).toBe(
      true,
    );
  });
});

describe("review types", () => {
  it("formats a PR key", () => {
    expect(prKey("owner/name", 42)).toBe("owner/name#42");
  });

  it("pins the marker and defaults", () => {
    expect(REVIEW_MARKER).toBe("<!-- jarvis:auto -->");
    expect(DEFAULT_REVIEWS_CONFIG).toEqual({
      enabled: true,
      intervalSeconds: 60,
      repos: {},
      authors: [],
      requireText: "",
      ignoreBots: true,
      autoLink: true,
      batchSeconds: 30,
      notify: { comment: true, queued: true, requested: true },
    });
  });
});
