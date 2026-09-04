// @vitest-environment jsdom
// packages/desktop/renderer/terminal-chips.test.ts
import { describe, expect, it } from "vitest";
import { createChipRow } from "./terminal-chips.js";
import type { TerminalChips } from "../src/ipc.js";

function row(home = "/Users/x") {
  const host = document.createElement("div");
  document.body.append(host);
  return createChipRow(host, home);
}

/** All four chip texts, in DOM order — what every test below reads instead
 *  of the row's whole textContent, so a chip merely rendered *wrong* (an
 *  empty ± chip, a branch chip with no accent class, an extra chip nobody
 *  asked for) fails the count or the order rather than slipping past a
 *  substring match. */
function chipTexts(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll(".terminal-chip")).map((c) => c.textContent ?? "");
}

const FULL: TerminalChips = {
  cwd: "/Users/x/projects/jarvis",
  branch: "master",
  detached: false,
  insertions: 1,
  deletions: 3,
  runtime: "v22.11.0",
};

describe("the chip row", () => {
  it("renders runtime, the home-collapsed path, the branch and the dirty count", () => {
    const { element, render } = row();
    render(FULL);
    expect(chipTexts(element)).toEqual(["v22.11.0", "~/projects/jarvis", "master", "± 4"]);
    const branch = element.querySelector(".terminal-chip--branch");
    expect(branch?.textContent).toBe("master");
  });

  it("marks a detached HEAD rather than showing its SHA as a branch name", () => {
    const { element, render } = row();
    render({ ...FULL, branch: "a1b2c3d", detached: true });
    expect(chipTexts(element)).toEqual(["v22.11.0", "~/projects/jarvis", "(a1b2c3d)", "± 4"]);
  });

  // Absent, not empty: a repository-less pane gets no branch chip and no ±
  // chip at all. A mutant that rendered an empty branch chip, or a "± "
  // with nothing after it, or simply left the branch text blank while
  // still emitting both spans, is caught by the chip *count* here, not by
  // any substring check on their text.
  it("renders no branch chip and no dirty chip when there is no branch", () => {
    const { element, render } = row();
    // Insertions and deletions stay non-zero here on purpose: this test
    // isolates "no ± chip because there is no branch" from "no ± chip
    // because the count is zero" (a separate case, covered below). A
    // mutant tying ± visibility to insertions + deletions > 0 instead of
    // to branch presence would still pass a version of this test that
    // zeroed the counts.
    render({ ...FULL, branch: undefined });
    expect(chipTexts(element)).toEqual(["v22.11.0", "~/projects/jarvis"]);
    expect(element.querySelectorAll(".terminal-chip").length).toBe(2);
    expect(element.querySelector(".terminal-chip--branch")).toBeNull();
  });

  // Same discipline for the runtime chip: a mutant that rendered it with an
  // empty string instead of leaving it out is caught by the count, not by
  // a missing-substring check that an empty span would also satisfy.
  it("renders no runtime chip when there is no runtime", () => {
    const { element, render } = row();
    render({ ...FULL, runtime: undefined });
    expect(chipTexts(element)).toEqual(["~/projects/jarvis", "master", "± 4"]);
    expect(element.querySelectorAll(".terminal-chip").length).toBe(3);
  });

  it("renders an empty row for an unknown pane", () => {
    const { element, render } = row();
    render(FULL);
    render(undefined);
    expect(element.querySelectorAll(".terminal-chip").length).toBe(0);
    expect(element.children.length).toBe(0);
  });

  // The block header collapsed this wrong once already: a cwd that merely
  // *starts with* the same characters as $HOME is not under it.
  it("does not collapse a path that only shares a prefix with home", () => {
    const { element, render } = row("/Users/x");
    render({ ...FULL, cwd: "/Users/xavier/work" });
    expect(chipTexts(element)).toContain("/Users/xavier/work");
    expect(chipTexts(element)).not.toContain("~avier/work");
  });

  // os.homedir() is not guaranteed to come back without a trailing slash —
  // the separator must not be eaten along with the home prefix.
  it("collapses correctly when home itself ends in a slash", () => {
    const { element, render } = row("/Users/x/");
    render({ ...FULL, cwd: "/Users/x/foo" });
    expect(chipTexts(element)).toContain("~/foo");
  });

  // A root homedir ("/", real on some minimal systems/containers) is the
  // degenerate case of the same prefix rule.
  it("collapses correctly for a root home", () => {
    const { element, render } = row("/");
    render({ ...FULL, cwd: "/etc" });
    expect(chipTexts(element)).toContain("~/etc");
  });

  // Untrusted text from the repository — a branch name is never markup.
  it("renders a branch name containing markup as plain text", () => {
    const { element, render } = row();
    render({ ...FULL, branch: "<img src=x onerror=alert(1)>" });
    expect(element.querySelector("img")).toBeNull();
    expect(chipTexts(element)).toContain("<img src=x onerror=alert(1)>");
  });

  it("shows a clean ± 0 without the dirty color class", () => {
    const { element, render } = row();
    render({ ...FULL, insertions: 0, deletions: 0 });
    expect(chipTexts(element)).toContain("± 0");
    expect(element.querySelector(".terminal-chip--dirty")).toBeNull();
  });

  it("marks a dirty count with the dirty class", () => {
    const { element, render } = row();
    render(FULL);
    expect(element.querySelector(".terminal-chip--dirty")?.textContent).toBe("± 4");
  });

  it("builds every chip with createElement rather than innerHTML", () => {
    const { element, render } = row();
    render(FULL);
    for (const chip of Array.from(element.querySelectorAll(".terminal-chip"))) {
      expect(chip.children.length).toBe(0);
    }
  });
});
