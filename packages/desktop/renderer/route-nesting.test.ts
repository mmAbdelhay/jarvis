import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

// Each routed view (#view-dashboard, #view-changes, #view-session,
// #view-workspace) is toggled independently by views.ts's showView, which
// sets `hidden` on the ONE view being shown and leaves the rest hidden.
// That only works if all four are siblings under the same parent: if one
// landed nested inside another (exactly what happened when #view-workspace
// was pasted inside #view-session instead of after its closing tag —
// verified live, where clicking Workspace showed a blank screen because
// its ancestor #view-session was still `[hidden]`), showView can clear the
// child's own `hidden` attribute and the view still renders nothing,
// because the UA's `[hidden] { display: none }` cascades from the
// still-hidden ancestor. No unit test using a synthetic DOM fragment can
// catch this class of bug — it requires parsing the real markup.
const htmlSource = readFileSync(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8");

const ROUTE_IDS = ["view-dashboard", "view-changes", "view-session", "view-workspace"];

describe("routed view nesting", () => {
  const dom = new JSDOM(htmlSource);
  const document = dom.window.document;

  it("finds every routed view in the real markup (sanity check the fixture itself)", () => {
    for (const id of ROUTE_IDS) {
      expect(document.getElementById(id), `#${id} not found in index.html`).not.toBeNull();
    }
  });

  it.each(ROUTE_IDS)("keeps %s a direct child of the shared app root, not nested in another route", (id) => {
    const element = document.getElementById(id);
    const parent = element?.parentElement;
    expect(parent?.id).toBe("app");
  });

  it("keeps no routed view nested inside another routed view", () => {
    for (const outerId of ROUTE_IDS) {
      const outer = document.getElementById(outerId);
      for (const innerId of ROUTE_IDS) {
        if (innerId === outerId) continue;
        expect(outer?.querySelector(`#${innerId}`), `#${innerId} found inside #${outerId}`).toBeNull();
      }
    }
  });
});
