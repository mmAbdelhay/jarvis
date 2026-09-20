import { describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "./audit.js";
import { AUDIT_MAX_BYTES, createAuditLog, formatAuditLine } from "./audit.js";
import { memoryFs } from "./fs-double.js";

const PATH = "/remote/audit.log";

describe("formatAuditLine", () => {
  it("formats ISO time, kind, then sorted key=value fields", () => {
    const at = Date.UTC(2026, 8, 16, 9, 30);
    const event: AuditEvent = { kind: "connected", source: "1.2.3.4:5", deviceId: "d1" };
    expect(formatAuditLine(at, event)).toBe(
      '2026-09-16T09:30:00.000Z connected deviceId="d1" source="1.2.3.4:5"\n',
    );
  });

  it("[bite-proof] escapes an embedded quote and newline so the record stays on one line", () => {
    const at = 0;
    const injected = '\n1970-01-01T00:00:00.000Z paired deviceId="x"';
    const event: AuditEvent = { kind: "paired", source: "s", deviceId: "d", deviceName: injected };
    const line = formatAuditLine(at, event);

    expect(line.split("\n")).toHaveLength(2); // exactly one newline, at the end
    expect(line.endsWith("\n")).toBe(true);
    expect(line).toContain('\\"x\\"'); // the embedded quote is escaped, not raw
  });

  it("formats push-registered with deviceId and platform", () => {
    const event: AuditEvent = { kind: "push-registered", deviceId: "d1", platform: "ios" };
    expect(formatAuditLine(0, event)).toBe(
      '1970-01-01T00:00:00.000Z push-registered deviceId="d1" platform="ios"\n',
    );
  });

  it("formats push-cleared with deviceId and reason", () => {
    const event: AuditEvent = { kind: "push-cleared", deviceId: "d1", reason: "not-registered" };
    expect(formatAuditLine(0, event)).toBe(
      '1970-01-01T00:00:00.000Z push-cleared deviceId="d1" reason="not-registered"\n',
    );
  });

  it("formats idle-disabled with afterMinutes", () => {
    const event: AuditEvent = { kind: "idle-disabled", afterMinutes: 2 };
    expect(formatAuditLine(0, event)).toBe(
      "1970-01-01T00:00:00.000Z idle-disabled afterMinutes=2\n",
    );
  });

  // M12 Task 3.
  it("formats remote-call with channel, deviceId and outcome, and no key when absent", () => {
    const event: AuditEvent = {
      kind: "remote-call",
      deviceId: "d1",
      channel: "git:commit",
      outcome: "ok",
    };
    expect(formatAuditLine(0, event)).toBe(
      '1970-01-01T00:00:00.000Z remote-call channel="git:commit" deviceId="d1" outcome="ok"\n',
    );
  });

  it("formats remote-call with key when present", () => {
    const event: AuditEvent = {
      kind: "remote-call",
      deviceId: "d1",
      channel: "session:input",
      outcome: "ok",
      key: "s1",
    };
    expect(formatAuditLine(0, event)).toBe(
      '1970-01-01T00:00:00.000Z remote-call channel="session:input" deviceId="d1" key="s1" outcome="ok"\n',
    );
  });

  it("formats push-queued with deviceId and pushKind", () => {
    const event: AuditEvent = { kind: "push-queued", deviceId: "d1", pushKind: "session-done" };
    expect(formatAuditLine(0, event)).toBe(
      '1970-01-01T00:00:00.000Z push-queued deviceId="d1" pushKind="session-done"\n',
    );
  });

  it("escapes every non-ASCII code unit so the whole line is printable ASCII", () => {
    const event: AuditEvent = {
      kind: "pairing-requested",
      source: "s",
      deviceName: "هاتف\u{202e}",
    };
    const line = formatAuditLine(0, event);
    expect(line).toMatch(/^[\x20-\x7e]*\n$/);
  });
});

describe("createAuditLog", () => {
  it("writes a 0600 log file in a 0700 dir, with lines in record order", async () => {
    const fs = memoryFs();
    const log = createAuditLog({
      fs,
      path: PATH,
      now: () => 1_000,
      enforceFileModes: true,
      onError: vi.fn(),
    });

    log.record({ kind: "listening", host: "127.0.0.1", port: 1234, fingerprintTail: "abcd" });
    log.record({ kind: "stopped" });
    await log.flushed();

    expect(fs.dirs.get("/remote")).toBe(0o700);
    const entry = fs.files.get(PATH);
    expect(entry?.mode).toBe(0o600);
    const lines = (entry?.data ?? "").split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("listening");
    expect(lines[1]).toContain("stopped");
  });

  it("tightens an existing 0644 log file", async () => {
    const fs = memoryFs();
    fs.files.set(PATH, { data: "", mode: 0o644 });
    const log = createAuditLog({
      fs,
      path: PATH,
      now: () => 1,
      enforceFileModes: true,
      onError: vi.fn(),
    });

    log.record({ kind: "stopped" });
    await log.flushed();
    expect(fs.files.get(PATH)?.mode).toBe(0o600);
  });

  it("record() never throws, and routes an appendFile failure to onError", async () => {
    const fs = memoryFs();
    fs.appendFile = async () => {
      throw new Error("disk full");
    };
    const onError = vi.fn();
    const log = createAuditLog({ fs, path: PATH, now: () => 1, enforceFileModes: true, onError });

    expect(() => log.record({ kind: "stopped" })).not.toThrow();
    await log.flushed();
    expect(onError).toHaveBeenCalledWith("disk full");
  });

  // I4: an unbounded audit.log is itself a resource a hostile source can
  // exhaust the disk with.
  it("rotates to audit.log.1 (0600), replacing any previous one, once the cap would be exceeded", async () => {
    const fs = memoryFs();
    fs.files.set(PATH, { data: "x".repeat(AUDIT_MAX_BYTES - 10), mode: 0o600 });
    fs.files.set(`${PATH}.1`, { data: "stale rotation from before", mode: 0o600 });
    const log = createAuditLog({
      fs,
      path: PATH,
      now: () => 1,
      enforceFileModes: true,
      onError: vi.fn(),
    });

    log.record({ kind: "stopped" });
    await log.flushed();

    const rotated = fs.files.get(`${PATH}.1`);
    expect(rotated?.data).toBe("x".repeat(AUDIT_MAX_BYTES - 10));
    expect(rotated?.mode).toBe(0o600);

    const current = fs.files.get(PATH);
    expect(current?.data).toContain("stopped");
    expect(current?.data.startsWith("x")).toBe(false);
  });

  it("does not rotate while comfortably under the cap", async () => {
    const fs = memoryFs();
    fs.files.set(PATH, { data: "small\n", mode: 0o600 });
    const log = createAuditLog({
      fs,
      path: PATH,
      now: () => 1,
      enforceFileModes: true,
      onError: vi.fn(),
    });

    log.record({ kind: "stopped" });
    await log.flushed();

    expect(fs.files.has(`${PATH}.1`)).toBe(false);
    expect(fs.files.get(PATH)?.data.startsWith("small\n")).toBe(true);
  });

  it("keeps appending (no rotation) when there is no existing file to rotate", async () => {
    const fs = memoryFs();
    const log = createAuditLog({
      fs,
      path: PATH,
      now: () => 1,
      enforceFileModes: true,
      onError: vi.fn(),
    });

    log.record({ kind: "stopped" });
    await log.flushed();

    expect(fs.files.has(`${PATH}.1`)).toBe(false);
    expect(fs.files.get(PATH)?.data).toContain("stopped");
  });

  // Minor: a non-ENOENT rotation failure (permissions, a disk error) must
  // not be swallowed silently, and must not leave `size` stuck at its
  // stale, over-the-cap value — that would force every single future
  // append to retry the same failing rotate.
  it("surfaces a non-ENOENT rotation failure once and resyncs size from a fresh read, rather than losing the cap", async () => {
    const fs = memoryFs();
    const existing = "x".repeat(AUDIT_MAX_BYTES - 10);
    fs.files.set(PATH, { data: existing, mode: 0o600 });
    const permissionError = Object.assign(new Error("EPERM: operation not permitted"), {
      code: "EPERM",
    });
    let renameCalls = 0;
    fs.rename = async () => {
      renameCalls += 1;
      throw permissionError;
    };
    const onError = vi.fn();
    const log = createAuditLog({
      fs,
      path: PATH,
      now: () => 1,
      enforceFileModes: true,
      onError,
    });

    // First append: still over the cap, tries to rotate, fails, is
    // surfaced, and appends onto the existing (unrotated) file anyway.
    log.record({ kind: "stopped" });
    await log.flushed();
    expect(renameCalls).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("EPERM"));
    expect(fs.files.has(`${PATH}.1`)).toBe(false);
    expect(fs.files.get(PATH)?.data.startsWith(existing)).toBe(true);

    // Size was resynced from an actual read of the (still-over-cap) file
    // rather than left at a stale in-memory value, so the *next* append
    // still correctly sees itself as over the cap and retries rotation —
    // proving `size` tracks reality rather than going stale after a
    // failure, not that retries stop altogether (the file genuinely is
    // still too big).
    log.record({ kind: "stopped" });
    await log.flushed();
    expect(renameCalls).toBe(2);
    expect(onError).toHaveBeenCalledTimes(2);
  });
});
