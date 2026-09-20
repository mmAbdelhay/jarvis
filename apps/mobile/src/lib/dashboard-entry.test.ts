import { describe, expect, it } from "vitest";
import { dashboardEntryAction } from "./dashboard-entry";

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
