import { contextBridge, ipcRenderer } from "electron";
import type { INVOKE_CHANNELS, PUSH_ADAPTERS, PUSH_CHANNELS, PushKey } from "./channels.js";
import type { RendererApi } from "./ipc.js";

/**
 * Built from the channel table rather than written out, so there is exactly
 * one list of channel names in the app and a second transport can read the
 * same one. The cost is the cast at the bottom: the members are assembled
 * dynamically, so each one is no longer individually checked here. What
 * replaces that check is stronger — channels.ts is declared `satisfies` a
 * mapped type over RendererApi, so tsc rejects a method with no channel and
 * a channel with no method, which this file never verified when it was
 * written by hand.
 *
 * The table can no longer come from a value import of "./channels.js" the
 * way it once did (889e2fa): this window is created with
 * `contextIsolation: true` and `sandbox: true` (see main.ts), and a
 * sandboxed preload's `require` is restricted to Electron's own built-ins
 * (electron, events, timers, url) — it can never reach a local file, so
 * a bare `require` of that local file threw at launch and `window.jarvis`
 * never got built. main.ts isn't sandboxed, so it reads INVOKE_CHANNELS and
 * PUSH_CHANNELS from channels.ts and hands them to this process over argv
 * (`preloadChannelArgs()`) instead — the same path `--jarvis-first-run`
 * already used, since the renderer needs both while it is deciding what to
 * draw, before any round trip could answer. The two imports above are
 * `import type` only, so they carry no runtime `require` into the compiled
 * output — only types, erased at build time — and channels.ts stays the
 * single place the channel strings are written.
 */
const CHANNELS_FLAG = "--jarvis-channels=";

/**
 * Guards the parsed argument's shape rather than trusting `JSON.parse`'s
 * return type. Valid-but-wrong-shape JSON (`{}`, `null`, a table missing
 * `invoke` or `push`, or `invoke`/`push` given as arrays) used to sail
 * through as `any` and only fail later, at `Object.entries(undefined)` (or
 * silently produce an empty api for an array, since `typeof [] ===
 * "object"`) — a crash, or a quiet no-op, that never mentions the flag it
 * came from.
 */
function hasInvokeAndPush(
  value: unknown,
): value is { invoke: typeof INVOKE_CHANNELS; push: typeof PUSH_CHANNELS } {
  if (typeof value !== "object" || value === null) return false;
  const { invoke, push } = value as { invoke?: unknown; push?: unknown };
  return (
    typeof invoke === "object" &&
    invoke !== null &&
    !Array.isArray(invoke) &&
    typeof push === "object" &&
    push !== null &&
    !Array.isArray(push)
  );
}

function readChannelTable(): { invoke: typeof INVOKE_CHANNELS; push: typeof PUSH_CHANNELS } {
  const arg = process.argv.find((entry) => entry.startsWith(CHANNELS_FLAG));
  if (arg === undefined) {
    // A dead bridge should say why: silently exposing an empty api leaves
    // every `window.jarvis.*` call failing with "Cannot read properties of
    // undefined" and no clue where to look.
    throw new Error(
      `preload started without ${CHANNELS_FLAG}<json>; main.ts must pass INVOKE_CHANNELS and PUSH_CHANNELS via additionalArguments`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(arg.slice(CHANNELS_FLAG.length));
  } catch (error) {
    throw new Error(
      `preload could not parse the ${CHANNELS_FLAG} argument as JSON: ${(error as Error).message}`,
    );
  }
  if (!hasInvokeAndPush(parsed)) {
    throw new Error(
      `preload's ${CHANNELS_FLAG} argument is missing invoke/push: expected {"invoke":{...},"push":{...}}, got ${JSON.stringify(parsed)}`,
    );
  }
  return parsed;
}

const { invoke: invokeChannels, push: pushChannels } = readChannelTable();

/**
 * The two listeners whose callback takes two arguments rather than the
 * payload itself. Functions can't survive JSON.stringify, so unlike the
 * rest of the table these can't travel over argv — they stay inline here,
 * duplicated from channels.ts's PUSH_ADAPTERS. The key-set check below is
 * as far as a type-only import can hold them to that source: it proves at
 * compile time that this object and channels.ts's agree on which two
 * methods get adapted, though (unlike channels.ts's own AssertTrue checks)
 * it can't see whether the two bodies still compute the same thing.
 */
const pushAdapters = {
  onTerminalData: (payload: { paneKey: string; chunk: string }) => [payload.paneKey, payload.chunk],
  onTerminalExit: (payload: { paneKey: string; code: number }) => [payload.paneKey, payload.code],
};

type LocalAdapterKeys = keyof typeof pushAdapters;
type RealAdapterKeys = keyof typeof PUSH_ADAPTERS;
type AssertTrue<T extends true> = T;
type AdapterKeysMatch = LocalAdapterKeys extends RealAdapterKeys
  ? RealAdapterKeys extends LocalAdapterKeys
    ? true
    : false
  : false;
// Exported so tsc cannot call it unused and skip evaluating it — the same
// reason channels.ts exports its own AssertTrue checks.
export type PushAdaptersKeysMatchChannelsTs = AssertTrue<AdapterKeysMatch>;

// Widened to every push key (each optional) only here, at the point of use,
// so the `keyof` check above stays narrowed to the two keys this object
// actually has.
const adaptersByChannel: { [K in PushKey]?: (payload: never) => unknown[] } = pushAdapters;

const api: Record<string, unknown> = {
  platform: process.platform,
  // Set by main before the renderer loads — see ensureConfigFile, which
  // reports whether this launch created the config file.
  firstRun: process.argv.includes("--jarvis-first-run"),
};

for (const [method, channel] of Object.entries(invokeChannels)) {
  api[method] = (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
}

for (const [method, channel] of Object.entries(pushChannels)) {
  const adapt = adaptersByChannel[method as PushKey];
  api[method] = (callback: (...args: unknown[]) => void) => {
    ipcRenderer.on(channel, (_event, payload: unknown) => {
      // Two channels splat their payload into two arguments; the rest pass it
      // through. See pushAdapters above.
      if (adapt === undefined) callback(payload);
      else callback(...adapt(payload as never));
    });
  };
}

contextBridge.exposeInMainWorld("jarvis", api as unknown as RendererApi);
