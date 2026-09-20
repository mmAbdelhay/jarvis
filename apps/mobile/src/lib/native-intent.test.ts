import { beforeEach, describe, expect, it } from "vitest";
import { takePairingLink } from "./pairing-link-holder";
import { redirectSystemPath } from "./native-intent";

const LINK = `jarvis://pair?v=1&host=192.168.1.5&port=4317&secret=${"s".repeat(43)}&fp=${"a".repeat(64)}`;

beforeEach(() => {
  takePairingLink();
});

describe("redirectSystemPath", () => {
  it("stashes a pairing link and redirects to the bare /pair path", () => {
    expect(redirectSystemPath(LINK)).toBe("/pair");
    expect(takePairingLink()).toBe(LINK);
  });

  it(
    "the redirected path never carries a query string — the secret cannot " +
      "reach Expo Router's own route params " +
      '[bite-proof: return the original `path` instead of "/pair" and this fails]',
    () => {
      const redirected = redirectSystemPath(LINK);
      expect(redirected).not.toContain("?");
      expect(redirected).not.toContain("secret");
    },
  );

  it(
    "a forged clearFailed=1 riding along on the link is stashed as inert data, " +
      "never surfaced as a redirect target or a param",
    () => {
      const forged = `${LINK}&clearFailed=1`;
      const redirected = redirectSystemPath(forged);
      expect(redirected).toBe("/pair");
      expect(redirected).not.toContain("clearFailed");
    },
  );

  // Fix round 2 (Important 2): inverted to an allow-list — the pairing
  // link above is the *only* system path this function ever recognises.
  // Every other system path, including one this app itself owns a route
  // for, is redirected to the safe root, and the holder is left alone.
  // (Internal navigation — `router.push("/dashboard")` etc. — never calls
  // this function at all; see the file-header comment and the fix round 2
  // report.)
  it("redirects a non-pairing system path to the safe root, untouched holder", () => {
    expect(redirectSystemPath("/dashboard")).toBe("/");
    expect(takePairingLink()).toBeNull();
  });

  it("leaves the bare root path unchanged", () => {
    expect(redirectSystemPath("/")).toBe("/");
  });
});

describe("session deep links", () => {
  // Fix round 1's deny-list rows: every one of these already resolved to
  // `session`/`sessions` under expo-router. Kept as regression rows —
  // they now pass trivially, because the allow-list refuses everything
  // that isn't the exact pairing-link form, not because any of them is
  // specifically recognised as a session path any more.
  it.each([
    "jarvis://session/abc",
    "/session/abc",
    "jarvis://sessions",
    "exp+jarvis-mobile://session/x?y=1",
    "JARVIS://session/abc",
    "Jarvis://sessions",
    "jarvis:///session/abc",
    "jarvis:////sessions",
    "exp://192.168.1.5:8081/--/session/abc",
    "exp://192.168.1.5:8081/--/sessions",
  ])("refuses %s", (path) => {
    expect(redirectSystemPath(path)).toBe("/");
  });

  // Fix round 2 (Important 2): the round 2 re-review traced expo-router
  // 57.0.21's own resolution pipeline (fromDeepLink → new URL(p, "file:")
  // → its route regex) and found these all resolve to `session/[id]`
  // while round 1's normalising deny-list still let them through. A
  // deny-list can't enumerate the router's own parser; the allow-list
  // refuses every one of these the same way it refuses everything else
  // that isn't the pairing link.
  it.each([
    ["jarvis://session\\abc", "backslash in place of a path slash"],
    ["jarvis:///x/../session/abc", "a `../` segment after extra leading slashes"],
    ["/x/../session/abc", "a bare `../` segment, no scheme"],
    ["jarvis://./session/abc", "a `.` segment"],
    ["jarvis://../session/abc", "a `../` segment right after the scheme"],
    [
      "jarvis://expo-development-client/?url=jarvis%3A%2F%2Fsession%2Fabc",
      "the Expo dev-client's own ?url= unwrap, not gated to dev builds",
    ],
    [" jarvis://session/abc", "leading whitespace before the scheme"],
    ["jarvis://ses\tsion/abc", "an embedded tab inside the path"],
    ["https://example.com/session/abc", "a plain https:// universal link"],
  ])("refuses %s (%s)", (path) => {
    expect(redirectSystemPath(path)).toBe("/");
  });

  it("redirects even an unrelated look-alike system path to the safe root", () => {
    expect(redirectSystemPath("jarvis://sessionsx")).toBe("/");
  });
});

describe("voice deep links (Task 8, ruling 16)", () => {
  // The mic never starts without a tap, and no screen that can transmit
  // what you say needs to be deep-linkable. Since `redirectSystemPath` is
  // already an allow-list (only the pairing-link form ever passes through
  // unchanged — see the file header), these are satisfied by construction:
  // there is no separate "voice" rule to add, so these rows are a
  // regression guard on the allow-list itself, not on a new branch.
  it.each(["jarvis://voice", "/voice?x=1", "exp+jarvis-mobile://voice/start"])(
    "%s refuses to the safe root [bite-proof: let a `voice`-prefixed path pass through unchanged, and this fails]",
    (path) => {
      expect(redirectSystemPath(path)).toBe("/");
    },
  );

  it("jarvis://voices (a look-alike, not the voice segment) is unchanged: still refused to /", () => {
    expect(redirectSystemPath("jarvis://voices")).toBe("/");
  });
});
