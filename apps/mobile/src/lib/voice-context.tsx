// One `VoiceController` per app (ruling 14), built here and handed down
// through context — `app/voice.tsx` and the session-screen mic
// (`app/session/[id].tsx`) both read the same instance through
// `useVoiceController()` rather than each building their own, so a reply
// that arrives while you're on another screen is still tracked and still
// speaks (M7's reference-counted `subscribe` is what keeps it alive: the
// controller itself decides when to hold the `turn:new` subscription — see
// voice-controller.ts's `shouldHold`).
//
// This file only wires the controller's dependencies to the real app:
// the shared `RpcClient` (RpcContext, the same one every other screen
// uses), Task 6's native adapters, `realClock`, `Math.random`, and the
// persisted "Speak replies" preference. Every *decision* about what the
// controller does lives in voice-controller.ts (Task 7) — this file only
// builds the controller once; starting or stopping a recording is a call
// `MicButton` makes on a user's press, never something this file does on
// its own.
import { useEffect, useRef } from "react";
import type React from "react";
import { AppState } from "react-native";
import { createContext, useContext } from "react";
import { realClock } from "./clock";
import { loadPrefs } from "./prefs";
import { filePrefsStore } from "./prefs-file";
import { nativeRecordingFiles } from "./native-recording-files";
import { createNativeSpeaker } from "./native-speaker";
import { useNativeVoiceRecorder } from "./native-voice-recorder";
import { useRpcClient } from "./rpc-context";
import type { VoiceController } from "./voice-controller";
import { createVoiceController } from "./voice-controller";

const VoiceContext = createContext<VoiceController | undefined>(undefined);

export function VoiceProvider(props: { children: React.ReactNode }): React.JSX.Element {
  const client = useRpcClient();
  const recorder = useNativeVoiceRecorder();

  // Built exactly once, for the app's whole lifetime — same lazy-ref
  // pattern `_layout.tsx` uses for the one shared `RpcClient`. Also
  // rebuilt if the cached ref holds an already-disposed controller — under
  // React StrictMode's dev-only double-invoked effects, or a Fast Refresh
  // edit re-running this component's effects, the cleanup below runs once
  // more than the effect itself, which would otherwise leave this ref
  // pointing at a torn-down controller (every mic tap a silent no-op) for
  // the rest of the app's life. Mirrors `_layout.tsx`'s identical guard on
  // `connectionStoreRef`.
  const controllerRef = useRef<VoiceController | undefined>(undefined);
  if (controllerRef.current === undefined || controllerRef.current.isDisposed()) {
    controllerRef.current = createVoiceController({
      client,
      clock: realClock,
      recorder,
      speaker: createNativeSpeaker(),
      files: nativeRecordingFiles,
      random: Math.random,
      // Defaults on until prefs finish loading (prefs.ts's own fallback,
      // rule 16) — never a flash of "muted" before the saved value loads.
      speakReplies: true,
      log: (line) => console.log(line),
    });
  }
  const controller = controllerRef.current;

  // A third `loadPrefs` read (after `_layout.tsx`'s and Settings' own) —
  // fix round 1, Minor 5, flagged this as one file read to potentially
  // remove. It stays: `VoiceProvider`'s brief-mandated signature is
  // `{ children }` only (binding interface, task-8-brief.md), so there is
  // no prop this file can take the already-loaded value through, and
  // `prefs.ts`/`prefs-file.ts` are Task 7's files, not this task's to
  // change into a shared cache. `_layout.tsx` gates rendering on its own
  // `loadPrefs` finishing first, so this read never races a save the user
  // just made; it is a second read of the same settled file, not a
  // correctness risk.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const localeTag = Intl.DateTimeFormat().resolvedOptions().locale;
      const prefs = await loadPrefs(filePrefsStore, localeTag);
      if (!cancelled) {
        controller.setSpeakReplies(prefs.speakReplies);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [controller]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      controller.appStateChanged(state === "active");
    });
    return () => {
      subscription.remove();
      controller.dispose();
    };
  }, [controller]);

  return <VoiceContext.Provider value={controller}>{props.children}</VoiceContext.Provider>;
}

export function useVoiceController(): VoiceController {
  const value = useContext(VoiceContext);
  if (value === undefined) {
    throw new Error("useVoiceController() called outside VoiceProvider");
  }
  return value;
}
