import { describe, expect, it } from "vitest";
import { parseUpdatesList } from "./updates.js";

describe("parseUpdatesList (M2 contracts §2)", () => {
  it("counts items and security items and converts checkedAt to epoch ms", () => {
    expect(
      parseUpdatesList(
        {
          items: [
            { source: "apt", id: "jarvis-shell", from: "0.1.0", to: "0.2.0", security: false },
            {
              source: "apt",
              id: "openssl",
              from: "3.5.1-1",
              to: "3.5.1-1+deb13u1",
              security: true,
            },
            {
              source: "flatpak",
              id: "org.mozilla.firefox",
              from: "130",
              to: "131",
              security: true,
            },
          ],
          checkedAt: "2026-10-08T09:00:00Z",
        },
        5,
      ),
    ).toEqual({ count: 3, security: 2, checkedAt: Date.parse("2026-10-08T09:00:00Z") });
  });

  it("skips malformed and duplicate items, and falls back to now for a bad checkedAt", () => {
    expect(
      parseUpdatesList(
        {
          items: [
            { source: "apt", id: "a", security: true },
            { source: "apt", id: "a", security: true },
            { source: "snap", id: "b" },
            { source: "apt", id: 7 },
            "x",
          ],
          checkedAt: "yesterday",
        },
        1_000,
      ),
    ).toEqual({ count: 1, security: 1, checkedAt: 1_000 });
  });

  it("refuses an answer without an items array", () => {
    expect(parseUpdatesList({ ok: true }, 1)).toBeUndefined();
    expect(parseUpdatesList(null, 1)).toBeUndefined();
  });
});
