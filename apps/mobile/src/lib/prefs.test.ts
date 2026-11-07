import { describe, expect, it } from "vitest";
import { languageFromLocale } from "./i18n";
import {
  type Prefs,
  type PrefsStore,
  loadPrefs,
  savePrefs,
  setDiffMode,
  setKeepSignedIn,
} from "./prefs";
import { createPrefsFacade } from "./push-context-support";

class FakeStore implements PrefsStore {
  private text: string | undefined;

  constructor(initial?: string) {
    this.text = initial;
  }

  read(): Promise<string | undefined> {
    return Promise.resolve(this.text);
  }

  write(text: string): Promise<void> {
    this.text = text;
    return Promise.resolve();
  }
}

describe("loadPrefs", () => {
  it("falls back to the locale default when nothing has been written", async () => {
    const store = new FakeStore(undefined);
    const prefs = await loadPrefs(store, "ar-EG");
    expect(prefs).toEqual<Prefs>({
      language: "ar",
      speakReplies: true,
      notifications: false,
      pushRegistered: false,
      sidecarDesktopSite: true,
      sidecarZoom: {},
      idleLockMinutes: 15,
      refreshTokenStored: false,
      keepSignedIn: false,
      machineFlags: {},
    });
  });

  it("falls back to the locale default when the file is unparsable JSON", async () => {
    const store = new FakeStore("{not json");
    const prefs = await loadPrefs(store, "en-US");
    expect(prefs).toEqual<Prefs>({
      language: "en",
      speakReplies: true,
      notifications: false,
      pushRegistered: false,
      sidecarDesktopSite: true,
      sidecarZoom: {},
      idleLockMinutes: 15,
      refreshTokenStored: false,
      keepSignedIn: false,
      machineFlags: {},
    });
  });

  it("falls back to the locale default when the language value is unknown", async () => {
    const store = new FakeStore(JSON.stringify({ language: "fr" }));
    const prefs = await loadPrefs(store, "ar");
    expect(prefs).toEqual<Prefs>({
      language: "ar",
      speakReplies: true,
      notifications: false,
      pushRegistered: false,
      sidecarDesktopSite: true,
      sidecarZoom: {},
      idleLockMinutes: 15,
      refreshTokenStored: false,
      keepSignedIn: false,
      machineFlags: {},
    });
  });

  it("round-trips a saved language through load", async () => {
    const store = new FakeStore(undefined);
    await savePrefs(store, {
      language: "ar",
      speakReplies: true,
      notifications: false,
      pushRegistered: false,
      sidecarDesktopSite: true,
      sidecarZoom: {},
      idleLockMinutes: 15,
      refreshTokenStored: false,
      keepSignedIn: false,
      machineFlags: {},
    });
    const prefs = await loadPrefs(store, "en-US");
    expect(prefs).toEqual<Prefs>({
      language: "ar",
      speakReplies: true,
      notifications: false,
      pushRegistered: false,
      sidecarDesktopSite: true,
      sidecarZoom: {},
      idleLockMinutes: 15,
      refreshTokenStored: false,
      keepSignedIn: false,
      machineFlags: {},
    });
  });

  it("falls back to the locale default when the stored JSON is not an object", async () => {
    const store = new FakeStore("null");
    await expect(loadPrefs(store, "en")).resolves.toEqual<Prefs>({
      language: languageFromLocale("en"),
      speakReplies: true,
      notifications: false,
      pushRegistered: false,
      sidecarDesktopSite: true,
      sidecarZoom: {},
      idleLockMinutes: 15,
      refreshTokenStored: false,
      keepSignedIn: false,
      machineFlags: {},
    });
  });

  describe("speakReplies (M8 Task 7, rule 16)", () => {
    it("an old file with no speakReplies key defaults to true", async () => {
      const store = new FakeStore(JSON.stringify({ language: "ar" }));
      const prefs = await loadPrefs(store, "en-US");
      expect(prefs).toEqual<Prefs>({
        language: "ar",
        speakReplies: true,
        notifications: false,
        pushRegistered: false,
        sidecarDesktopSite: true,
        sidecarZoom: {},
        idleLockMinutes: 15,
        refreshTokenStored: false,
        keepSignedIn: false,
        machineFlags: {},
      });
    });

    it("a non-boolean speakReplies value falls back to true", async () => {
      const store = new FakeStore(JSON.stringify({ language: "ar", speakReplies: "no" }));
      const prefs = await loadPrefs(store, "en-US");
      expect(prefs).toEqual<Prefs>({
        language: "ar",
        speakReplies: true,
        notifications: false,
        pushRegistered: false,
        sidecarDesktopSite: true,
        sidecarZoom: {},
        idleLockMinutes: 15,
        refreshTokenStored: false,
        keepSignedIn: false,
        machineFlags: {},
      });
    });

    it("round-trips a saved speakReplies: false", async () => {
      const store = new FakeStore(undefined);
      await savePrefs(store, {
        language: "en",
        speakReplies: false,
        notifications: false,
        pushRegistered: false,
        sidecarDesktopSite: true,
        sidecarZoom: {},
        idleLockMinutes: 15,
        refreshTokenStored: false,
        keepSignedIn: false,
        machineFlags: {},
      });
      const prefs = await loadPrefs(store, "en-US");
      expect(prefs).toEqual<Prefs>({
        language: "en",
        speakReplies: false,
        notifications: false,
        pushRegistered: false,
        sidecarDesktopSite: true,
        sidecarZoom: {},
        idleLockMinutes: 15,
        refreshTokenStored: false,
        keepSignedIn: false,
        machineFlags: {},
      });
    });

    it("an invalid language still falls back independently of a valid speakReplies", async () => {
      const store = new FakeStore(JSON.stringify({ language: "fr", speakReplies: false }));
      const prefs = await loadPrefs(store, "ar-EG");
      expect(prefs).toEqual<Prefs>({
        language: "ar",
        speakReplies: false,
        notifications: false,
        pushRegistered: false,
        sidecarDesktopSite: true,
        sidecarZoom: {},
        idleLockMinutes: 15,
        refreshTokenStored: false,
        keepSignedIn: false,
        machineFlags: {},
      });
    });
  });

  describe("notifications / pushRegistered (M10 Task 5, rule 1)", () => {
    it("missing -> both false", async () => {
      const store = new FakeStore(undefined);
      const prefs = await loadPrefs(store, "en-US");
      expect(prefs.notifications).toBe(false);
      expect(prefs.pushRegistered).toBe(false);
    });

    it('notifications: "yes" -> false, while language still parses', async () => {
      const store = new FakeStore(JSON.stringify({ language: "ar", notifications: "yes" }));
      const prefs = await loadPrefs(store, "en-US");
      expect(prefs.notifications).toBe(false);
      expect(prefs.language).toBe("ar");
    });

    it("a non-boolean pushRegistered value falls back to false", async () => {
      const store = new FakeStore(JSON.stringify({ pushRegistered: "yes" }));
      const prefs = await loadPrefs(store, "en-US");
      expect(prefs.pushRegistered).toBe(false);
    });

    it("round-trips saved notifications:true and pushRegistered:true", async () => {
      const store = new FakeStore(undefined);
      await savePrefs(store, {
        language: "en",
        speakReplies: true,
        notifications: true,
        pushRegistered: true,
        sidecarDesktopSite: true,
        sidecarZoom: {},
        idleLockMinutes: 15,
        refreshTokenStored: false,
        keepSignedIn: false,
        machineFlags: {},
      });
      const prefs = await loadPrefs(store, "en-US");
      expect(prefs).toEqual<Prefs>({
        language: "en",
        speakReplies: true,
        notifications: true,
        pushRegistered: true,
        sidecarDesktopSite: true,
        sidecarZoom: {},
        idleLockMinutes: 15,
        refreshTokenStored: false,
        keepSignedIn: false,
        machineFlags: {},
      });
    });

    it("each field defaults independently of the others when only one is present", async () => {
      const store = new FakeStore(JSON.stringify({ notifications: true }));
      const prefs = await loadPrefs(store, "en-US");
      expect(prefs).toEqual<Prefs>({
        language: "en",
        speakReplies: true,
        notifications: true,
        pushRegistered: false,
        sidecarDesktopSite: true,
        sidecarZoom: {},
        idleLockMinutes: 15,
        refreshTokenStored: false,
        keepSignedIn: false,
        machineFlags: {},
      });
    });
  });

  // Sidecar UA fix: the "Desktop site" toggle's own persisted preference —
  // same independence discipline as every other field above (rule 16/M10
  // Task 5 rule 1, extended here). Default true: a missing or invalid
  // stored value must still show DbGate/code-server their real desktop UI.
  describe("sidecarDesktopSite", () => {
    it("missing -> true", async () => {
      const store = new FakeStore(undefined);
      const prefs = await loadPrefs(store, "en-US");
      expect(prefs.sidecarDesktopSite).toBe(true);
    });

    it("an old file with no sidecarDesktopSite key defaults to true", async () => {
      const store = new FakeStore(JSON.stringify({ language: "en" }));
      const prefs = await loadPrefs(store, "en-US");
      expect(prefs.sidecarDesktopSite).toBe(true);
    });

    it("a non-boolean sidecarDesktopSite value falls back to true", async () => {
      const store = new FakeStore(JSON.stringify({ sidecarDesktopSite: "no" }));
      const prefs = await loadPrefs(store, "en-US");
      expect(prefs.sidecarDesktopSite).toBe(true);
    });

    it("round-trips a saved sidecarDesktopSite: false", async () => {
      const store = new FakeStore(undefined);
      await savePrefs(store, {
        language: "en",
        speakReplies: true,
        notifications: false,
        pushRegistered: false,
        sidecarDesktopSite: false,
        sidecarZoom: {},
        idleLockMinutes: 15,
        refreshTokenStored: false,
        keepSignedIn: false,
        machineFlags: {},
      });
      const prefs = await loadPrefs(store, "en-US");
      expect(prefs).toEqual<Prefs>({
        language: "en",
        speakReplies: true,
        notifications: false,
        pushRegistered: false,
        sidecarDesktopSite: false,
        sidecarZoom: {},
        idleLockMinutes: 15,
        refreshTokenStored: false,
        keepSignedIn: false,
        machineFlags: {},
      });
    });

    it("defaults independently of the other fields when only it is present", async () => {
      const store = new FakeStore(JSON.stringify({ sidecarDesktopSite: false }));
      const prefs = await loadPrefs(store, "en-US");
      expect(prefs).toEqual<Prefs>({
        language: "en",
        speakReplies: true,
        notifications: false,
        pushRegistered: false,
        sidecarDesktopSite: false,
        sidecarZoom: {},
        idleLockMinutes: 15,
        refreshTokenStored: false,
        keepSignedIn: false,
        machineFlags: {},
      });
    });
  });

  // Sidecar zoom fix: per-kind zoom levels, same independence discipline as
  // every other field above. Default `{}` (every kind absent -> the
  // header's own 100% default); a corrupt value is dropped per-kind, not
  // for the whole object.
  describe("sidecarZoom", () => {
    it("missing -> {}", async () => {
      const store = new FakeStore(undefined);
      const prefs = await loadPrefs(store, "en-US");
      expect(prefs.sidecarZoom).toEqual({});
    });

    it("an old file with no sidecarZoom key defaults to {}", async () => {
      const store = new FakeStore(JSON.stringify({ language: "en" }));
      const prefs = await loadPrefs(store, "en-US");
      expect(prefs.sidecarZoom).toEqual({});
    });

    it("a non-object sidecarZoom value falls back to {}", async () => {
      const store = new FakeStore(JSON.stringify({ sidecarZoom: "120" }));
      const prefs = await loadPrefs(store, "en-US");
      expect(prefs.sidecarZoom).toEqual({});
    });

    it("a null sidecarZoom value falls back to {}", async () => {
      const store = new FakeStore(JSON.stringify({ sidecarZoom: null }));
      const prefs = await loadPrefs(store, "en-US");
      expect(prefs.sidecarZoom).toEqual({});
    });

    it("round-trips a saved per-kind zoom for every kind", async () => {
      const store = new FakeStore(undefined);
      await savePrefs(store, {
        language: "en",
        speakReplies: true,
        notifications: false,
        pushRegistered: false,
        sidecarDesktopSite: true,
        sidecarZoom: { editor: 120, database: 80, cluster: 150 },
        idleLockMinutes: 15,
        refreshTokenStored: false,
        keepSignedIn: false,
        machineFlags: {},
      });
      const prefs = await loadPrefs(store, "en-US");
      expect(prefs).toEqual<Prefs>({
        language: "en",
        speakReplies: true,
        notifications: false,
        pushRegistered: false,
        sidecarDesktopSite: true,
        sidecarZoom: { editor: 120, database: 80, cluster: 150 },
        idleLockMinutes: 15,
        refreshTokenStored: false,
        keepSignedIn: false,
        machineFlags: {},
      });
    });

    it("round-trips a partial zoom object (only one kind set)", async () => {
      const store = new FakeStore(undefined);
      await savePrefs(store, {
        language: "en",
        speakReplies: true,
        notifications: false,
        pushRegistered: false,
        sidecarDesktopSite: true,
        sidecarZoom: { database: 110 },
        idleLockMinutes: 15,
        refreshTokenStored: false,
        keepSignedIn: false,
        machineFlags: {},
      });
      const prefs = await loadPrefs(store, "en-US");
      expect(prefs.sidecarZoom).toEqual({ database: 110 });
    });

    it(
      "an out-of-range value for one kind is dropped without affecting a valid sibling " +
        "[bite-proof: reject the whole object on one bad entry and `editor` would be lost too]",
      async () => {
        const store = new FakeStore(
          JSON.stringify({ sidecarZoom: { editor: 120, database: 9999, cluster: -10 } }),
        );
        const prefs = await loadPrefs(store, "en-US");
        expect(prefs.sidecarZoom).toEqual({ editor: 120 });
      },
    );

    it("a non-numeric value for one kind is dropped without affecting a valid sibling", async () => {
      const store = new FakeStore(JSON.stringify({ sidecarZoom: { editor: "big", database: 90 } }));
      const prefs = await loadPrefs(store, "en-US");
      expect(prefs.sidecarZoom).toEqual({ database: 90 });
    });

    it("a NaN value for one kind is dropped", async () => {
      // JSON has no NaN literal, so this simulates the same shape a hand-
      // edited or corrupted file could produce via a non-JSON round-trip.
      const store = new FakeStore('{"sidecarZoom":{"editor":NaN,"database":100}}');
      const prefs = await loadPrefs(store, "en-US");
      // The whole file is invalid JSON (NaN isn't valid JSON), so this
      // falls back to the full default, not just a per-kind drop.
      expect(prefs.sidecarZoom).toEqual({});
    });

    it("defaults independently of the other fields when only it is present", async () => {
      const store = new FakeStore(JSON.stringify({ sidecarZoom: { cluster: 200 } }));
      const prefs = await loadPrefs(store, "en-US");
      expect(prefs).toEqual<Prefs>({
        language: "en",
        speakReplies: true,
        notifications: false,
        pushRegistered: false,
        sidecarDesktopSite: true,
        sidecarZoom: { cluster: 200 },
        idleLockMinutes: 15,
        refreshTokenStored: false,
        keepSignedIn: false,
        machineFlags: {},
      });
    });

    it("boundary values 50 and 200 are kept (inclusive range)", async () => {
      const store = new FakeStore(JSON.stringify({ sidecarZoom: { editor: 50, database: 200 } }));
      const prefs = await loadPrefs(store, "en-US");
      expect(prefs.sidecarZoom).toEqual({ editor: 50, database: 200 });
    });

    it("values just outside the boundary (49 and 201) are dropped", async () => {
      const store = new FakeStore(JSON.stringify({ sidecarZoom: { editor: 49, database: 201 } }));
      const prefs = await loadPrefs(store, "en-US");
      expect(prefs.sidecarZoom).toEqual({});
    });
  });

  describe("idleLockMinutes", () => {
    it("defaults to 15 when missing", async () => {
      const prefs = await loadPrefs(new FakeStore(JSON.stringify({})), "en-US");
      expect(prefs.idleLockMinutes).toBe(15);
    });

    it("keeps each allowed value", async () => {
      for (const minutes of [5, 15, 30, 60]) {
        const prefs = await loadPrefs(
          new FakeStore(JSON.stringify({ idleLockMinutes: minutes })),
          "en-US",
        );
        expect(prefs.idleLockMinutes).toBe(minutes);
      }
    });

    it("falls back to 15 for any other value", async () => {
      for (const bad of [0, 10, 61, "15", null, -5]) {
        const prefs = await loadPrefs(
          new FakeStore(JSON.stringify({ idleLockMinutes: bad })),
          "en-US",
        );
        expect(prefs.idleLockMinutes).toBe(15);
      }
    });
  });

  describe("keepSignedIn (the browser's Keep me signed in)", () => {
    it("defaults off and is true only for a stored true", async () => {
      expect((await loadPrefs(new FakeStore(undefined), "en-US")).keepSignedIn).toBe(false);
      for (const [value, expected] of [
        [true, true],
        [false, false],
        ["true", false],
        [1, false],
      ] as const) {
        const prefs = await loadPrefs(
          new FakeStore(JSON.stringify({ keepSignedIn: value })),
          "en-US",
        );
        expect(prefs.keepSignedIn).toBe(expected);
      }
    });
  });

  it("setKeepSignedIn changes only its own key", async () => {
    const store = new FakeStore(JSON.stringify({ language: "ar", refreshTokenStored: true }));
    await setKeepSignedIn(store, "en-US", true);
    expect(await loadPrefs(store, "en-US")).toMatchObject({
      language: "ar",
      refreshTokenStored: true,
      keepSignedIn: true,
    });
    await setKeepSignedIn(store, "en-US", false);
    expect((await loadPrefs(store, "en-US")).keepSignedIn).toBe(false);
  });

  describe("machineFlags", () => {
    const ID = "mac.tail.ts.net_7717";
    const FLAGS = { refreshTokenStored: true, pushRegistered: false };

    it("defaults to {} when missing or not an object", async () => {
      for (const text of [undefined, "{}", '{"machineFlags":"x"}', '{"machineFlags":null}']) {
        expect((await loadPrefs(new FakeStore(text), "en-US")).machineFlags).toEqual({});
      }
    });

    it("keeps valid entries and drops invalid ones one by one", async () => {
      const store = new FakeStore(
        JSON.stringify({
          machineFlags: {
            [ID]: FLAGS,
            "BAD ID": FLAGS,
            "no-push_1": { refreshTokenStored: true },
            "string-flag_1": { refreshTokenStored: "true", pushRegistered: false },
            "not-an-object_1": true,
            null_1: null,
          },
        }),
      );
      expect((await loadPrefs(store, "en-US")).machineFlags).toEqual({ [ID]: FLAGS });
    });

    it("never carries a field it does not know", async () => {
      const store = new FakeStore(
        JSON.stringify({ machineFlags: { [ID]: { ...FLAGS, token: "secret" } } }),
      );
      expect((await loadPrefs(store, "en-US")).machineFlags).toEqual({ [ID]: FLAGS });
    });

    it("holds at most 32 entries", async () => {
      const machineFlags: Record<string, typeof FLAGS> = {};
      for (let i = 0; i < 40; i += 1) machineFlags[`m${i}_7717`] = FLAGS;
      const prefs = await loadPrefs(new FakeStore(JSON.stringify({ machineFlags })), "en-US");
      expect(Object.keys(prefs.machineFlags)).toHaveLength(32);
    });

    it("a machine id of __proto__ cannot reach the prototype", async () => {
      const prefs = await loadPrefs(
        new FakeStore(
          `{"machineFlags":{"__proto__":{"refreshTokenStored":true,"pushRegistered":true}}}`,
        ),
        "en-US",
      );
      expect(Object.getPrototypeOf(prefs.machineFlags)).toBe(Object.prototype);
      expect((prefs.machineFlags as { refreshTokenStored?: boolean }).refreshTokenStored).toBe(
        undefined,
      );
    });

    it("a save by every writer in this module and the push facade keeps them", async () => {
      const store = new FakeStore(JSON.stringify({ machineFlags: { [ID]: FLAGS } }));
      await setKeepSignedIn(store, "en-US", true);
      await setDiffMode(store, "en-US", "split");
      await createPrefsFacade(store, "en-US", {
        notifications: false,
        pushRegistered: false,
      }).set({ notifications: true });
      await savePrefs(store, await loadPrefs(store, "en-US"));
      const prefs = await loadPrefs(store, "en-US");
      expect(prefs.machineFlags).toEqual({ [ID]: FLAGS });
      expect(prefs).toMatchObject({
        keepSignedIn: true,
        changesDiffMode: "split",
        notifications: true,
      });
    });
  });

  describe("refreshTokenStored", () => {
    it("is true only for a stored true", async () => {
      for (const [value, expected] of [
        [true, true],
        [false, false],
        ["true", false],
        [1, false],
      ] as const) {
        const prefs = await loadPrefs(
          new FakeStore(JSON.stringify({ refreshTokenStored: value })),
          "en-US",
        );
        expect(prefs.refreshTokenStored).toBe(expected);
      }
    });
  });
});
