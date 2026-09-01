import { describe, expect, it } from "vitest";
import { dispatcherFor } from "./network.js";

describe("dispatcherFor", () => {
  // The common case should cost nothing.
  it("returns nothing when the defaults will do", () => {
    expect(dispatcherFor({ verifyCertificate: true, timeoutMs: 0 })).toBeUndefined();
  });

  it("builds an agent when certificate verification is switched off", () => {
    expect(dispatcherFor({ verifyCertificate: false, timeoutMs: 0 })).toBeDefined();
  });

  it("builds a proxy agent when a proxy is named", () => {
    expect(
      dispatcherFor({ verifyCertificate: true, timeoutMs: 0, proxyUrl: "http://proxy:8080" }),
    ).toBeDefined();
  });

  it("ignores an empty proxy string rather than treating it as a proxy", () => {
    expect(dispatcherFor({ verifyCertificate: true, timeoutMs: 0, proxyUrl: "" })).toBeUndefined();
  });
});
