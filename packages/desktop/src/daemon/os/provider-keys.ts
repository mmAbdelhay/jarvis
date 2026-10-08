// Provider keys by id (M2.5 contracts §1: attribute provider=<id>). An M1/M2
// machine has its one key under account="<kind> <baseUrl>"; when the config
// was migrated (id "default"), the first read copies it to provider=default
// so nobody re-enters a key after the upgrade. The old item is left alone
// (a rollback to M2 still finds it). Never logs a key.
//
// No electron here (core/no-electron.test.ts).
import { providerAccount, type SecretStore } from "@jarvis/platform/model";
import { LEGACY_PROVIDER_ID } from "./provider-list-config.js";

export type ProviderKeyStores = {
  providerKeys: SecretStore;
  legacy: SecretStore;
  migrateLegacy: boolean;
  log(line: string): void;
};

type KeyedEntry = { id: string; kind: string; baseUrl: string };

export async function readProviderKey(
  entry: KeyedEntry,
  stores: ProviderKeyStores,
): Promise<string | undefined> {
  const key = await stores.providerKeys.get(entry.id);
  if (key !== undefined || !stores.migrateLegacy || entry.id !== LEGACY_PROVIDER_ID) return key;
  const legacy = await stores.legacy.get(providerAccount(entry.kind, entry.baseUrl));
  if (legacy === undefined) return undefined;
  try {
    await stores.providerKeys.set(entry.id, legacy);
  } catch (error) {
    stores.log(
      `[keys] could not copy the earlier key to provider=${entry.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return legacy;
}

export async function hasProviderKey(
  entry: KeyedEntry,
  stores: ProviderKeyStores,
): Promise<boolean> {
  try {
    return (await readProviderKey(entry, stores)) !== undefined;
  } catch {
    return false;
  }
}
