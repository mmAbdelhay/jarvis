import { describe, expect, it } from "vitest";
import type { AnchoredComment, PlanDoc } from "./types";
import { buildPlanPage } from "./plan-page";

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
    anchor: { kind: "block", blockId: "a<1" },
  },
];

describe("buildPlanPage", () => {
  it("keeps pre-sanitized block html and installs the required isolated CSP", () => {
    const page = buildPlanPage(doc, comments, "en");
    expect(page).toContain(
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    );
    expect(page).toContain(doc.blocks[0]!.html);
    expect(page).not.toContain("&lt;strong&gt;");
  });

  it("embeds comment JSON with less-than characters escaped out of script context", () => {
    const page = buildPlanPage(doc, comments, "en");
    expect(page).toContain("c\\u003c1");
    expect(page).toContain("look \\u003c here");
    expect(page).not.toContain('"body":"look < here"');
  });

  it("sets RTL for Arabic, draws a 36px gutter pin, and posts block ids", () => {
    const page = buildPlanPage(doc, comments, "ar");
    expect(page).toContain('<html lang="ar" dir="rtl">');
    expect(page).toContain("width:36px");
    expect(page).toContain('<span class="pin">7</span>');
    expect(page).not.toContain('<button class="pin"');
    expect(page).toContain('JSON.stringify({type:"block",id:block.dataset.blockId})');
  });
});
