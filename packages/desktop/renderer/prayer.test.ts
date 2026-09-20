// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkPrayerNotifications,
  initPrayerSettings,
  nextPrayer,
  renderPrayer,
  setPrayerSnapshot,
  syncPrayerSettings,
} from "./prayer.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";

const alexandria = {
  latitude: 31.2001,
  longitude: 29.9187,
  name: "Alexandria",
};

// Appended to every Settings-section harness below that exercises
// initPrayerSettings/syncPrayerSettings — the notify toggles' own markup,
// spelled out once so the two full harnesses below don't drift apart.
const NOTIFY_FIELDS =
  '<span id="settings-prayer-notify-before-label"></span><input id="settings-prayer-notify-before" type="checkbox"><span id="settings-prayer-notify-minutes-label"></span><input id="settings-prayer-notify-minutes" type="number"><span id="settings-prayer-notify-attime-label"></span><input id="settings-prayer-notify-attime" type="checkbox">';

describe("nextPrayer", () => {
  it("finds a future prayer and bounded progress in Alexandria", () => {
    const result = nextPrayer(new Date("2026-09-19T12:00:00Z"), alexandria);
    expect(["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"]).toContain(result.name);
    expect(result.remaining).toBeGreaterThan(0);
    expect(result.remaining).toBeLessThan(24 * 60 * 60 * 1000);
    expect(result.progress).toBeGreaterThanOrEqual(0);
    expect(result.progress).toBeLessThanOrEqual(1);
  });

  it("rolls over from Isha to the next day's Fajr", () => {
    const result = nextPrayer(new Date("2026-09-19T22:00:00Z"), alexandria);
    expect(result.name).toBe("Fajr");
  });
});

