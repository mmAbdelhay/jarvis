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
