import { createMemorySecretStore, providerAccount, type SecretStore } from "@jarvis/platform/model";
import { describe, expect, it } from "vitest";
import {
  createEnvKeyStore,
  envProviderKeyName,
  hasProviderKey,
  readProviderKey,
  takeEnvProviderKeys,
} from "./provider-keys.js";

const legacyEntry = { id: "default", kind: "anthropic", baseUrl: "https://api.anthropic.com" };

describe("readProviderKey (M2.5 contracts §1)", () => {
  it("reads the key stored under provider=<id>", async () => {
    const providerKeys = createMemorySecretStore({ work: "sk-work" });
    const key = await readProviderKey(
      { id: "work", kind: "anthropic", baseUrl: "https://api.anthropic.com" },
      { providerKeys, legacy: createMemorySecretStore(), migrateLegacy: false, log: () => {} },
    );
    expect(key).toBe("sk-work");
  });

  it("copies an M1/M2 key to provider=default once, and never logs it", async () => {
    const providerKeys = createMemorySecretStore();
    const legacy = createMemorySecretStore({
      [providerAccount("anthropic", "https://api.anthropic.com")]: "sk-old",
    });
    const logs: string[] = [];
    const stores = { providerKeys, legacy, migrateLegacy: true, log: (l: string) => logs.push(l) };
    await expect(readProviderKey(legacyEntry, stores)).resolves.toBe("sk-old");
    await expect(providerKeys.get("default")).resolves.toBe("sk-old");
    expect(logs.join("\n")).not.toContain("sk-old");
  });

  it("does not look at legacy keys for other ids or when the config was not migrated", async () => {
    const legacy = createMemorySecretStore({
      [providerAccount("anthropic", "https://api.anthropic.com")]: "sk-old",
    });
    const providerKeys = createMemorySecretStore();
    await expect(
      readProviderKey(
        { ...legacyEntry, id: "work" },
        {
          providerKeys,
          legacy,
          migrateLegacy: true,
          log: () => {},
        },
      ),
    ).resolves.toBeUndefined();
    await expect(
      readProviderKey(legacyEntry, { providerKeys, legacy, migrateLegacy: false, log: () => {} }),
    ).resolves.toBeUndefined();
  });

  it("still returns the legacy key when copying it fails", async () => {
    const refusing: SecretStore = {
      ...createMemorySecretStore(),
      set: async () => {
        throw new Error("keyring refused");
      },
    };
    const legacy = createMemorySecretStore({
      [providerAccount("anthropic", "https://api.anthropic.com")]: "sk-old",
    });
    const logs: string[] = [];
    await expect(
      readProviderKey(legacyEntry, {
        providerKeys: refusing,
        legacy,
        migrateLegacy: true,
        log: (l) => logs.push(l),
      }),
    ).resolves.toBe("sk-old");
    expect(logs[0]).toContain("could not copy");
  });

  it("propagates a locked keyring so the lazy provider retries; hasProviderKey says false", async () => {
    const locked: SecretStore = {
      ...createMemorySecretStore(),
      get: async () => {
        throw new Error("Cannot get secret of a locked object");
      },
    };
    const stores = {
      providerKeys: locked,
      legacy: createMemorySecretStore(),
      migrateLegacy: false,
      log: () => {},
    };
    await expect(readProviderKey(legacyEntry, stores)).rejects.toThrow("locked");
    await expect(hasProviderKey(legacyEntry, stores)).resolves.toBe(false);
  });
});

describe("env keys in the read-only profile (M2.5 contracts §7 #14)", () => {
  it("takes JARVIS_PROVIDER_KEY_* out of the env and serves them by provider id", async () => {
    const env: Record<string, string | undefined> = {
      PATH: "/usr/bin",
      JARVIS_PROVIDER_KEY_MY_CLOUD: "sk-cloud",
      JARVIS_PROVIDER_KEY_EMPTY: "",
    };
    const keys = takeEnvProviderKeys(env);
    expect(env).toEqual({ PATH: "/usr/bin" });
    expect(envProviderKeyName("my-cloud")).toBe("JARVIS_PROVIDER_KEY_MY_CLOUD");
    const store = createEnvKeyStore(keys);
    await expect(store.get("my-cloud")).resolves.toBe("sk-cloud");
    await expect(store.get("other")).resolves.toBeUndefined();
    await expect(store.set("my-cloud", "sk-new")).rejects.toThrow(/JARVIS_PROVIDER_KEY_MY_CLOUD/);
    await expect(
      hasProviderKey(
        { id: "my-cloud", kind: "openai", baseUrl: "https://api.openai.com" },
        {
          providerKeys: store,
          legacy: createEnvKeyStore(new Map()),
          migrateLegacy: false,
          log: () => {},
        },
      ),
    ).resolves.toBe(true);
  });
});
