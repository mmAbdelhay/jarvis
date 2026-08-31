// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { DocBlock } from "@jarvis/core";
import { renderDocument } from "./doc-view.js";

function html(blocks: DocBlock[]): string {
  const host = document.createElement("div");
  host.append(renderDocument(blocks));
  return host.innerHTML;
}

const text = (value: string) => ({ kind: "text" as const, text: value });

describe("renderDocument", () => {
  it("renders a heading at its level", () => {
    expect(html([{ kind: "heading", level: 2, children: [text("Title")] }])).toBe("<h2>Title</h2>");
  });

  it("renders a paragraph", () => {
    expect(html([{ kind: "paragraph", children: [text("Hello")] }])).toBe("<p>Hello</p>");
  });

  it("renders emphasis and strong", () => {
    expect(
      html([
        {
          kind: "paragraph",
          children: [
            { kind: "emphasis", children: [text("a")] },
            { kind: "strong", children: [text("b")] },
          ],
        },
      ]),
    ).toBe("<p><em>a</em><strong>b</strong></p>");
  });

  it("renders inline and block code", () => {
    expect(html([{ kind: "paragraph", children: [{ kind: "code", text: "x()" }] }])).toBe(
      "<p><code>x()</code></p>",
    );
    expect(html([{ kind: "code", language: "ts", text: "const x = 1;" }])).toBe(
      '<pre><code class="language-ts">const x = 1;</code></pre>',
    );
  });

  it("renders a link with its href", () => {
    const host = document.createElement("div");
    host.append(
      renderDocument([
        {
          kind: "paragraph",
          children: [{ kind: "link", href: "https://example.com", children: [text("here")] }],
        },
      ]),
    );
    const anchor = host.querySelector("a");

    expect(anchor?.getAttribute("href")).toBe("https://example.com");
    expect(anchor?.getAttribute("rel")).toBe("noreferrer noopener");
    expect(anchor?.textContent).toBe("here");
  });

  it("renders lists", () => {
    expect(
      html([
        {
          kind: "list",
          ordered: false,
          items: [[{ kind: "paragraph", children: [text("one")] }]],
        },
      ]),
    ).toBe("<ul><li><p>one</p></li></ul>");
  });

  it("renders an ordered list as ol", () => {
    expect(
      html([{ kind: "list", ordered: true, items: [[{ kind: "paragraph", children: [text("a")] }]] }]),
    ).toBe("<ol><li><p>a</p></li></ol>");
  });

  it("renders a blockquote and a rule", () => {
    expect(html([{ kind: "quote", children: [{ kind: "paragraph", children: [text("q")] }] }])).toBe(
      "<blockquote><p>q</p></blockquote>",
    );
    expect(html([{ kind: "rule" }])).toBe("<hr>");
  });

  it("renders a table with a header row", () => {
    expect(
      html([{ kind: "table", head: [[text("h")]], rows: [[[text("c")]]] }]),
    ).toBe("<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table>");
  });

  // The whole reason the model exists. Any markup in the source is a string
  // by the time it reaches here, and textContent keeps it one.
  it("renders markup in the text as visible characters, not as elements", () => {
    const host = document.createElement("div");
    host.append(renderDocument([{ kind: "paragraph", children: [text("<script>alert(1)</script>")] }]));

    expect(host.querySelector("script")).toBeNull();
    expect(host.textContent).toBe("<script>alert(1)</script>");
  });

  it("marks Arabic text right-to-left", () => {
    const host = document.createElement("div");
    host.append(renderDocument([{ kind: "paragraph", children: [text("تقرير الأخطاء")] }]));

    expect(host.querySelector("p")?.getAttribute("dir")).toBe("rtl");
  });

  it("renders an empty document as nothing", () => {
    expect(html([])).toBe("");
  });
});
