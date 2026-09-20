import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CHANNELS_ARG_PREFIX,
  INVOKE_CHANNELS,
  PUSH_ADAPTERS,
  PUSH_CHANNELS,
  preloadChannelArgs,
} from "./channels.js";

const preload = readFileSync(new URL("./preload.cts", import.meta.url), "utf8");

describe("the channel table", () => {
  // Two methods sharing a channel means one of them dispatches the other's
  // handler. The type system cannot see it; this can.
  it("gives every method its own channel", () => {
    const all = [...Object.values(INVOKE_CHANNELS), ...Object.values(PUSH_CHANNELS)];

    expect(new Set(all).size).toBe(all.length);
  });

  it("spells every channel namespace:name", () => {
    const all = [...Object.values(INVOKE_CHANNELS), ...Object.values(PUSH_CHANNELS)];

    expect(all.filter((channel) => !/^[a-z]+:[A-Za-z]+$/.test(channel))).toEqual([]);
  });

  // The table only stays the single source of truth if preload reads it
  // rather than keeping a second copy. A literal invoke in preload is that
  // second copy growing back.
  it("is the only place preload learns a channel name", () => {
    expect(preload).not.toMatch(/ipcRenderer\.invoke\(["'`]/);
    expect(preload).not.toMatch(/ipcRenderer\.on\(["'`]/);
  });

  it("adapts only the two channels whose payload splats into two arguments", () => {
    expect(Object.keys(PUSH_ADAPTERS).sort()).toEqual(["onTerminalData", "onTerminalExit"]);
    expect(PUSH_ADAPTERS.onTerminalData?.({ paneKey: "t1", chunk: "x" } as never)).toEqual([
      "t1",
      "x",
    ]);
    expect(PUSH_ADAPTERS.onTerminalExit?.({ paneKey: "t1", code: 0 } as never)).toEqual(["t1", 0]);
  });

  it("covers every push channel the renderer can listen to", () => {
    expect(Object.values(PUSH_CHANNELS).sort()).toEqual([
      "docker:log",
      "git:counts",
      "metrics:update",
      "providers:update",
      "remote:update",
      "session:output",
      "sessions:update",
      "setup:output",
      "terminal:data",
      "terminal:exit",
      "turn:new",
      "voice:hotkeys",
      "voice:listening",
      "voice:notice",
      "voice:speaking",
      "workspace:devtoolsClosed",
      "workspace:devtoolsDockChosen",
      "workspace:update",
    ]);
  });
});

// preload.cts can no longer `require("./channels.js")` — it runs sandboxed
// (see preload-sandbox.test.ts) — so main.ts hands it this table over argv
// instead. This is Electron-free and pure precisely so main.ts's window
// construction, which isn't otherwise unit-testable, can stay a thin wrapper
// around it.
describe("preloadChannelArgs", () => {
  it("encodes exactly INVOKE_CHANNELS and PUSH_CHANNELS as one JSON argv entry", () => {
    const args = preloadChannelArgs();

    expect(args).toHaveLength(1);
    const arg = args[0] ?? "";
    expect(arg.startsWith(CHANNELS_ARG_PREFIX)).toBe(true);

    const parsed: unknown = JSON.parse(arg.slice(CHANNELS_ARG_PREFIX.length));
    expect(parsed).toEqual({ invoke: INVOKE_CHANNELS, push: PUSH_CHANNELS });
  });
});
