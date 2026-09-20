import { NativeModule, requireNativeModule } from "expo-modules-core";

// The raw shape of the events the native side (Swift/Kotlin) emits, keyed
// by socket id — see behaviour rule "Native module JS API" in the task
// brief. This file only declares the native module's shape; nothing here
// runs unless something actually imports it, which `../index.ts` only does
// through a lazily-required path (see `apps/mobile/src/lib/native-transport.ts`)
// so that loading this file — and, through it, `expo-modules-core` and
// `react-native` — never happens in a unit test.
export type PinnedSocketEvents = {
  onOpen: (event: { id: number }) => void;
  onMessage: (event: { id: number; text: string }) => void;
  onClose: (event: { id: number; code: number; reason: string }) => void;
  onError: (event: { id: number; message: string }) => void;
};

declare class PinnedSocketNativeModule extends NativeModule<PinnedSocketEvents> {
  open(url: string, fingerprintHex: string): number;
  send(id: number, text: string): void;
  sendBinary(id: number, base64: string): void;
  close(id: number, code: number, reason: string): void;
}

export default requireNativeModule<PinnedSocketNativeModule>("PinnedSocket");
