// The append-only `audit.log`: every pairing, connection, auth failure and
// revocation the bridge sees, one printable-ASCII line per event. No
// `AuditEvent` variant carries a token or secret — only ids, names and
// reasons — so logging is never the leak.

import { dirname } from "node:path";
import { describeError, ensurePrivateDir, tightenFileMode } from "./io.js";
import type { Clock, RemoteFs } from "./io.js";
import type { SidecarKind } from "./sidecar-registry.js";

export type AuditEvent =
  | { kind: "listening"; host: string; port: number; fingerprintTail: string }
  | { kind: "stopped" }
  | { kind: "pairing-opened"; expiresAt: number }
  | { kind: "pairing-closed"; reason: "expired" | "cancelled" }
  | { kind: "pairing-requested"; source: string; deviceName: string }
  | { kind: "paired"; source: string; deviceId: string; deviceName: string }
  | {
      kind: "pairing-denied";
      source: string;
      deviceName: string;
      reason: "denied" | "timed-out" | "cancelled" | "abandoned";
    }
  | {
      kind: "pairing-refused";
      source: string;
      reason: "bad-frame" | "timeout" | "version" | "closed" | "mismatch" | "busy";
    }
  | { kind: "connected"; source: string; deviceId: string }
  | { kind: "disconnected"; deviceId: string; code: number }
  | {
      kind: "auth-failed";
      source: string;
      reason: "bad-frame" | "bad-credentials" | "timeout" | "backoff";
    }
  | { kind: "refused"; source: string; reason: "capacity" }
  | {
      kind: "revoked";
      deviceId: string;
      closedSockets: number;
      // M11 Task 2 fix round 1 (controller ruling): a revoked device's live
      // proxied sockets, closed the same moment as its `/rpc` sessions.
      closedSidecarSockets: number;
    }
  | { kind: "error"; detail: string }
  // M10: a phone's Expo push registration beside its device record — never
  // the token itself, only the platform (or, on clearing, why).
  | { kind: "push-registered"; deviceId: string; platform: "ios" | "android" }
  | {
      kind: "push-cleared";
      deviceId: string;
      reason: "unregistered" | "not-registered" | "superseded";
    }
  // M11: recorded whenever the sidecar registry loses one or more live
  // handles at once — a single device's revoke, or every handle at a
  // listener teardown/restart/stop. Never the handle, key or cookie itself
  // (rule: no AuditEvent variant carries a token or secret).
  | { kind: "sidecars-cleared"; count: number }
  | { kind: "sidecar-published"; deviceId: string; sidecar: SidecarKind; handleTail: string }
  // M12 Task 1: the bridge's own idle timer disabled it — never anything
  // but the minute count (no device id, no address, nothing else).
  | { kind: "idle-disabled"; afterMinutes: number }
  // M12 Task 3: every mutating remote call ("always"), the first call per
  // (channel, key) on an input-stream channel ("first-per-key"), and every
  // refused probe (forbidden/unknown-channel) up to connection.ts's own
  // per-connection cap. `key` — present only for a first-per-key channel —
  // is the channel's own bounded identifier (a session id, a pane key),
  // never a command, a path or a body: connection.ts only ever lets
  // through the first element of `args` when it is a string of 1-64
  // characters, and nothing else `args` carries ever reaches this line.
  | {
      kind: "remote-call";
      deviceId: string;
      channel: string;
      outcome: "ok" | "error" | "forbidden" | "unknown-channel";
      key?: string;
    }
  // M12 Task 3: every push actually queued for a device — never the token,
  // the title, the body or the project name (notify.ts's own audit() call
  // never hands this file any of those; only a device id and the push's
  // generic kind word).
  | { kind: "push-queued"; deviceId: string; pushKind: string };

export type AuditLog = { record(event: AuditEvent): void; flushed(): Promise<void> };

/** I4: once `audit.log` would exceed this, it is rotated to `audit.log.1`
 *  (replacing any previous `.1`, kept 0600) before the next line is
 *  written — an unbounded audit log is itself a resource a hostile source
 *  can exhaust the disk with, same as the connection/pending caps above it
 *  in the file. One rotation, not a numbered series: an operator wants
 *  "what happened recently" and "one prior file for continuity", not a
 *  `logrotate` reimplementation. */
export const AUDIT_MAX_BYTES = 5 * 1024 * 1024;

