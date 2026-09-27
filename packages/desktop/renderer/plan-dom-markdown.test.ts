// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { blockToMarkdown, isNoopEdit, type BlockKind } from "./plan-dom-markdown.js";

// Builds the block wrapper div a real plan-panel render would produce: a
// container div holding whatever markdown-it rendered for that block's
// source. Editable kinds (heading/paragraph/list/quote) hold the rendered
// tag; code/table/hr/other hold the raw markdown text itself, since those
// edit as plain text rather than rendered HTML.
function wrapper(innerHTML: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = innerHTML;
  return el;
}

function original(kind: BlockKind, source: string, level?: number) {
  return { kind, level, source };
}

describe("blockToMarkdown: round-trip (unedited DOM reproduces original source)", () => {
  it("heading", () => {
    const source = "## Title **x**";
    const el = wrapper("<h2>Title <strong>x</strong></h2>");
    expect(blockToMarkdown(el, original("heading", source, 2))).toBe(source);
  });

  it("paragraph", () => {
    const source = "Hello **x**";
    const el = wrapper("<p>Hello <strong>x</strong></p>");
    expect(blockToMarkdown(el, original("paragraph", source))).toBe(source);
  });

  it("list (unordered, with a nested list)", () => {
    const source = "- Parent\n  - Child";
    const el = wrapper("<ul><li>Parent<ul><li>Child</li></ul></li></ul>");
    expect(blockToMarkdown(el, original("list", source))).toBe(source);
  });

  it("list (ordered)", () => {
    const source = "1. One\n2. Two";
    const el = wrapper("<ol><li>One</li><li>Two</li></ol>");
    expect(blockToMarkdown(el, original("list", source))).toBe(source);
  });

  it("code", () => {
    const source = "```js\nconst x = 1;\n```";
    const el = wrapper("<pre><code>const x = 1;</code></pre>");
    expect(blockToMarkdown(el, original("code", source))).toBe(source);
  });

  it("table", () => {
    const source = "| A | B |\n| - | - |\n| 1 | 2 |";
    const el = wrapper("");
    el.textContent = source;
    expect(blockToMarkdown(el, original("table", source))).toBe(source);
  });

  it("quote", () => {
    const source = "> Hello";
    const el = wrapper("<blockquote>\n<p>Hello</p>\n</blockquote>");
    expect(blockToMarkdown(el, original("quote", source))).toBe(source);
  });

  it("hr", () => {
    const source = "---";
    const el = wrapper("");
    el.textContent = source;
    expect(blockToMarkdown(el, original("hr", source))).toBe(source);
  });

  it("other", () => {
    const source = "<!-- a raw block markdown-it didn't classify -->";
    const el = wrapper("");
    el.textContent = source;
    expect(blockToMarkdown(el, original("other", source))).toBe(source);
  });
});

describe("blockToMarkdown: inline formatting", () => {
  it("produces exact markdown for bold, italic, code and link", () => {
    const source = "Hello **x** and *y* and `z` and [link](https://a.com)";
    const el = wrapper(
      '<p>Hello <strong>x</strong> and <em>y</em> and <code>z</code> and <a href="https://a.com">link</a></p>',
    );
    expect(blockToMarkdown(el, original("paragraph", source))).toBe(source);
  });

  it("keeps a hard break as two trailing spaces plus newline", () => {
    const source = "Line one  \nLine two";
    const el = wrapper("<p>Line one<br>Line two</p>");
    expect(blockToMarkdown(el, original("paragraph", source))).toBe(source);
  });
});

describe("blockToMarkdown: ordered list start number", () => {
  it("keeps the original start number and renumbers from it", () => {
    const source = "3. Three\n4. Four\n5. Five";
    const el = wrapper('<ol start="3"><li>Three</li><li>Four</li><li>Five</li></ol>');
    expect(blockToMarkdown(el, original("list", source))).toBe(source);
  });

  it("renumbers sequentially even if an item was reordered", () => {
    // Started at 3; the DOM's second <li> now reads "Five" (moved up), so
    // the written-back list must still read 3, 4, 5 in DOM order.
    const source = "3. Three\n4. Four\n5. Five";
    const el = wrapper('<ol start="3"><li>Three</li><li>Five</li><li>Four</li></ol>');
    expect(blockToMarkdown(el, original("list", source))).toBe("3. Three\n4. Five\n5. Four");
  });
});

describe("blockToMarkdown: task list items", () => {
  it("keeps [ ] and [x] markers", () => {
    const source = "- [ ] Todo\n- [x] Done";
    const el = wrapper(
      '<ul><li><input type="checkbox"> Todo</li><li><input type="checkbox" checked> Done</li></ul>',
    );
    expect(blockToMarkdown(el, original("list", source))).toBe(source);
  });
});

describe("blockToMarkdown: escaping", () => {
  it("escapes a markdown-significant character the source never used", () => {
    const source = "Hello world";
    const el = wrapper("<p>Hello *world*</p>");
    // The source never contained "*", so a literal "*" typed during editing
    // must be escaped rather than silently turning into emphasis.
    expect(blockToMarkdown(el, original("paragraph", source))).toBe("Hello \\*world\\*");
  });

  it("leaves a character alone when the source already used it", () => {
    const source = "Hello *world* already italic";
    const el = wrapper("<p>Hello *world* still here</p>");
    expect(blockToMarkdown(el, original("paragraph", source))).toBe("Hello *world* still here");
  });
});

describe("isNoopEdit", () => {
  it("is a no-op when the text is unchanged", () => {
    expect(isNoopEdit("Hello world", "Hello world")).toBe(true);
  });

  it("is a no-op when only trailing whitespace per line differs", () => {
    expect(isNoopEdit("Hello   \nWorld\t", "Hello\nWorld")).toBe(true);
  });

  it("is not a no-op when the content actually changed", () => {
    expect(isNoopEdit("Hello there", "Hello world")).toBe(false);
  });

  it("does not ignore leading whitespace", () => {
    expect(isNoopEdit("  Hello", "Hello")).toBe(false);
  });
});
