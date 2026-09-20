// The sidecar handle registry (M11, "sidecar proxy", rulings 5 and 7): the
// pure in-memory table mapping a short-lived `handle` to the loopback
// target it proxies to. A `handle` is minted once per opened sidecar tab,
// carries a one-time `key` that authenticates exactly the first request (the
// `?k=` on the URL the phone is handed) and a `cookie` that authenticates
// every request after (the WebView's cookie jar). Nothing here ever touches
// a socket, a clock, or a CSPRNG directly — both arrive through `deps`
// (io.ts's `RandomBytes`/`Clock`), so the eviction, TTL and expiry rules
// below are all tested against a fake clock advanced by hand, never a real
// timer.
//
// Ruling 5's bounds are enforced here, not by a caller: at most
// MAX_HANDLES_PER_DEVICE live handles per device (a 9th publish evicts the
// device's oldest), a handle lives at most HANDLE_MAX_AGE_MS, and a key is
// single-use within KEY_TTL_MS of its own handle's mint. `revokeDevice` and
// `clear` are how a device revoke / listener restart empties this table
// (ruling 5's "cleared on device revoke, on every listener stop/restart").

import { timingSafeEqual } from "node:crypto";
import type { Clock, RandomBytes } from "./io.js";

export const HANDLE_PATTERN = /^[0-9a-f]{32}$/;
export const KEY_PATTERN = /^[0-9a-f]{64}$/;
export const COOKIE_PATTERN = /^[0-9a-f]{64}$/;
export const HANDLE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const KEY_TTL_MS = 30_000;
export const MAX_HANDLES_PER_DEVICE = 8;

export type SidecarKind = "editor" | "database" | "cluster";
export type SidecarTarget = {
  kind: SidecarKind;
  port: number;
  basicAuth?: { login: string; password: string };
};
export type PublishedSidecar = { handle: string; key: string };
export type ResolvedSidecar = { handle: string; deviceId: string; target: SidecarTarget };

export type SidecarRegistry = {
  publish(deviceId: string, target: SidecarTarget): PublishedSidecar;
  redeemKey(handle: string, key: string): { cookie: string; target: SidecarTarget } | undefined;
  resolveCookie(handle: string, cookie: string): ResolvedSidecar | undefined;
  revokeDevice(deviceId: string): number;
  clear(): void;
  count(): number;
};

type Entry = {
  handle: string;
  deviceId: string;
  target: SidecarTarget;
  key: string;
  cookie: string;
  mintedAt: number;
  keyExpiresAt: number;
  keyUsed: boolean;
};

/** A copy of `target`, field-by-field — never the caller's own object, and never a reference an internal record shares with a caller. */
function copyTarget(target: SidecarTarget): SidecarTarget {
  return {
    kind: target.kind,
    port: target.port,
    ...(target.basicAuth === undefined
      ? {}
      : { basicAuth: { login: target.basicAuth.login, password: target.basicAuth.password } }),
  };
}

/**
 * True iff `candidate` equals `stored`, compared in constant time. Callers
 * must reject a `candidate` that fails its pattern (KEY_PATTERN/
 * COOKIE_PATTERN) *before* calling this — a `.length` check alone is not
 * enough to guarantee equal-length buffers: `.length` counts UTF-16 code
 * units, and a multi-byte character (e.g. "é") can make two strings the
 * same `.length` while their UTF-8 byte lengths differ, which
 * `timingSafeEqual` throws on. The pattern check guarantees `candidate` is
 * plain hex ASCII, so its UTF-8 byte length equals its `.length` and this
 * function's own length check (kept as defence in depth) can never in fact
 * mismatch a same-pattern `stored` value at this point — but never reaches
 * `timingSafeEqual` on an unequal length regardless.
 */
function constantTimeEquals(candidate: string, stored: string): boolean {
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(Buffer.from(candidate, "utf8"), Buffer.from(stored, "utf8"));
}

