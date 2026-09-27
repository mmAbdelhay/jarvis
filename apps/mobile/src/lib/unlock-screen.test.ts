import { describe, expect, it } from "vitest";
import type { AuthView } from "./auth-session";
import {
  lockCauseKey,
  registerMessageKey,
  shouldAutoPasskey,
  shouldShowUnlock,
  unlockMessageKey,
} from "./unlock-screen";

const UNLOCKED: AuthView = {
  lockedLocally: false,
  busy: false,
  biometricUnavailable: false,
  autoPrompt: false,
};

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
    expect(unlockMessageKey("passkey-unsupported")).toBe("auth.passkeyUnsupported");
    expect(unlockMessageKey("passkey-refused")).toBe("auth.passkeyRefused");
  });

  it("the browser tries a passkey on its own only after the stored sign-in found nothing", () => {
    const ready = { supported: true, hasPasskeys: true };
    expect(shouldAutoPasskey("no-stored-token", ready)).toBe(true);
    expect(shouldAutoPasskey("password-required", ready)).toBe(true);
    expect(shouldAutoPasskey("unlocked", ready)).toBe(false);
    // A laptop that can't be reached isn't asked twice.
    expect(shouldAutoPasskey("offline", ready)).toBe(false);
    expect(shouldAutoPasskey("no-stored-token", { ...ready, supported: false })).toBe(false);
    expect(shouldAutoPasskey("no-stored-token", { ...ready, hasPasskeys: false })).toBe(false);
  });

  it("maps each passkey registration outcome to its message", () => {
    expect(registerMessageKey("registered")).toBe("passkey.added");
    expect(registerMessageKey("cancelled")).toBeUndefined();
    expect(registerMessageKey("exists")).toBe("passkey.exists");
    expect(registerMessageKey("wrong-password")).toBe("auth.wrongPassword");
    expect(registerMessageKey("rate-limited")).toBe("auth.rateLimited");
    expect(registerMessageKey("offline")).toBe("auth.offline");
    expect(registerMessageKey("unsupported")).toBe("auth.passkeyUnsupported");
    expect(registerMessageKey("locked")).toBe("passkey.failed");
    expect(registerMessageKey("failed")).toBe("passkey.failed");
  });

  it("maps each lock cause to its message", () => {
    expect(lockCauseKey(undefined)).toBeUndefined();
    expect(lockCauseKey("idle")).toBe("auth.reason.idle");
    expect(lockCauseKey("expired")).toBe("auth.reason.expired");
    expect(lockCauseKey("logout")).toBe("auth.reason.logout");
    expect(lockCauseKey("signed-out")).toBe("auth.reason.signedOut");
  });
});
