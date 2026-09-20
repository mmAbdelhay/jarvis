import { describe, expect, it } from "vitest";
import { connectionPillModel } from "./connection-pill";
import type { ConnectionView } from "./connection-store";

function view(partial: Partial<ConnectionView>): ConnectionView {
  return { state: "open", stale: false, ...partial };
}

describe("connectionPillModel", () => {
  it("shows conn.connected/success for open and fresh", () => {
    expect(connectionPillModel(view({ state: "open", stale: false }))).toEqual({
      key: "conn.connected",
      tone: "success",
    });
  });

  it("shows conn.stale/warning for open and stale", () => {
    expect(connectionPillModel(view({ state: "open", stale: true }))).toEqual({
      key: "conn.stale",
      tone: "warning",
    });
  });

  it("shows conn.connecting/warning for connecting and authenticating", () => {
    expect(connectionPillModel(view({ state: "connecting" }))).toEqual({
      key: "conn.connecting",
      tone: "warning",
    });
    expect(connectionPillModel(view({ state: "authenticating" }))).toEqual({
      key: "conn.connecting",
      tone: "warning",
    });
  });

  it("shows conn.reconnecting/warning for reconnecting", () => {
    expect(connectionPillModel(view({ state: "reconnecting" }))).toEqual({
      key: "conn.reconnecting",
      tone: "warning",
    });
  });

  it("shows conn.offline/danger for closed, idle, unpaired and incompatible", () => {
    for (const state of ["closed", "idle", "unpaired", "incompatible"] as const) {
      expect(connectionPillModel(view({ state }))).toEqual({
        key: "conn.offline",
        tone: "danger",
      });
    }
  });
});