export function createSidecarRegistry(deps: { random: RandomBytes; now: Clock }): SidecarRegistry {
  const { random, now } = deps;

  const handles = new Map<string, Entry>();
  const byDevice = new Map<string, Set<string>>();

  function isExpired(entry: Entry): boolean {
    return now() - entry.mintedAt >= HANDLE_MAX_AGE_MS;
  }

  function deleteHandle(handle: string): void {
    const entry = handles.get(handle);
    if (entry === undefined) return;
    handles.delete(handle);
    const set = byDevice.get(entry.deviceId);
    set?.delete(handle);
    if (set !== undefined && set.size === 0) byDevice.delete(entry.deviceId);
  }

  /** Ruling 5: a 9th publish for the same device evicts that device's oldest handle first, by mintedAt. */
  function evictOldestIfFull(deviceId: string): void {
    const set = byDevice.get(deviceId);
    if (set === undefined || set.size < MAX_HANDLES_PER_DEVICE) return;
    let oldestHandle: string | undefined;
    let oldestMintedAt = Number.POSITIVE_INFINITY;
    for (const handle of set) {
      const entry = handles.get(handle);
      if (entry !== undefined && entry.mintedAt < oldestMintedAt) {
        oldestMintedAt = entry.mintedAt;
        oldestHandle = handle;
      }
    }
    if (oldestHandle !== undefined) deleteHandle(oldestHandle);
  }

  function publish(deviceId: string, target: SidecarTarget): PublishedSidecar {
    evictOldestIfFull(deviceId);

    const handle = random(16).toString("hex");
    const key = random(32).toString("hex");
    // The cookie is minted now, alongside the key, so redeeming the key
    // later never depends on fresh randomness at redeem time (brief rule 4).
    const cookie = random(32).toString("hex");
    const mintedAt = now();

    const entry: Entry = {
      handle,
      deviceId,
      target: copyTarget(target),
      key,
      cookie,
      mintedAt,
      keyExpiresAt: mintedAt + KEY_TTL_MS,
      keyUsed: false,
    };
    handles.set(handle, entry);
    let set = byDevice.get(deviceId);
    if (set === undefined) {
      set = new Set();
      byDevice.set(deviceId, set);
    }
    set.add(handle);

    return { handle, key };
  }

  function redeemKey(
    handle: string,
    key: string,
  ): { cookie: string; target: SidecarTarget } | undefined {
    if (!HANDLE_PATTERN.test(handle)) return undefined;
    const entry = handles.get(handle);
    if (entry === undefined) return undefined;
    if (isExpired(entry)) {
      deleteHandle(handle);
      return undefined;
    }
    if (entry.keyUsed) return undefined;
    if (now() > entry.keyExpiresAt) return undefined;
    if (!KEY_PATTERN.test(key)) return undefined;
    if (!constantTimeEquals(key, entry.key)) return undefined;

    entry.keyUsed = true;
    return { cookie: entry.cookie, target: copyTarget(entry.target) };
  }

  function resolveCookie(handle: string, cookie: string): ResolvedSidecar | undefined {
    if (!HANDLE_PATTERN.test(handle)) return undefined;
    const entry = handles.get(handle);
    if (entry === undefined) return undefined;
    if (isExpired(entry)) {
      deleteHandle(handle);
      return undefined;
    }
    if (!COOKIE_PATTERN.test(cookie)) return undefined;
    if (!constantTimeEquals(cookie, entry.cookie)) return undefined;

    return { handle: entry.handle, deviceId: entry.deviceId, target: copyTarget(entry.target) };
  }

  function revokeDevice(deviceId: string): number {
    const set = byDevice.get(deviceId);
    if (set === undefined) return 0;
    const toDelete = [...set];
    for (const handle of toDelete) deleteHandle(handle);
    return toDelete.length;
  }

  function clear(): void {
    handles.clear();
    byDevice.clear();
  }

  function count(): number {
    return handles.size;
  }

  return { publish, redeemKey, resolveCookie, revokeDevice, clear, count };
}
