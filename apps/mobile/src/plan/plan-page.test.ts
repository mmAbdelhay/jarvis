import { describe, expect, it } from "vitest";
import type { AnchoredComment, PlanDoc } from "./types";
import { buildPlanPage, parsePlanPageMessage } from "./plan-page";

const colors = {
  surface: "rgb(1,2,3)",
  ground: "rgb(4,5,6)",
  text: "rgb(7,8,9)",
  textSecondary: "rgb(10,11,12)",
  accent: "rgb(13,14,15)",
  warning: "rgb(16,17,18)",
  selected: "rgb(19,20,21)",
};

const doc: PlanDoc = {
  path: "/repo/plan.md",
  mtimeMs: 1,
  blocks: [
    {
      id: "a<1",
      kind: "paragraph",
      start: 0,
      end: 4,
      source: "raw < text",
      html: "<p><strong>Already sanitized</strong> &amp; rendered</p>",
    },
  ],
};

const comments: AnchoredComment[] = [
  {
    id: "c<1",
    path: doc.path,
    blockId: "a<1",
    quote: "raw < text",
    body: "look < here",
    createdAt: 1,
    number: 7,
    anchor: { kind: "block", blockId: "a<1", text: "raw < text" },
  },
];

describe("buildPlanPage", () => {
  it("keeps pre-sanitized block html and installs the required isolated CSP", () => {
    const page = buildPlanPage(doc, comments, "en", colors);
    expect(page).toContain(
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    );
    expect(page).toContain(doc.blocks[0]!.html);
    expect(page).not.toContain("&lt;strong&gt;");
  });

  it("does not embed unused comment JSON and uses the supplied theme colours", () => {
    const page = buildPlanPage(doc, comments, "en", colors);
    expect(page).not.toContain("const comments=");
    expect(page).not.toContain("look < here");
    expect(page).toContain(`background:${colors.surface}`);
    expect(page).toContain(`background:${colors.warning}`);
  });

  it("sets RTL for Arabic, draws a 36px gutter pin, and posts block ids", () => {
    const page = buildPlanPage(doc, comments, "ar", colors);
    expect(page).toContain('<html lang="ar" dir="rtl">');
    expect(page).toContain("width:36px");
    expect(page).toContain('<span class="pin">7</span>');
    expect(page).not.toContain('<button class="pin"');
    expect(page).toContain('JSON.stringify({type:"block",id:block.dataset.blockId})');
    expect(page).toContain('if(event.target.closest("a"))return');
  });
});

// Final fix wave I5: a link tap never navigates the WebView — the page
// cancels it and hands the href to React Native, which opens only http(s).
describe("plan page links", () => {
  it("the page script cancels a link tap and posts {type:'link', href} instead of a block id", () => {
    const linkDoc: PlanDoc = {
      ...doc,
      blocks: [{ ...doc.blocks[0]!, html: '<p>See <a href="https://example.com/x">docs</a></p>' }],
    };
    const page = buildPlanPage(linkDoc, [], "en", colors);
    const script = page.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
    const posted: string[] = [];
    const listeners: Array<(event: unknown) => void> = [];
    let prevented = false;
    const anchor = {
      getAttribute: (name: string) => (name === "href" ? "https://example.com/x" : null),
    };
    const target = {
      closest: (selector: string) => (selector === "a[href]" || selector === "a" ? anchor : null),
    };
    const fakeDocument = {
      addEventListener: (_type: string, listener: (event: unknown) => void) =>
        listeners.push(listener),
      querySelectorAll: () => [],
    };
    const fakeWindow = { ReactNativeWebView: { postMessage: (data: string) => posted.push(data) } };
    new Function("window", "document", script)(fakeWindow, fakeDocument);

    for (const listener of listeners) {
      listener({ target, preventDefault: () => (prevented = true) });
    }

    expect(prevented).toBe(true);
    expect(posted.map((data) => JSON.parse(data))).toEqual([
      { type: "link", href: "https://example.com/x" },
    ]);
  });

  it("parsePlanPageMessage opens only http(s) links", () => {
    const link = (href: string) => parsePlanPageMessage(JSON.stringify({ type: "link", href }));
    expect(link("https://example.com/a")).toEqual({ kind: "link", url: "https://example.com/a" });
    expect(link("http://example.com/a")).toEqual({ kind: "link", url: "http://example.com/a" });
    // Bug fix: the validated URL is a `new URL(href)` object, but the raw,
    // unparsed `href` string was returned instead of its own `.href` --
    // handing the OS the string that was validated only in shape, not the
    // one that was actually parsed (a classic validate-one-thing,
    // act-on-another gap). The default-port case below is a deterministic,
    // Node-stable way to prove the two diverge.
    expect(link("https://example.com:443/a")).toEqual({
      kind: "link",
      url: "https://example.com/a",
    });
    expect(link("jarvis://pair?x=1")).toBeUndefined();
    expect(link("javascript:alert(1)")).toBeUndefined();
    expect(link("JavaScript:alert(1)")).toBeUndefined();
    expect(link("data:text/html,hi")).toBeUndefined();
    expect(link("/relative")).toBeUndefined();
    expect(parsePlanPageMessage(JSON.stringify({ type: "block", id: "b1" }))).toEqual({
      kind: "block",
      id: "b1",
    });
    expect(parsePlanPageMessage("not json")).toBeUndefined();
    expect(parsePlanPageMessage(JSON.stringify({ type: "link", href: 5 }))).toBeUndefined();
  });
});
