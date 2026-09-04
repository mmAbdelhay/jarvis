// @vitest-environment jsdom
// packages/desktop/renderer/block-view.test.ts
import { describe, expect, it, vi } from "vitest";
import { createBlockView } from "./block-view.js";

const record = (over: Partial<Parameters<typeof createBlockView>[0]> = {}) => ({
  id: 1, command: "pnpm test", output: "42 passed\r\n", exitCode: 0,
  startedAt: 1000, endedAt: 3400, cwd: "/Users/x/projects/jarvis", truncated: false, ...over,
});

// The brief's hooks() omits `home`, which the header needs to collapse
// `$HOME` to `~` (see the task's Decisions Already Made). Fixed here rather
// than in the assertion it exists to satisfy. `filterToCommand` is Task 7's.
const hooks = () => ({ cols: 80, fill: vi.fn(), copy: vi.fn(), home: "/Users/x", filterToCommand: vi.fn() });

describe("a block", () => {
  it("shows the command, its status, its duration and where it ran", () => {
    const view = createBlockView(record(), hooks());
    const header = view.element.querySelector(".block-header")?.textContent ?? "";
    expect(header).toContain("pnpm test");
    expect(header).toContain("2.4s");
    expect(header).toContain("~/projects/jarvis");
    expect(view.element.dataset["status"]).toBe("ok");
  });

  it("marks a failure with its exit code", () => {
    const view = createBlockView(record({ exitCode: 1, command: "git push" }), hooks());
    expect(view.element.dataset["status"]).toBe("failed");
    expect(view.element.querySelector(".block-header")?.textContent).toContain("1");
  });

  it("collapses and expands", () => {
    const view = createBlockView(record(), hooks());
    view.element.querySelector<HTMLElement>(".block-collapse")?.click();
    expect(view.isCollapsed()).toBe(true);
    view.element.querySelector<HTMLElement>(".block-collapse")?.click();
    expect(view.isCollapsed()).toBe(false);
  });

  // "Clicking a header selects a block" — the design's Navigation section
  // and the workspace guide both say so, and without it the selection was
  // reachable only from ⌘↑/⌘↓: there was no pointer route at all to the
  // palette actions that act on the selected block.
  it("selects itself when its header is clicked", () => {
    const select = vi.fn();
    const view = createBlockView(record(), { ...hooks(), select });
    view.element.querySelector<HTMLElement>(".block-header")?.click();
    expect(select).toHaveBeenCalledWith(view);
  });

  // A control inside the header is not the header: clicking copy must copy,
  // not also select. Every control already stops propagation — this is what
  // keeps that true.
  it("does not select when a control inside the header is clicked", () => {
    const select = vi.fn();
    const h = { ...hooks(), select };
    const view = createBlockView(record(), h);
    view.element.querySelector<HTMLElement>(".block-copy")?.click();
    expect(h.copy).toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  // A pane with blocks switched off has no nav and passes no `select` —
  // clicking a header is then simply a click on some text.
  it("does not throw when clicked with no select hook wired up", () => {
    const view = createBlockView(record(), hooks());
    expect(() => view.element.querySelector<HTMLElement>(".block-header")?.click()).not.toThrow();
  });

  it("copies the output, not the command, from the copy control", () => {
    const h = hooks();
    const view = createBlockView(record(), h);
    view.element.querySelector<HTMLElement>(".block-copy")?.click();
    expect(h.copy).toHaveBeenCalledWith("42 passed\r\n");
  });

  it("fills the editor on re-run and never runs anything", () => {
    const h = hooks();
    const view = createBlockView(record({ command: "rm -rf build" }), h);
    view.element.querySelector<HTMLElement>(".block-rerun")?.click();
    expect(h.fill).toHaveBeenCalledWith("rm -rf build");
  });

  it("says so when output was capped", () => {
    const view = createBlockView(record({ truncated: true }), hooks());
    expect(view.element.textContent).toContain("elided");
  });

  it("marks a block with no exit code as failed, not ok", () => {
    const view = createBlockView(record({ exitCode: undefined }), hooks());
    expect(view.element.dataset["status"]).toBe("failed");
  });

  it("never fires the command a stray click on the block itself would suggest", () => {
    const h = hooks();
    const view = createBlockView(record({ command: "rm -rf build" }), h);
    view.element.click();
    view.element.querySelector(".block-command")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(h.fill).not.toHaveBeenCalled();
  });

  it("shows the cwd unchanged when it does not sit under home", () => {
    const view = createBlockView(record({ cwd: "/var/log" }), hooks());
    const header = view.element.querySelector(".block-header")?.textContent ?? "";
    expect(header).toContain("/var/log");
  });

  it("does not collapse a path that merely starts with the same characters as home", () => {
    // home is "/Users/x"; a cwd of "/Users/xavier" is not under it.
    const view = createBlockView(record({ cwd: "/Users/xavier/project" }), hooks());
    const header = view.element.querySelector(".block-header")?.textContent ?? "";
    expect(header).toContain("/Users/xavier/project");
    expect(header).not.toContain("~avier");
  });

  it("renders a duration a minute or longer as minutes and seconds", () => {
    const view = createBlockView(record({ startedAt: 0, endedAt: 65_000 }), hooks());
    const header = view.element.querySelector(".block-header")?.textContent ?? "";
    expect(header).toContain("1m 5s");
  });

  // 119.5s: naive rounding of the seconds-within-the-minute remainder
  // (59.5 -> 60) reads as the invalid "1m 60s". Rounding the total first
  // and deriving minutes/seconds from that carries the second into the
  // next minute instead.
  it("carries a remainder that rounds up to 60 seconds into the next minute", () => {
    const view = createBlockView(record({ startedAt: 0, endedAt: 119_500 }), hooks());
    const header = view.element.querySelector(".block-header")?.textContent ?? "";
    expect(header).toContain("2m 0s");
  });

  it("filters to this command from the more menu", () => {
    const h = hooks();
    const view = createBlockView(record({ command: "git status" }), h);
    view.element.querySelector<HTMLElement>(".block-more")?.click();
    const filter = view.element.querySelector<HTMLElement>('[data-action="filter"]');
    filter?.click();
    expect(h.filterToCommand).toHaveBeenCalledWith("git status");
  });

  it("toggles aria-expanded on the more button as its menu opens and closes", () => {
    const view = createBlockView(record(), hooks());
    const more = view.element.querySelector<HTMLElement>(".block-more");
    expect(more?.getAttribute("aria-expanded")).toBe("false");
    more?.click();
    expect(more?.getAttribute("aria-expanded")).toBe("true");
    more?.click();
    expect(more?.getAttribute("aria-expanded")).toBe("false");
  });

  it("leaves the cwd unchanged when home is empty", () => {
    const view = createBlockView(record({ cwd: "/Users/x/projects/jarvis" }), { ...hooks(), home: "" });
    const header = view.element.querySelector(".block-header")?.textContent ?? "";
    expect(header).toContain("/Users/x/projects/jarvis");
  });
});
