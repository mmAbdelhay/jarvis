// Free-signing plan, work item 3: expiry awareness for sideloaded iOS
// builds. A free Apple-ID signature dies 7 days after signing; the date
// lives in the app bundle's `embedded.mobileprovision`, a CMS/DER blob
// with the provisioning plist embedded as plain XML text — so the
// `ExpirationDate` can be read with a text scan, no ASN.1 parser needed.
//
// This module is the pure half (unit-tested): base64 decode, the plist
// scan, the day arithmetic, and `armExpiryWarning`, which drives the
// banner state and the local notification over injected deps.
// `native-provisioning.ts` is the impure reader that feeds it, same
// loader/pure split as native-notifications.ts.
//
// Android and App Store/TestFlight builds have no embedded profile —
// `loadProvisioningExpiry` answers `undefined` and everything stays off.

export const PROVISIONING_PROFILE_NAME = "embedded.mobileprovision";
/** Banner threshold: fewer than 2 days left (plan §work item 3). */
export const EXPIRY_WARN_MS = 2 * 24 * 60 * 60 * 1000;
/** The local notification fires one day before the profile dies. */
export const EXPIRY_NOTIFY_BEFORE_MS = 24 * 60 * 60 * 1000;
export const EXPIRY_NOTIFICATION_ID = "provisioning-expiry";

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_VALUES = new Map<string, number>([...B64_ALPHABET].map((char, index) => [char, index]));

/**
 * Base64 → binary string (one char per byte, latin1). Hand-rolled because
 * neither Buffer nor atob is a dependable global across Hermes versions,
 * and the input is a ~10 KB profile read once. Whitespace and `=` padding
 * are skipped; any other foreign character makes the input untrustworthy,
 * so the answer is `undefined` rather than a silently mangled blob.
 */
export function decodeBase64(b64: string): string | undefined {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of b64) {
    if (char === "=" || char === "\n" || char === "\r" || char === " " || char === "\t") continue;
    const value = B64_VALUES.get(char);
    if (value === undefined) return undefined;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return String.fromCharCode(...bytes);
}

/**
 * The profile's `ExpirationDate` — first (and only) occurrence in the
 * embedded plist, an ISO-8601 `<date>` element. An absent key or an
 * unparseable date answers `undefined`; the caller treats that the same
 * as "no profile" rather than guessing.
 */
export function parseExpirationDate(binary: string): Date | undefined {
  const match = /<key>ExpirationDate<\/key>\s*<date>([^<]+)<\/date>/.exec(binary);
  if (match === null) return undefined;
  const date = new Date(match[1]);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Whole days left, rounded up — "expires in 1 day" until the last moment. */
export function expiryDaysLeft(expiry: Date, now: Date): number {
  return Math.max(0, Math.ceil((expiry.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
}

export function shouldWarn(expiry: Date | undefined, now: Date): boolean {
  return expiry !== undefined && expiry.getTime() - now.getTime() < EXPIRY_WARN_MS;
}

export type ProvisioningExpiryDeps = {
  platform: "ios" | "android";
  /** Reads a file from the app bundle as base64; `undefined` when absent. */
  readBundleFileBase64: (name: string) => Promise<string | undefined>;
};

export async function loadProvisioningExpiry(
  deps: ProvisioningExpiryDeps,
): Promise<Date | undefined> {
  if (deps.platform !== "ios") return undefined;
  const b64 = await deps.readBundleFileBase64(PROVISIONING_PROFILE_NAME);
  if (b64 === undefined) return undefined;
  const binary = decodeBase64(b64);
  if (binary === undefined) return undefined;
  return parseExpirationDate(binary);
}

export type ExpiryWarningState = {
  expiry: Date | undefined;
  daysLeft: number | undefined;
  warn: boolean;
};

export type ArmExpiryWarningDeps = {
  now: () => Date;
  loadExpiry: () => Promise<Date | undefined>;
  /** "granted" is the only answer that allows scheduling. */
  getPermission: () => Promise<string>;
  scheduleLocal: (input: {
    identifier: string;
    title: string;
    body: string;
    date: Date;
  }) => Promise<void>;
  cancelScheduledLocal: (identifier: string) => Promise<void>;
  strings: { title: string; body: string };
};

/**
 * One pass per app launch: read the expiry, compute the banner state, and
 * (re)schedule the day-before local notification. Local notifications
 * survive free signing — they need no push entitlement — which is exactly
 * why the plan uses one here. Cancel-then-schedule with a fixed identifier
 * keeps repeated launches idempotent. Scheduling is skipped when the
 * fire date is already past (the banner is showing by then) or permission
 * was never granted; every native failure degrades to banner-only.
 */
export async function armExpiryWarning(deps: ArmExpiryWarningDeps): Promise<ExpiryWarningState> {
  let expiry: Date | undefined;
  try {
    expiry = await deps.loadExpiry();
  } catch {
    expiry = undefined;
  }
  if (expiry === undefined) return { expiry: undefined, daysLeft: undefined, warn: false };
  const now = deps.now();
  const state: ExpiryWarningState = {
    expiry,
    daysLeft: expiryDaysLeft(expiry, now),
    warn: shouldWarn(expiry, now),
  };
  const fireAt = new Date(expiry.getTime() - EXPIRY_NOTIFY_BEFORE_MS);
  try {
    if ((await deps.getPermission()) !== "granted") return state;
    await deps.cancelScheduledLocal(EXPIRY_NOTIFICATION_ID);
    if (fireAt.getTime() > now.getTime()) {
      await deps.scheduleLocal({
        identifier: EXPIRY_NOTIFICATION_ID,
        title: deps.strings.title,
        body: deps.strings.body,
        date: fireAt,
      });
    }
  } catch {
    // Banner-only is fine; never let a native scheduling failure surface.
  }
  return state;
}