describe("prayer settings", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("hides when disabled and uses Alexandria when enabled without a location", () => {
    document.body.innerHTML =
      '<div id="header-prayer"><svg class="prayer-ring"><circle class="prayer-ring-fill"></circle></svg><span class="prayer-label"></span></div>';
    renderPrayer(new Date("2026-09-19T12:00:00Z"), { enabled: false });
    expect(document.getElementById("header-prayer")?.hidden).toBe(true);
    renderPrayer(new Date("2026-09-19T12:00:00Z"), { enabled: true });
    expect(document.getElementById("header-prayer")?.hidden).toBe(false);
    expect(document.getElementById("header-prayer")?.title).toContain("Alexandria");
  });

  it("renders the localized label and the ring's progress together", () => {
    document.body.innerHTML =
      '<div id="header-prayer"><svg class="prayer-ring"><circle class="prayer-ring-fill"></circle></svg><span class="prayer-label"></span></div>';
    renderPrayer(new Date("2026-09-19T12:00:00Z"), { enabled: true });

    expect(document.querySelector(".prayer-label")?.textContent).toMatch(/\S+.*\d+[hm]/);
    const ring = document.querySelector(".prayer-ring-fill") as HTMLElement;
    expect(ring.style.strokeDasharray).toMatch(/^\d+(\.\d+)?$/);
    expect(ring.style.strokeDashoffset).toMatch(/^\d+(\.\d+)?$/);
  });

  it("updates the settings draft and refreshes the header only after Save", async () => {
    document.body.innerHTML = `<div id="settings-prayer-heading"></div><label for="settings-prayer-enabled"><span id="settings-prayer-enabled-label"></span></label><input id="settings-prayer-enabled" type="checkbox"><button id="settings-prayer-locate"></button><span id="settings-prayer-location"></span><label for="settings-prayer-latitude"><span id="settings-prayer-latitude-label"></span></label><input id="settings-prayer-latitude"><label for="settings-prayer-longitude"><span id="settings-prayer-longitude-label"></span></label><input id="settings-prayer-longitude"><div id="settings-prayer-note"></div>${NOTIFY_FIELDS}<div id="header-prayer"><svg class="prayer-ring"><circle class="prayer-ring-fill"></circle></svg><span class="prayer-label"></span></div>`;
    setPrayerSnapshot({ enabled: false });
    renderPrayer(new Date("2026-09-19T12:00:00Z"));
    const updateDraft = vi.fn(async () => undefined);
    initPrayerSettings(updateDraft);
    const toggle = document.getElementById("settings-prayer-enabled") as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    expect(updateDraft).toHaveBeenCalledWith({ enabled: true });
    expect(document.getElementById("header-prayer")?.hidden).toBe(true);

    // The 1 s clock tick re-renders from the *saved* snapshot: still hidden.
    renderPrayer(new Date("2026-09-19T12:00:00Z"));
    expect(document.getElementById("header-prayer")?.hidden).toBe(true);

    // app.ts handles jarvis:settings-saved by re-reading the saved settings.
    setPrayerSnapshot({ enabled: true });
    renderPrayer(new Date("2026-09-19T12:00:00Z"));
    expect(document.getElementById("header-prayer")?.hidden).toBe(false);
  });

  // Re-review 2, item 2: the ring and the label move through --accent /
  // --warn / --bad / --good together as the prayer approaches and passes.
  // Each case starts from `nextPrayer` itself (rather than a hand-picked
  // clock time) so it never depends on knowing Alexandria's actual prayer
  // times, only on the interval arithmetic renderPrayer does with them.
  function layoutChip(): HTMLElement {
    document.body.innerHTML =
      '<div id="header-prayer"><svg class="prayer-ring"><circle class="prayer-ring-fill"></circle></svg><span class="prayer-label"></span></div>';
    return document.getElementById("header-prayer") as HTMLElement;
  }

  it("reads accent more than 30 minutes out", () => {
    const chip = layoutChip();
    const from = new Date("2026-09-19T12:00:00Z");
    const now = new Date(from.getTime() + nextPrayer(from, alexandria).remaining - 45 * 60_000);

    renderPrayer(now, { enabled: true });

    expect(chip.dataset["prayerState"]).toBe("accent");
  });

  it("reads warn at 30 minutes or less", () => {
    const chip = layoutChip();
    const from = new Date("2026-09-19T12:00:00Z");
    const now = new Date(from.getTime() + nextPrayer(from, alexandria).remaining - 20 * 60_000);

    renderPrayer(now, { enabled: true });

    expect(chip.dataset["prayerState"]).toBe("warn");
  });

  it("reads danger at 10 minutes or less", () => {
    const chip = layoutChip();
    const from = new Date("2026-09-19T12:00:00Z");
    const now = new Date(from.getTime() + nextPrayer(from, alexandria).remaining - 5 * 60_000);

    renderPrayer(now, { enabled: true });

    expect(chip.dataset["prayerState"]).toBe("danger");
  });

  it("names the prayer and reads 'now' for the 5 minutes after its own time", () => {
    const chip = layoutChip();
    const from = new Date("2026-09-19T12:00:00Z");
    const previousTime = from.getTime() - nextPrayer(from, alexandria).sincePrevious;
    const now = new Date(previousTime + 2 * 60_000);
    const previousName = nextPrayer(now, alexandria).previousName;

    renderPrayer(now, { enabled: true });

    expect(chip.dataset["prayerState"]).toBe("now");
    expect(document.querySelector(".prayer-label")?.textContent).toBe(
      MESSAGES.prayerNow(MESSAGES.prayerName(previousName, PRIMARY_LANGUAGE), PRIMARY_LANGUAGE),
    );
  });

  it("leaves the 'now' window once more than 5 minutes have passed", () => {
    const chip = layoutChip();
    const from = new Date("2026-09-19T12:00:00Z");
    const previousTime = from.getTime() - nextPrayer(from, alexandria).sincePrevious;
    const now = new Date(previousTime + 6 * 60_000);

    renderPrayer(now, { enabled: true });

    expect(chip.dataset["prayerState"]).not.toBe("now");
  });

  it("gives manually entered coordinates a localized neutral name", () => {
    document.body.innerHTML = `<div id="settings-prayer-heading"></div><label><span id="settings-prayer-enabled-label"></span></label><input id="settings-prayer-enabled" type="checkbox"><button id="settings-prayer-locate"></button><span id="settings-prayer-location"></span><label><span id="settings-prayer-latitude-label"></span></label><input id="settings-prayer-latitude" value="30"><label><span id="settings-prayer-longitude-label"></span></label><input id="settings-prayer-longitude" value="31"><div id="settings-prayer-note"></div>${NOTIFY_FIELDS}<div id="header-prayer"><svg class="prayer-ring"><circle class="prayer-ring-fill"></circle></svg><span class="prayer-label"></span></div>`;
    syncPrayerSettings({ enabled: true });
    const updateDraft = vi.fn(async () => undefined);
    initPrayerSettings(updateDraft);
    (document.getElementById("settings-prayer-latitude") as HTMLInputElement).value = "30";
    (document.getElementById("settings-prayer-longitude") as HTMLInputElement).value = "31";

    document.getElementById("settings-prayer-latitude")?.dispatchEvent(new Event("change"));

    expect(updateDraft).toHaveBeenLastCalledWith({
      enabled: true,
      location: {
        latitude: 30,
        longitude: 31,
        name: MESSAGES.prayerCustomLocation(PRIMARY_LANGUAGE),
      },
    });
  });

  it("syncs the notify toggles from the config, defaulting to on/10/on when notify is absent", () => {
    document.body.innerHTML = `<div id="settings-prayer-heading"></div><label><span id="settings-prayer-enabled-label"></span></label><input id="settings-prayer-enabled" type="checkbox"><button id="settings-prayer-locate"></button><span id="settings-prayer-location"></span><label><span id="settings-prayer-latitude-label"></span></label><input id="settings-prayer-latitude"><label><span id="settings-prayer-longitude-label"></span></label><input id="settings-prayer-longitude"><div id="settings-prayer-note"></div>${NOTIFY_FIELDS}<div id="header-prayer"><svg class="prayer-ring"><circle class="prayer-ring-fill"></circle></svg><span class="prayer-label"></span></div>`;

    syncPrayerSettings({ enabled: true });
    expect(
      (document.getElementById("settings-prayer-notify-before") as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (document.getElementById("settings-prayer-notify-minutes") as HTMLInputElement).value,
    ).toBe("10");
    expect(
      (document.getElementById("settings-prayer-notify-attime") as HTMLInputElement).checked,
    ).toBe(true);

    syncPrayerSettings({
      enabled: true,
      notify: { before: false, beforeMinutes: 25, atTime: false },
    });
    expect(
      (document.getElementById("settings-prayer-notify-before") as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (document.getElementById("settings-prayer-notify-minutes") as HTMLInputElement).value,
    ).toBe("25");
    expect(
      (document.getElementById("settings-prayer-notify-attime") as HTMLInputElement).checked,
    ).toBe(false);
  });

  it("merges a toggled notify field onto the defaults in the saved draft", () => {
    document.body.innerHTML = `<div id="settings-prayer-heading"></div><label><span id="settings-prayer-enabled-label"></span></label><input id="settings-prayer-enabled" type="checkbox"><button id="settings-prayer-locate"></button><span id="settings-prayer-location"></span><label><span id="settings-prayer-latitude-label"></span></label><input id="settings-prayer-latitude"><label><span id="settings-prayer-longitude-label"></span></label><input id="settings-prayer-longitude"><div id="settings-prayer-note"></div>${NOTIFY_FIELDS}<div id="header-prayer"><svg class="prayer-ring"><circle class="prayer-ring-fill"></circle></svg><span class="prayer-label"></span></div>`;
    syncPrayerSettings({ enabled: true });
    const updateDraft = vi.fn(async () => undefined);
    initPrayerSettings(updateDraft);

    const beforeToggle = document.getElementById(
      "settings-prayer-notify-before",
    ) as HTMLInputElement;
    beforeToggle.checked = false;
    beforeToggle.dispatchEvent(new Event("change"));
    expect(updateDraft).toHaveBeenLastCalledWith({
      enabled: true,
      notify: { before: false, beforeMinutes: 10, atTime: true },
    });

    const minutesInput = document.getElementById(
      "settings-prayer-notify-minutes",
    ) as HTMLInputElement;
    minutesInput.value = "30";
    minutesInput.dispatchEvent(new Event("change"));
    expect(updateDraft).toHaveBeenLastCalledWith({
      enabled: true,
      notify: { before: false, beforeMinutes: 30, atTime: true },
    });

    const atTimeToggle = document.getElementById(
      "settings-prayer-notify-attime",
    ) as HTMLInputElement;
    atTimeToggle.checked = false;
    atTimeToggle.dispatchEvent(new Event("change"));
    expect(updateDraft).toHaveBeenLastCalledWith({
      enabled: true,
      notify: { before: false, beforeMinutes: 30, atTime: false },
    });
  });
});

describe("checkPrayerNotifications", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fires a desktop notification once for a due 'before' event, not again for the same instant", () => {
    const calls: { title: string; body: string | undefined }[] = [];
    class MockNotification {
      constructor(title: string, options?: { body?: string }) {
        calls.push({ title, body: options?.body });
      }
    }
    vi.stubGlobal("Notification", MockNotification);

    const from = new Date("2026-09-20T12:00:00Z");
    const dueAt = new Date(from.getTime() + nextPrayer(from, alexandria).remaining - 9 * 60_000);
    const config = { enabled: true };

    checkPrayerNotifications(dueAt, config);
    expect(calls.length).toBe(1);
    expect(calls[0]?.title.length).toBeGreaterThan(0);

    checkPrayerNotifications(dueAt, config);
    expect(calls.length).toBe(1);
  });

  it("never fires when prayer is disabled", () => {
    const calls: unknown[] = [];
    class MockNotification {
      constructor() {
        calls.push(undefined);
      }
    }
    vi.stubGlobal("Notification", MockNotification);

    checkPrayerNotifications(new Date("2026-09-20T13:00:00Z"), { enabled: false });

    expect(calls.length).toBe(0);
  });
});
