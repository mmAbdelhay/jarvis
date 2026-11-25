// @vitest-environment jsdom
//
// The reply markdown as DOM: text nodes only, roles for headings, grid lists,
// tables that scroll in their own box, and file paths that ask the host to open them.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MESSAGES } from "../../src/messages.js";
import { type CodeContext, renderMarkdown } from "./code.js";

beforeEach(() => {
  document.body.replaceChildren();
});

function context(extra: Partial<CodeContext> = {}): CodeContext {
  return {
    t: (key) => (MESSAGES[key] as (l: "en" | "ar") => string)("en"),
    openLink: vi.fn(),
    copy: vi.fn(),
    openFile: vi.fn(),
    ...extra,
  };
}
function draw(text: string, ctx = context()): HTMLElement {
  const host = document.createElement("div");
  host.append(...renderMarkdown(text, ctx));
  document.body.append(host);
  return host;
}

describe("renderMarkdown", () => {
  it("draws headings as role=heading with their level", () => {
    const host = draw("# One\n\n### Three");
    const levels = [...host.querySelectorAll("[role='heading']")].map((h) => [
      h.getAttribute("aria-level"),
      h.textContent,
    ]);
    expect(levels).toEqual([
      ["1", "One"],
      ["3", "Three"],
    ]);
  });

  it("never turns reply text into markup", () => {
    const host = draw(
      "<img src=x onerror=alert(1)> **<b>x</b>**\n\n| <i>a</i> |\n|---|\n| <u>b</u> |",
    );
    expect(host.querySelector("img, b, i, u")).toBeNull();
    expect(host.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("draws a list as marker and text columns, nested, with dir=auto per item", () => {
    const host = draw("1. one\n   - sub\n10. ten");
    const list = host.querySelector<HTMLElement>("[role='list']");
    expect(list?.style.getPropertyValue("--ac-mk")).toBe("3.5ch");
    const items = host.querySelectorAll<HTMLElement>("[role='listitem']");
    expect(items).toHaveLength(3);
    for (const item of items) expect(item.dir).toBe("auto");
    const first = items[0] as HTMLElement;
    expect(first.querySelector(":scope > .agent-chat__marker")?.textContent).toBe("1.");
    expect(first.querySelector(":scope > .agent-chat__itembody > [role='list']")).not.toBeNull();
  });

  it("marks task items with a named state", () => {
    const host = draw("- [x] done\n- [ ] open");
    const marks = [...host.querySelectorAll(".agent-chat__marker")].map((m) =>
      m.getAttribute("aria-label"),
    );
    expect(marks).toEqual(["Done", "Not done"]);
  });

  it("draws a table with column headers, alignment and its own scroll box", () => {
    const host = draw("| A | B |\n|:-:|--:|\n| 1 | **2** |");
    const box = host.querySelector<HTMLElement>(".ac-tablewrap");
    expect(box?.tabIndex).toBe(0);
    const heads = [...host.querySelectorAll("th")];
    expect(heads.map((h) => h.getAttribute("scope"))).toEqual(["col", "col"]);
    expect(heads.map((h) => h.dataset["align"])).toEqual(["center", "right"]);
    expect(host.querySelector("td strong")?.textContent).toBe("2");
  });

  it("draws quotes, rules, italics, strikethrough and nested bold", () => {
    const host = draw("> *q*\n\n---\n\n~~x~~ **a `b` c**");
    expect(host.querySelector("blockquote em")?.textContent).toBe("q");
    expect(host.querySelector("hr")).not.toBeNull();
    expect(host.querySelector("del")?.textContent).toBe("x");
    expect(host.querySelector("strong code")?.textContent).toBe("b");
  });

  it("makes a file path a button with a short label and the full path as its name", () => {
    const ctx = context();
    const long = "/Users/someone/projects/jarvis/packages/desktop/renderer/agent-chat/code.ts";
    const host = draw(`see \`${long}:42\` and src/a.ts`, ctx);
    const buttons = host.querySelectorAll<HTMLButtonElement>("button.ac-path");
    expect(buttons).toHaveLength(2);
    const [first, second] = [...buttons] as [HTMLButtonElement, HTMLButtonElement];
    expect(first.textContent?.startsWith("…/")).toBe(true);
    expect(first.textContent?.endsWith("code.ts:42")).toBe(true);
    expect(first.title).toBe(`${long}:42`);
    expect(first.getAttribute("aria-label")).toBe(`Open file ${long}:42`);
    first.click();
    expect(ctx.openFile).toHaveBeenLastCalledWith(long);
    second.click();
    expect(ctx.openFile).toHaveBeenLastCalledWith("src/a.ts");
  });

  it("leaves commands, URLs and words that only look like paths as they were", () => {
    const host = draw("`npm run x/y` and/or origin/master, https://a.com/x.js `/clear`");
    expect(host.querySelector("button")).toBeNull();
    expect(host.querySelectorAll("code.ac-inline")).toHaveLength(2);
  });

  it("draws a path as plain text when the host cannot open files", () => {
    const ctx = context();
    delete ctx.openFile;
    const host = draw("`src/a.ts` src/b.ts", ctx);
    expect(host.querySelector("button")).toBeNull();
    expect(host.querySelector("code.ac-inline")?.textContent).toBe("src/a.ts");
    expect(host.textContent).toContain("src/b.ts");
  });
});
