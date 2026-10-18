import { describe, expect, it } from "vitest";
import { type PaneFacts, resolveLink } from "./link.js";
import type { PullRequest } from "./types.js";

const pr: PullRequest = {
  repo: "owner/name",
  number: 42,
  title: "Reviews",
  headRef: "feat/reviews",
  author: "owner",
  url: "https://github.com/owner/name/pull/42",
  isDraft: false,
  role: "mine",
};

const matching: PaneFacts = {
  paneKey: "matching",
  repo: "owner/name",
  branch: "feat/reviews",
  exited: false,
};

describe("resolveLink", () => {
  it("prefers a manual link to a live pane over a branch match", () => {
    expect(
      resolveLink(
        pr,
        [matching, { paneKey: "manual", exited: false }],
        new Map([["owner/name#42", "manual"]]),
        true,
      ),
    ).toEqual({ kind: "linked", paneKey: "manual", how: "manual" });
  });

  it("falls through to auto when the manually linked pane exited", () => {
    expect(
      resolveLink(
        pr,
        [matching, { paneKey: "manual", exited: true }],
        new Map([["owner/name#42", "manual"]]),
        true,
      ),
    ).toEqual({ kind: "linked", paneKey: "matching", how: "auto" });
  });

  it("does not match the same branch in another repo", () => {
    expect(resolveLink(pr, [{ ...matching, repo: "other/name" }], new Map(), true)).toEqual({
      kind: "none",
    });
  });

  it("returns both keys when two live panes match the repo and branch", () => {
    expect(
      resolveLink(pr, [matching, { ...matching, paneKey: "second" }], new Map(), true),
    ).toEqual({ kind: "ambiguous", paneKeys: ["matching", "second"] });
  });

  it("returns none when autoLink is off and there is no manual link", () => {
    expect(resolveLink(pr, [matching], new Map(), false)).toEqual({ kind: "none" });
  });

  it("honors a live manual link when autoLink is off", () => {
    expect(resolveLink(pr, [matching], new Map([["owner/name#42", "matching"]]), false)).toEqual({
      kind: "linked",
      paneKey: "matching",
      how: "manual",
    });
  });

  it("falls through to auto when the manually linked pane is closed", () => {
    expect(resolveLink(pr, [matching], new Map([["owner/name#42", "closed"]]), true)).toEqual({
      kind: "linked",
      paneKey: "matching",
      how: "auto",
    });
  });

  it("ignores exited panes and panes without matching repo and branch facts", () => {
    expect(
      resolveLink(
        pr,
        [
          { ...matching, exited: true },
          { ...matching, paneKey: "other-branch", branch: "main" },
          { paneKey: "unknown", exited: false },
        ],
        new Map(),
        true,
      ),
    ).toEqual({ kind: "none" });
  });
});