/** Every code unit outside printable ASCII (space through `~`), escaped as `\uXXXX` — one escape per UTF-16 code unit, so a surrogate pair becomes two. */
function escapeNonAscii(text: string): string {
  return text.replace(
    /[^\x20-\x7e]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * `${ISO time} ${kind}` then ` key=value` for every other field, sorted by
 * key, `value` being `JSON.stringify` with every non-ASCII code unit
 * escaped — so an attacker-controlled field (a device name, say) can never
 * inject a raw newline or an unescaped quote into the log, no matter what
 * it contains. Always ends in exactly one `\n`.
 */
export function formatAuditLine(at: number, event: AuditEvent): string {
  const record = event as unknown as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => key !== "kind")
    .sort();
  const fields = keys
    .map((key) => ` ${key}=${escapeNonAscii(JSON.stringify(record[key]))}`)
    .join("");
  return `${new Date(at).toISOString()} ${record.kind}${fields}\n`;
}

export function createAuditLog(deps: {
  fs: RemoteFs;
  path: string;
  now: Clock;
  enforceFileModes: boolean;
  onError(detail: string): void;
}): AuditLog {
  const { fs, path, now, enforceFileModes, onError } = deps;
  const dir = dirname(path);

  // Every append is queued here, so lines land on disk in the order
  // `record` was called, never interleaved or reordered by however long an
  // individual write takes.
  let chain: Promise<void> = Promise.resolve();
  // `ensurePrivateDir` only needs to run once — every append after the
  // first already knows the directory exists.
  let dirEnsured = false;
  // The running byte size of `path`, tracked rather than `stat()`-ed on
  // every append (RemoteFs's `stat` reports only a mode, not a size).
  // `undefined` until the first append has read whatever was already on
  // disk, so a process restart picks up mid-file rather than rotating a
  // file that was already near the cap the moment it starts.
  let size: number | undefined;

  async function knownSize(): Promise<number> {
    if (size !== undefined) return size;
    try {
      size = Buffer.byteLength(await fs.readFile(path), "utf8");
    } catch {
      size = 0; // no existing file — a fresh audit.log starts at zero
    }
    return size;
  }

  function append(line: string): Promise<void> {
    const lineBytes = Buffer.byteLength(line, "utf8");
    const task = chain.then(async () => {
      if (!dirEnsured) {
        // Latch only after the mkdir actually succeeds: if it throws, the
        // directory still doesn't exist, so the *next* append must retry it
        // rather than skip straight to a doomed appendFile.
        await ensurePrivateDir(fs, dir, enforceFileModes);
        dirEnsured = true;
      }
      const current = await knownSize();
      if (current + lineBytes > AUDIT_MAX_BYTES) {
        try {
          await fs.rename(path, `${path}.1`);
          if (enforceFileModes) await fs.chmod(`${path}.1`, 0o600);
          size = 0;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException | undefined)?.code;
          if (code === "ENOENT") {
            // No existing file to rotate (a fresh log, or one already
            // rotated away by something else) — keep appending to `path`
            // rather than losing the line; `size` is already accurate
            // (knownSize() itself found nothing to read).
          } else {
            // A real rotation failure — permissions, a disk error — not
            // "nothing to rotate". Surfaced once rather than silently
            // swallowed, and `size` is resynced to the file's *real* byte
            // length: left stale (still over the cap from before this
            // attempt), every single future append would retry the same
            // failing rotate. Resynced from an actual read, the next
            // rotation attempt only fires once the file has genuinely
            // grown past the cap again.
            onError(`rotate audit.log: ${describeError(error)}`);
            try {
              size = Buffer.byteLength(await fs.readFile(path), "utf8");
            } catch {
              size = 0;
            }
          }
        }
      }
      await fs.appendFile(path, line, 0o600);
      await tightenFileMode(fs, path, enforceFileModes);
      size = (size ?? 0) + lineBytes;
    });
    // The chain itself must stay resolvable so a later append isn't skipped
    // just because an earlier one failed; `record` reports failures itself.
    chain = task.catch(() => undefined);
    return task;
  }

  return {
    record(event) {
      const line = formatAuditLine(now(), event);
      append(line).catch((error: unknown) => onError(describeError(error)));
    },

    flushed() {
      return chain;
    },
  };
}
