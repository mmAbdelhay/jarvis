import { describe, expect, it } from "vitest";
import { bannerModel } from "./banner-model";
import type { ConnectionView } from "./connection-store";

function view(partial: Partial<ConnectionView>): ConnectionView {
  return { state: "idle", stale: false, ...partial };
}

describe("bannerModel", () => {
  it(
    "shows conn.pinMismatch with pairAgain:true whenever pinMismatch is latched, regardless of state " +
      "[bite-proof: drop the pinMismatch branch and this loses the pairAgain button]",
    () => {
      expect(bannerModel(view({ state: "reconnecting", stale: true, pinMismatch: true }))).toEqual({
        key: "conn.pinMismatch",
        pairAgain: true,
      });
      expect(bannerModel(view({ state: "connecting", pinMismatch: true }))).toEqual({
        key: "conn.pinMismatch",
        pairAgain: true,
      });
    },
  );

  it("shows nothing for idle", () => {
    expect(bannerModel(view({ state: "idle" }))).toBeUndefined();
  });

  it("shows conn.connecting for both connecting and authenticating, no pairAgain", () => {
    expect(bannerModel(view({ state: "connecting" }))).toEqual({
      key: "conn.connecting",
      pairAgain: false,
    });
    expect(bannerModel(view({ state: "authenticating" }))).toEqual({
      key: "conn.connecting",
      pairAgain: false,
    });
  });

  it("shows conn.reconnecting without pairAgain when not pin-mismatched", () => {
    expect(bannerModel(view({ state: "reconnecting" }))).toEqual({
      key: "conn.reconnecting",
      pairAgain: false,
    });
  });

  it("shows conn.offline for closed, without pairAgain", () => {
    expect(bannerModel(view({ state: "closed" }))).toEqual({
      key: "conn.offline",
      pairAgain: false,
    });
  });

  it("shows conn.unpaired without pairAgain", () => {
    expect(bannerModel(view({ state: "unpaired" }))).toEqual({
      key: "conn.unpaired",
      pairAgain: false,
    });
  });

  it("shows conn.incompatible without pairAgain", () => {
    expect(bannerModel(view({ state: "incompatible" }))).toEqual({
      key: "conn.incompatible",
      pairAgain: false,
    });
  });

  it("shows conn.stale when open and stale; nothing when open and fresh", () => {
    expect(bannerModel(view({ state: "open", stale: true }))).toEqual({
      key: "conn.stale",
      pairAgain: false,
    });
    expect(bannerModel(view({ state: "open", stale: false }))).toBeUndefined();
  });
});
