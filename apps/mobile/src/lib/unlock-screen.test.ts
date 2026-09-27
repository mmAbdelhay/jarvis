import { describe, expect, it } from "vitest";
import type { AuthView } from "./auth-session";
import { lockCauseKey, shouldShowUnlock, unlockMessageKey } from "./unlock-screen";

const UNLOCKED: AuthView = { lockedLocally: false, busy: false, biometricUnavailable: false };

describe("unlock-screen", () => {
  it("shows the unlock screen when the connection is locked or the phone locked itself", () => {
    expect(shouldShowUnlock("locked", UNLOCKED, "/dashboard")).toBe(true);
    expect(shouldShowUnlock("open", UNLOCKED, "/dashboard")).toBe(false);
    expect(
      shouldShowUnlock("reconnecting", { ...UNLOCKED, lockedLocally: true }, "/sessions"),
    ).toBe(true);
  });

  it("waits while an automatic resume is in flight", () => {
    expect(shouldShowUnlock("locked", { ...UNLOCKED, busy: true }, "/dashboard")).toBe(false);
  });

  it("never routes from the unlock screen itself, pairing, or the entry redirect", () => {
    for (const path of ["/unlock", "/pair", "/"]) {
      expect(shouldShowUnlock("locked", UNLOCKED, path)).toBe(false);
    }
  });

  it("maps each unlock outcome to its message (or none)", () => {
    expect(unlockMessageKey("unlocked")).toBeUndefined();
    expect(unlockMessageKey("no-stored-token")).toBeUndefined();
    expect(unlockMessageKey("cancelled")).toBeUndefined();
    expect(unlockMessageKey("password-required")).toBe("auth.reason.signedOut");
    expect(unlockMessageKey("wrong-password")).toBe("auth.wrongPassword");
    expect(unlockMessageKey("rate-limited")).toBe("auth.rateLimited");
    expect(unlockMessageKey("offline")).toBe("auth.offline");
    expect(unlockMessageKey("failed")).toBe("auth.failed");
  });

  it("maps each lock cause to its message", () => {
    expect(lockCauseKey(undefined)).toBeUndefined();
    expect(lockCauseKey("idle")).toBe("auth.reason.idle");
    expect(lockCauseKey("expired")).toBe("auth.reason.expired");
    expect(lockCauseKey("logout")).toBe("auth.reason.logout");
    expect(lockCauseKey("signed-out")).toBe("auth.reason.signedOut");
  });
});
