// The one app store over the real keychains. Opening it migrates an existing
// pairing, invisibly. Everything that reads or writes a stored pairing goes
// through it, after `openMachineStore`, since any screen may be the first.

import { Platform } from "react-native";
import { clientPlatformFor } from "./client-platform";
import { type MachineStore, createMachineStore, createMachineStoreOpener } from "./machine-store";
import { filePrefsStore } from "./prefs-file";
import { refreshStore } from "./refresh-store";
import { expoSecureStore } from "./secure-store";

const SINGLE_SLOT = clientPlatformFor(Platform.OS) === "web";

export const machineStore: MachineStore = createMachineStore({
  secure: expoSecureStore,
  refresh: refreshStore,
  prefs: filePrefsStore,
  localeTag: Intl.DateTimeFormat().resolvedOptions().locale,
  singleSlot: SINGLE_SLOT,
  log: (line) => console.log(line),
});

export const openMachineStore = createMachineStoreOpener(
  machineStore,
  (line) => console.warn(line),
  { rereadEachTime: SINGLE_SLOT },
);

/** Rejects when the keychain cannot be read: never an empty answer for that. */
export async function loadActiveMachine(): ReturnType<MachineStore["loadActive"]> {
  await openMachineStore();
  return machineStore.loadActive();
}
