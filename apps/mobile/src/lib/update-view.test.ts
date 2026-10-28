import { describe, expect, it } from "vitest";
import { createIdlePhoneUpdateStore } from "./phone-update-app";
import type { PhoneUpdateView, UpdateState } from "./phone-update-types";
import { updateBannerText, updateCardView } from "./update-view";

function android(state: UpdateState): PhoneUpdateView {
  return { state, current: "0.1.11", canInstall: true };
}

function ios(state: UpdateState): PhoneUpdateView {
  return { state, current: "0.1.11", canInstall: false };
}

const ALL_STATES: UpdateState[] = [
  { kind: "idle" },
  { kind: "checking" },
  { kind: "current", checkedAt: Date.UTC(2026, 9, 28, 9, 30) },
  { kind: "available", version: "0.1.12", notes: "Faster terminal." },
  { kind: "downloading", version: "0.1.12", progress: 0.42 },
  { kind: "verifying", version: "0.1.12" },
  { kind: "ready", version: "0.1.12" },
  { kind: "failed", reason: "offline" },
  { kind: "failed", reason: "download", version: "0.1.12" },
  { kind: "failed", reason: "checksum", version: "0.1.12" },
  { kind: "failed", reason: "install", version: "0.1.12" },
];

describe("updateCardView", () => {
  it("always shows the installed version and Check now", () => {
    for (const state of ALL_STATES) {
      const card = updateCardView(android(state), "en");
      expect(card.installed).toBe("Installed: 0.1.11");
      expect(card.check.label).toBe("Check now");
    }
  });

  it("disables Check now only while busy", () => {
    const disabled = ALL_STATES.filter(
      (state) => updateCardView(android(state), "en").check.disabled,
    ).map((state) => state.kind);
    expect(disabled).toEqual(["checking", "downloading", "verifying"]);
  });

  it("idle shows nothing beyond the version", () => {
    const card = updateCardView(android({ kind: "idle" }), "en");
    expect(card).toMatchObject({
      newest: undefined,
      status: undefined,
      error: undefined,
      update: undefined,
      progress: undefined,
    });
  });

  it("checking says so", () => {
    expect(updateCardView(android({ kind: "checking" }), "en").status).toBe("Checking…");
  });

  it("current says up to date with the last check", () => {
    const card = updateCardView(android(ALL_STATES[2] as UpdateState), "en");
    expect(card.status).toBe("You're on the latest version (0.1.11).");
    expect(card.lastChecked).toMatch(/^Last checked /);
    expect(card.update).toBeUndefined();
  });

  it("available shows the newest version, the notes and Update", () => {
    const card = updateCardView(
      android({ kind: "available", version: "0.1.12", notes: "Faster terminal." }),
      "en",
    );
    expect(card.newest).toBe("Newest: 0.1.12");
    expect(card.notes).toBe("Faster terminal.");
    expect(card.update).toEqual({ label: "Update", disabled: false });
  });

  it("downloading shows the percentage, disabled, with progress", () => {
    const card = updateCardView(
      android({ kind: "downloading", version: "0.1.12", progress: 0.42 }),
      "en",
    );
    expect(card.update).toEqual({ label: "Downloading 42%", disabled: true });
    expect(card.progress).toBe(0.42);
  });

  it("verifying says Verifying…, disabled", () => {
    const card = updateCardView(android({ kind: "verifying", version: "0.1.12" }), "en");
    expect(card.update).toEqual({ label: "Verifying…", disabled: true });
    expect(card.progress).toBeUndefined();
  });

  it("ready says it is verified and lets Update open the installer again", () => {
    const card = updateCardView(android({ kind: "ready", version: "0.1.12" }), "en");
    expect(card.status).toContain("0.1.12 is downloaded and verified");
    expect(card.update).toEqual({ label: "Update", disabled: false });
  });

  it.each([
    ["offline", "Couldn't check for updates. Check your connection and try again."],
    ["download", "The download failed. Tap Update to try again."],
    [
      "checksum",
      "The download didn't match its checksum, so it was deleted. Tap Update to try again.",
    ],
    ["install", "Allow installs from Jarvis, then tap Update again."],
  ] as const)("failed %s shows its own error", (reason, text) => {
    expect(updateCardView(android({ kind: "failed", reason }), "en").error).toBe(text);
  });

  it("a failed update can retry; a failed check has nothing to install", () => {
    expect(
      updateCardView(android({ kind: "failed", reason: "download", version: "0.1.12" }), "en")
        .update,
    ).toEqual({ label: "Update", disabled: false });
    expect(updateCardView(android({ kind: "failed", reason: "offline" }), "en").update).toBe(
      undefined,
    );
  });

  it("words the card in Arabic", () => {
    const card = updateCardView(
      android({ kind: "downloading", version: "0.1.12", progress: 0.5 }),
      "ar",
    );
    expect(card.installed).toBe("المثبّت: 0.1.11");
    expect(card.update?.label).toBe("جارٍ التنزيل 50%");
  });

  it("iOS and web hide Update, the newest version, notes and progress", () => {
    for (const state of ALL_STATES) {
      const card = updateCardView(ios(state), "en");
      expect(card.update).toBeUndefined();
      expect(card.newest).toBeUndefined();
      expect(card.notes).toBeUndefined();
      expect(card.progress).toBeUndefined();
      expect(card.check.label).toBe("Check now");
    }
  });
});

describe("updateBannerText", () => {
  it("shows only for available and ready", () => {
    const shown = ALL_STATES.filter(
      (state) => updateBannerText(android(state), "en") !== undefined,
    ).map((state) => state.kind);
    expect(shown).toEqual(["available", "ready"]);
    expect(
      updateBannerText(android({ kind: "available", version: "0.1.12", notes: "" }), "en"),
    ).toBe("Update available: Jarvis 0.1.12");
  });

  it("never shows where the phone cannot install", () => {
    for (const state of ALL_STATES) {
      expect(updateBannerText(ios(state), "en")).toBeUndefined();
    }
  });
});

describe("the idle store at the app-root seam", () => {
  it("reports idle and does nothing", async () => {
    const store = createIdlePhoneUpdateStore({
      state: { kind: "idle" },
      current: "0.0.0",
      canInstall: false,
    });
    store.start();
    await store.check();
    await store.update();
    const unsubscribe = store.subscribe(() => {
      throw new Error("never notifies");
    });
    unsubscribe();
    store.stop();
    expect(store.get()).toEqual({ state: { kind: "idle" }, current: "0.0.0", canInstall: false });
  });
});
