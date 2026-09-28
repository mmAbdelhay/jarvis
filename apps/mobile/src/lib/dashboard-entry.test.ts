import { describe, expect, it } from "vitest";
import { dashboardEntryAction, shouldConnectOnRoute } from "./dashboard-entry";

describe("dashboardEntryAction", () => {
  it("connects when the read succeeded and found a pairing", () => {
    expect(dashboardEntryAction({ ok: true, found: true })).toBe("connect");
  });

  it("routes to /pair when the read succeeded but found nothing (I1 bite-proof)", () => {
    // Flip this branch to "connect" and the assertion below fails: an
    // unpaired phone reaching /dashboard must never be told to connect.
    expect(dashboardEntryAction({ ok: true, found: false })).toBe("routeToPair");
  });

  it("routes to /pair when the read itself failed (I1)", () => {
    expect(dashboardEntryAction({ ok: false })).toBe("routeToPair");
  });
});

describe("shouldConnectOnRoute (D3)", () => {
  it("connects at launch whatever route loaded, not only /dashboard", () => {
    for (const path of ["/unlock", "/voice", "/settings", "/terminal/abc", "/", "/dashboard"]) {
      expect(shouldConnectOnRoute(path, false)).toBe(true);
    }
  });

  it("after launch, connects again only on reaching /dashboard", () => {
    expect(shouldConnectOnRoute("/dashboard", true)).toBe(true);
    expect(shouldConnectOnRoute("/unlock", true)).toBe(false);
    expect(shouldConnectOnRoute("/settings", true)).toBe(false);
  });

  it("never connects from /pair, at launch or later", () => {
    expect(shouldConnectOnRoute("/pair", false)).toBe(false);
    expect(shouldConnectOnRoute("/pair", true)).toBe(false);
  });
});
