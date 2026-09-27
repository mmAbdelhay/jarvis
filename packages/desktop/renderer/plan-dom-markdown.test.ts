// @vitest-environment jsdom
import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { blockToMarkdown, isNoopEdit, type BlockKind } from "./plan-dom-markdown.js";

// Task 1's own parse options: no raw HTML passthrough, bare URLs/emails
// autolinked, smart quotes/dashes off. Every rendered-HTML fixture below is
// this real renderer's actual output, not a hand-modelled approximation —
// see the task-7a fix report for why that distinction mattered (a trailing
// `\n` inside every `<code>`, `<p>`-wrapping only on loose list items, etc).
const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

// Renders `source` the way plan-panel would build a block's editable DOM:
// a wrapper div holding whatever markdown-it rendered for it.
function render(source: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = md.render(source);
  return el;
}

// Task 1 post-processes a `- [ ] text` / `- [x] text` item into an `<li>`
// whose first child is a manufactured `<input type="checkbox" disabled>`
// (or `checked disabled`) rather than leaving the brackets as literal text
// (see plan-dom-markdown.ts's module comment). Plain markdown-it (used by
// `render` above) doesn't do that GFM extension on its own, so this mirrors
// Task 1's substitution directly on the rendered HTML — a plain string
// replace of the exact prefix Task 1 replaces — rather than reimplementing
// its token-level post-processing here.
function renderTaskList(source: string): HTMLElement {
  const html = md
    .render(source)
    .replace(/<li>\[ \] /g, '<li><input type="checkbox" disabled> ')
    .replace(/<li>\[x\] /g, '<li><input type="checkbox" checked disabled> ');
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

// table/hr/other blocks don't render through markdown-it at all — per the
// full Task 7 spec they edit as a raw-markdown textarea, so their wrapper
// holds the source text itself, not rendered HTML.
function renderRaw(source: string): HTMLElement {
  const el = document.createElement("div");
  el.textContent = source;
  return el;
}

function original(kind: BlockKind, source: string, level?: number) {
  return { kind, level, source };
}

function headingLevel(source: string): number {
  return (source.match(/^#+/)?.[0] ?? "#").length;
}

describe("blockToMarkdown: round-trip against real markdown-it output", () => {
  it("heading", () => {
    const source = "## Title **x**";
    expect(blockToMarkdown(render(source), original("heading", source, headingLevel(source)))).toBe(
      source,
    );
  });

  it("paragraph: bold, italic, code, link, bare URL, image, escaped *", () => {
    const source =
      'Hello **x** and *y* and `z` and [link](https://a.com) and https://example.com and ![alt](https://img.example/a.png "title") and escaped \\*star\\*';
    expect(blockToMarkdown(render(source), original("paragraph", source))).toBe(source);
  });

  it("tight list", () => {
    const source = "- One\n- Two\n- Three";
    expect(blockToMarkdown(render(source), original("list", source))).toBe(source);
  });

  it("loose list", () => {
    const source = "- a\n\n- b\n  - nested";
    expect(blockToMarkdown(render(source), original("list", source))).toBe(source);
  });

  it("nested ordered list, start 0", () => {
    const source = "0. Zero\n   - Child";
    expect(blockToMarkdown(render(source), original("list", source))).toBe(source);
  });

  it("nested ordered list, start 10+", () => {
    const source = "10. Ten\n11. Eleven\n    - Child";
    expect(blockToMarkdown(render(source), original("list", source))).toBe(source);
  });

  it("task list", () => {
    const source = "- [ ] Todo\n- [x] Done";
    expect(blockToMarkdown(renderTaskList(source), original("list", source))).toBe(source);
  });

  it("fenced code with a language", () => {
    const source = "```js\nconst x = 1;\nconst y = 2;\n```";
    expect(blockToMarkdown(render(source), original("code", source))).toBe(source);
  });

  it("indented code", () => {
    const source = "    indented code\n    line2";
    expect(blockToMarkdown(render(source), original("code", source))).toBe(source);
  });

  it("quote with 2 paragraphs", () => {
    const source = "> Hello\n>\n> World";
    expect(blockToMarkdown(render(source), original("quote", source))).toBe(source);
  });

  it("table", () => {
    const source = "| A | B |\n| - | - |\n| 1 | 2 |";
    expect(blockToMarkdown(renderRaw(source), original("table", source))).toBe(source);
  });

  it("hr", () => {
    const source = "---";
    expect(blockToMarkdown(renderRaw(source), original("hr", source))).toBe(source);
  });
});

describe("blockToMarkdown: inline details", () => {
  it("hard break renders as two trailing spaces plus newline", () => {
    const source = "Line one  \nLine two";
    expect(blockToMarkdown(render(source), original("paragraph", source))).toBe(source);
  });

  it("mailto autolink round-trips as a bare address, not a markdown link", () => {
    const source = "mail me at foo@example.com";
    expect(blockToMarkdown(render(source), original("paragraph", source))).toBe(source);
  });

  it("inline code containing a backtick uses a longer fence", () => {
    const source = "code with backtick: ``a`b``";
    expect(blockToMarkdown(render(source), original("paragraph", source))).toBe(source);
  });

  it("image without a title", () => {
    const source = "![alt](https://img.example/a.png)";
    expect(blockToMarkdown(render(source), original("paragraph", source))).toBe(source);
  });
});

describe("blockToMarkdown: escaping and entities", () => {
  it("round-trips backslash-escaped *, _, ` and [ together", () => {
    const source = "Escaped \\*star\\*, \\_underscore\\_, \\`code\\`, and \\[bracket]";
    expect(blockToMarkdown(render(source), original("paragraph", source))).toBe(source);
  });

  it("escapes a freshly-typed character once the source shows it needed escaping", () => {
    // The block already escaped "*" once (elsewhere in its source); a *new*
    // "*" typed during editing gets escaped too, since the rule is
    // block-level (does this source ever escape "*"?), not per-position.
    const source = "Already \\*escaped\\* once";
    const el = render(source);
    (el.querySelector("p") as HTMLElement).textContent = "Already *escaped* once, and *more*";
    expect(blockToMarkdown(el, original("paragraph", source))).toBe(
      "Already \\*escaped\\* once, and \\*more\\*",
    );
  });

  it("leaves a freshly-typed character alone when the source never escaped it", () => {
    const source = "Hello world";
    const el = render(source);
    // Simulate an edit: the user typed a literal "*" that was never in the
    // source, escaped or not — nothing here tells us it needs escaping.
    (el.querySelector("p") as HTMLElement).textContent = "Hello *world*";
    expect(blockToMarkdown(el, original("paragraph", source))).toBe("Hello *world*");
  });

  it("leaves an unescaped character alone when the source used it unescaped", () => {
    const source = "5 * 3 = 15";
    expect(blockToMarkdown(render(source), original("paragraph", source))).toBe(source);
  });

  it("re-encodes & back to &amp; only when the source spelled it that way", () => {
    const entitySource = "Tom &amp; Jerry";
    expect(blockToMarkdown(render(entitySource), original("paragraph", entitySource))).toBe(
      entitySource,
    );

    const literalSource = "Tom & Jerry";
    expect(blockToMarkdown(render(literalSource), original("paragraph", literalSource))).toBe(
      literalSource,
    );
  });
});

describe("blockToMarkdown: task list checkboxes (Task 1's DOM shape)", () => {
  it("round-trips an unchecked item", () => {
    const source = "- [ ] Todo";
    expect(blockToMarkdown(renderTaskList(source), original("list", source))).toBe(source);
  });

  it("round-trips a checked item", () => {
    const source = "- [x] Done";
    expect(blockToMarkdown(renderTaskList(source), original("list", source))).toBe(source);
  });

  it("round-trips a nested task item", () => {
    const source = "- Parent\n  - [ ] Nested task";
    expect(blockToMarkdown(renderTaskList(source), original("list", source))).toBe(source);
  });

  it("still round-trips literal bracket text that isn't a checkbox", () => {
    // No <input> here — plain markdown-it text starting with "[note]" that
    // Task 1's substitution never touches (it only matches "[ ] "/"[x] ").
    const source = "- [note] Something";
    expect(blockToMarkdown(render(source), original("list", source))).toBe(source);
  });
});

describe("blockToMarkdown: ordered list start number", () => {
  it("renumbers sequentially from the DOM's current order even after a reorder", () => {
    // Started at 3; the DOM's second and third <li> have been swapped, so
    // the written-back list must still read 3, 4, 5 in DOM order rather
    // than copying the stale original numbers.
    const source = "3. Three\n4. Four\n5. Five";
    const el = render(source);
    const items = Array.from(el.querySelectorAll("li"));
    const ol = el.querySelector("ol") as HTMLElement;
    ol.innerHTML = "";
    ol.append(items[0] as Node, items[2] as Node, items[1] as Node);
    expect(blockToMarkdown(el, original("list", source))).toBe("3. Three\n4. Five\n5. Four");
  });
});

// Fix round 1, C1: a real contenteditable can end up with more than one
// top-level p/div/h* child (an unhandled Enter, a paste, an IME commit) even
// though plan-panel.ts's own edit-mode keydown/paste handlers try to
// prevent it — the converter itself must not silently keep only the first
// and drop the rest.
describe("blockToMarkdown: defensive against a split editable container (fix round 1, C1)", () => {
  it("paragraph: two top-level <p> children join with a hard break instead of dropping the second", () => {
    const source = "First line.";
    const el = render(source);
    const second = document.createElement("p");
    second.textContent = "Second line.";
    el.append(second);
    expect(blockToMarkdown(el, original("paragraph", source))).toBe("First line.  \nSecond line.");
  });

  it("paragraph: a stray top-level <div> (a real browser's own Enter split) also joins in", () => {
    const source = "First line.";
    const el = render(source);
    const second = document.createElement("div");
    second.textContent = "Second line.";
    el.append(second);
    expect(blockToMarkdown(el, original("paragraph", source))).toBe("First line.  \nSecond line.");
  });

  // Fix round 2, item 6 (controller ruling): headings are single-line, so
  // the defensive join uses a space here, not paragraph's hard break — a
  // heading can never legitimately contain one.
  it("heading: a stray sibling block joins in with a space rather than a hard break", () => {
    const source = "# Title";
    const el = render(source);
    const second = document.createElement("div");
    second.textContent = "More.";
    el.append(second);
    expect(blockToMarkdown(el, original("heading", source, 1))).toBe("# Title More.");
  });

  it("paragraph: a single top-level <p> still round-trips exactly as before (no regression)", () => {
    const source = "Hello **world**.";
    expect(blockToMarkdown(render(source), original("paragraph", source))).toBe(source);
  });
});

// Fix round 2, item 7: quoteToMarkdown only ever collected `:scope > p`
// children — a stray top-level <div> or bare text node beside them (the
// same category of bug C1 fixed for paragraph/heading) was silently
// dropped instead of joined in as its own paragraph.
describe("blockToMarkdown: quote keeps stray top-level children (fix round 2, item 7)", () => {
  it("a stray top-level <div> beside <p> children joins in as its own paragraph", () => {
    const source = "> Hello";
    const el = render(source);
    const blockquote = el.querySelector("blockquote")!;
    const stray = document.createElement("div");
    stray.textContent = "World";
    blockquote.append(stray);
    expect(blockToMarkdown(el, original("quote", source))).toBe("> Hello\n>\n> World");
  });

  it("a stray bare top-level text node beside <p> children joins in as its own paragraph", () => {
    const source = "> Hello";
    const el = render(source);
    const blockquote = el.querySelector("blockquote")!;
    blockquote.append(document.createTextNode("World"));
    expect(blockToMarkdown(el, original("quote", source))).toBe("> Hello\n>\n> World");
  });

  it("still round-trips an ordinary multi-paragraph quote exactly as before (no regression)", () => {
    const source = "> Hello\n>\n> World";
    expect(blockToMarkdown(render(source), original("quote", source))).toBe(source);
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
