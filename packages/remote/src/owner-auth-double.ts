// OwnerAuth doubles for connection and hub tests. `unlockedOwnerAuth`
// opens every connection already unlocked with no expiry, so a test about
// requests, subscriptions or blobs needs no login round trip. The locked
// behaviour itself is tested against `scriptedOwnerAuth` and, end to end,
// against the real `createOwnerAuth` inside the bridge.

import type { AuthOutcome, AuthSession, OwnerAuth } from "./owner-auth.js";

export const TEST_FAMILY_ID = "f".repeat(32);

/** Every connection opens unlocked, never expiring; every auth request answers `unsupported`. */
export function unlockedOwnerAuth(): OwnerAuth {
  return {
    sessionAtHello: () => ({ until: Number.POSITIVE_INFINITY, familyId: TEST_FAMILY_ID }),
    handle: async () => ({ kind: "error", code: "unsupported" }),
  };
}

/** Opens locked; each auth request is answered by `answer`. */
export function scriptedOwnerAuth(
  answer: (channel: string, args: unknown, session: AuthSession | undefined) => AuthOutcome,
): OwnerAuth {
  return {
    sessionAtHello: () => undefined,
    handle: async (channel, args, context) => answer(channel, args, context.session),
  };
}
