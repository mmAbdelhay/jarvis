import { describe, expect, it } from "vitest";
import type { AnchoredComment, PlanDoc } from "./types";
import { buildPlanPage } from "./plan-page";

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
