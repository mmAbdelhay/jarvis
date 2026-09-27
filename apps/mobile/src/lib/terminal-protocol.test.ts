import { describe, expect, it } from "vitest";
import { encodeNativeMessage, parseFrameMessage, parsePageMessage } from "./terminal-protocol";

describe("parsePageMessage", () => {
  it("parses a valid ready message to exactly its fields", () => {
    expect(parsePageMessage(JSON.stringify({ t: "ready", cols: 80, rows: 24 }))).toEqual({
      t: "ready",
      cols: 80,
      rows: 24,
    });
  });

  it("parses a valid resize message to exactly its fields", () => {
    expect(parsePageMessage(JSON.stringify({ t: "resize", cols: 120, rows: 40 }))).toEqual({
      t: "resize",
      cols: 120,
      rows: 40,
    });
  });

  it("parses a valid modes message to exactly its fields", () => {
    expect(parsePageMessage(JSON.stringify({ t: "modes", applicationCursor: true }))).toEqual({
      t: "modes",
      applicationCursor: true,
    });
  });

  it("rejects cols: 0", () => {
    expect(parsePageMessage(JSON.stringify({ t: "ready", cols: 0, rows: 24 }))).toBeUndefined();
  });

  it("rejects cols: 1001", () => {
    expect(parsePageMessage(JSON.stringify({ t: "ready", cols: 1001, rows: 24 }))).toBeUndefined();
  });

  it('rejects cols: "80" (string, not a number)', () => {
    expect(parsePageMessage(JSON.stringify({ t: "ready", cols: "80", rows: 24 }))).toBeUndefined();
  });

  it("rebuilds an extra-field object without the extras", () => {
    expect(
      parsePageMessage(JSON.stringify({ t: "ready", cols: 80, rows: 24, evil: "<script>" })),
    ).toEqual({ t: "ready", cols: 80, rows: 24 });
  });

  it("parses a valid wheel message to exactly its fields", () => {
    expect(parsePageMessage(JSON.stringify({ t: "wheel", direction: "up" }))).toEqual({
      t: "wheel",
      direction: "up",
    });
    expect(parsePageMessage(JSON.stringify({ t: "wheel", direction: "down" }))).toEqual({
      t: "wheel",
      direction: "down",
    });
  });

  it('rejects a wheel message with a direction other than "up"/"down"', () => {
    expect(parsePageMessage(JSON.stringify({ t: "wheel", direction: "sideways" }))).toBeUndefined();
    expect(parsePageMessage(JSON.stringify({ t: "wheel" }))).toBeUndefined();
  });

  it('rejects an unknown message type ({t: "input", data: "x"})', () => {
    expect(parsePageMessage(JSON.stringify({ t: "input", data: "x" }))).toBeUndefined();
  });

  it("rejects non-string input", () => {
    expect(parsePageMessage({ t: "ready", cols: 80, rows: 24 })).toBeUndefined();
    expect(parsePageMessage(42)).toBeUndefined();
    expect(parsePageMessage(undefined)).toBeUndefined();
  });

  it("rejects strings over 256 chars", () => {
    const padding = "x".repeat(300);
    const text = JSON.stringify({ t: "ready", cols: 80, rows: 24, padding });
    expect(text.length).toBeGreaterThan(256);
    expect(parsePageMessage(text)).toBeUndefined();
  });

  it("rejects malformed JSON", () => {
    expect(parsePageMessage("{not json")).toBeUndefined();
  });

  it("rejects a JSON array", () => {
    expect(parsePageMessage("[1,2,3]")).toBeUndefined();
  });
});

describe("encodeNativeMessage", () => {
  it("round-trips a write message through JSON.parse", () => {
    const encoded = encodeNativeMessage({ t: "write", data: "hello\r\n" });
    expect(JSON.parse(encoded)).toEqual({ t: "write", data: "hello\r\n" });
  });

  it("round-trips a reset message through JSON.parse", () => {
    const encoded = encodeNativeMessage({ t: "reset" });
    expect(JSON.parse(encoded)).toEqual({ t: "reset" });
  });

  it("round-trips a fit message through JSON.parse", () => {
    const encoded = encodeNativeMessage({ t: "fit" });
    expect(JSON.parse(encoded)).toEqual({ t: "fit" });
  });

  // Bug 8: tells the page the pty's real size, so it resizes to match
  // instead of fitting to the WebView's own dimensions.
  it("round-trips a size message through JSON.parse", () => {
    const encoded = encodeNativeMessage({ t: "size", cols: 80, rows: 24 });
    expect(JSON.parse(encoded)).toEqual({ t: "size", cols: 80, rows: 24 });
  });
});

describe("parseFrameMessage (web iframe, Task 13)", () => {
  const frameWindow = { name: "terminal-frame" };
  const ready = JSON.stringify({ t: "ready", cols: 80, rows: 24 });

  it("parses a message whose source is the terminal iframe's own window", () => {
    expect(parseFrameMessage({ source: frameWindow, data: ready }, frameWindow)).toEqual({
      t: "ready",
      cols: 80,
      rows: 24,
    });
  });

  it("drops a well-formed message from any other source", () => {
    expect(
      parseFrameMessage({ source: { name: "other" }, data: ready }, frameWindow),
    ).toBeUndefined();
    expect(parseFrameMessage({ source: null, data: ready }, frameWindow)).toBeUndefined();
  });

  it("drops everything while the iframe has no window yet (null/undefined never match)", () => {
    expect(parseFrameMessage({ source: null, data: ready }, null)).toBeUndefined();
    expect(parseFrameMessage({ source: undefined, data: ready }, undefined)).toBeUndefined();
  });

  it("still runs the field-by-field parse on a message from the iframe", () => {
    expect(
      parseFrameMessage({ source: frameWindow, data: JSON.stringify({ t: "evil" }) }, frameWindow),
    ).toBeUndefined();
    expect(
      parseFrameMessage({ source: frameWindow, data: { t: "ready" } }, frameWindow),
    ).toBeUndefined();
  });
});
