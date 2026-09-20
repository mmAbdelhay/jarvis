import { describe, expect, it } from "vitest";
import { encodeNativeMessage, parsePageMessage } from "./terminal-protocol";

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
});
