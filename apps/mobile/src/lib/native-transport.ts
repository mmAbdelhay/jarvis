// The real `Transport`, backed by the `modules/pinned-socket` native
// module. Routes the module's four id-keyed events to the `onEvent`
// callback each `open` call was given, and validates the fingerprint
// before ever reaching native code — see behaviour rule 8 in
// task-3-brief.md and its bite-proof test in transport.test.ts.
//
// M11 (task-5-brief.md, rule 2): this transport is pin-only. A `trust.kind
// === "system"` call — a link with a DNS `name`, which system-transport.ts
// handles instead — gets the exact same refusal shape as an invalid
// fingerprint: there is no fingerprint to check, so it is treated as one.

import { FINGERPRINT_PATTERN } from "@jarvis/wire";
// `import type` is fully erased at transform time (Vite/esbuild strip it
// before any module resolution that would touch `expo-modules-core`), so
// this does not re-introduce the "no native modules in unit tests"
// problem `loadRealModule` below works around — only a value import would.
import type { PinnedSocketEvents } from "../../modules/pinned-socket";
import type { Transport, TransportEvent, TransportSocket } from "./transport";

export type { PinnedSocketEvents };

/** The shape `modules/pinned-socket/index.ts` exports — what a fake native
 * module (set via `setNativeModuleForTests`) must implement. */
export type NativeSocketModule = {
  open(url: string, fingerprintHex: string): number;
  send(id: number, text: string): void;
  sendBinary(id: number, base64: string): void;
  close(id: number, code: number, reason: string): void;
  addListener<EventName extends keyof PinnedSocketEvents>(
    eventName: EventName,
    listener: PinnedSocketEvents[EventName],
  ): { remove(): void };
};

// Declared locally, not imported from `@types/node`: Metro (the bundler
// that runs this file on the phone) injects a real `require` into every
// module's scope, so this typechecks and works there without a dependency
// this app otherwise has no use for.
declare function require(id: string): unknown;

let overrideModule: NativeSocketModule | undefined;

function loadRealModule(): NativeSocketModule {
  // A static `import` at the top of this file would pull in
  // `expo-modules-core` and, through it, `react-native` — both unparsable
  // under Vitest's plain Node environment (no Metro/Babel Flow transform;
  // see the app's "no native modules in unit tests" rule). A `require`
  // call inside a function that a test never calls is never even looked
  // at by Vitest's bundler, so that chain is only ever touched by the real
  // Metro bundle — never by a test file, which always calls
  // `setNativeModuleForTests` before opening a socket.
  return require("../../modules/pinned-socket") as NativeSocketModule;
}

function currentModule(): NativeSocketModule {
  return overrideModule ?? loadRealModule();
}

/** Test-only injection point: replaces the native module `nativeTransport`
 * calls into. Pass `undefined` to restore the real module. */
export function setNativeModuleForTests(fake: NativeSocketModule | undefined): void {
  overrideModule = fake;
}

const routes = new Map<number, (event: TransportEvent) => void>();
let listenersAttachedTo: NativeSocketModule | undefined;

function ensureListeners(nativeModule: NativeSocketModule): void {
  if (listenersAttachedTo === nativeModule) return;

  nativeModule.addListener("onOpen", ({ id }) => {
    routes.get(id)?.({ kind: "open" });
  });
  nativeModule.addListener("onMessage", ({ id, text }) => {
    routes.get(id)?.({ kind: "message", text });
  });
  nativeModule.addListener("onClose", ({ id, code, reason }) => {
    const onEvent = routes.get(id);
    routes.delete(id);
    onEvent?.({ kind: "close", code, reason });
  });
  nativeModule.addListener("onError", ({ id, message }) => {
    routes.get(id)?.({ kind: "error", message });
  });

  listenersAttachedTo = nativeModule;
}

export const nativeTransport: Transport = {
  open(url, trust, onEvent) {
    const fingerprint = trust.kind === "pin" ? trust.fingerprint : undefined;
    if (fingerprint === undefined || !FINGERPRINT_PATTERN.test(fingerprint)) {
      // Bad value (or a `system`-trust call, which this transport never
      // handles): an `error` then `close 1006` event, synchronously via a
      // microtask, never a native call (behaviour rule 8; M11 rule 2).
      queueMicrotask(() => {
        onEvent({ kind: "error", message: "invalid fingerprint" });
        onEvent({ kind: "close", code: 1006, reason: "fingerprint" });
      });
      return {
        send(): void {
          // No socket was ever opened; nothing to send to.
        },
        sendBinary(): void {
          // No socket was ever opened; nothing to send to.
        },
        close(): void {
          // Already conceptually closed; nothing to close.
        },
      };
    }

    const nativeModule = currentModule();
    ensureListeners(nativeModule);

    const id = nativeModule.open(url, fingerprint);
    routes.set(id, onEvent);

    const socket: TransportSocket = {
      send(text: string): void {
        nativeModule.send(id, text);
      },
      sendBinary(base64: string): void {
        nativeModule.sendBinary(id, base64);
      },
      close(code: number, reason = ""): void {
        nativeModule.close(id, code, reason);
      },
    };
    return socket;
  },
};
