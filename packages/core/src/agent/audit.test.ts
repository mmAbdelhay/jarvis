import { describe, expect, it } from "vitest";
import { auditInput, parseAuditEntry } from "./audit.js";

describe("auditInput", () => {
  it("drops secret fields the model sent and marks provided secrets hidden", () => {
    expect(
      auditInput({ ssid: "Home", password: "leaked-by-model" }, ["password"], ["password"]),
    ).toEqual({ ssid: "Home", password: "[hidden]" });
    expect(auditInput({ ssid: "Cafe" }, ["password"], [])).toEqual({ ssid: "Cafe" });
  });
});

describe("parseAuditEntry", () => {
  const entry = {
    ts: 1,
    tool: "pkg.install",
    title: "Install VLC",
    input: { items: [{ source: "apt", id: "vlc" }] },
    decision: "approved",
    via: "desktop",
    result: "ok",
  };

  it("keeps exactly the contract's fields", () => {
    expect(parseAuditEntry({ ...entry, extra: "x" })).toEqual(entry);
    expect(parseAuditEntry({ ...entry, result: "failed", message: "exit 100" })).toEqual({
      ...entry,
      result: "failed",
      message: "exit 100",
    });
  });

  it("refuses broken lines", () => {
    expect(parseAuditEntry(null)).toBeUndefined();
    expect(parseAuditEntry({ ...entry, decision: "maybe" })).toBeUndefined();
    expect(parseAuditEntry({ ...entry, ts: "1" })).toBeUndefined();
  });
});

describe("phone audit lines (Rafiq M3 §2)", () => {
  const line = {
    ts: 1,
    tool: "settings.brightness",
    title: "Set brightness to 80%",
    input: { percent: 80 },
    decision: "approved",
    result: "ok",
  };
  it("accepts via phone:<deviceName>", () => {
    expect(parseAuditEntry({ ...line, via: "phone:Pixel 8" })?.via).toBe("phone:Pixel 8");
  });
  it("refuses an empty, overlong or control-character phone name", () => {
    expect(parseAuditEntry({ ...line, via: "phone:" })).toBeUndefined();
    expect(parseAuditEntry({ ...line, via: `phone:${"a".repeat(65)}` })).toBeUndefined();
    expect(parseAuditEntry({ ...line, via: "phone:a\nb" })).toBeUndefined();
    expect(parseAuditEntry({ ...line, via: "phone:a\n" })).toBeUndefined();
    expect(parseAuditEntry({ ...line, via: "laptop" })).toBeUndefined();
  });
});
