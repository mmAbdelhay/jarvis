import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHANNELS_ARG_PREFIX,
  INVOKE_CHANNELS,
  PUSH_ADAPTERS,
  PUSH_CHANNELS,
  preloadChannelArgs,
} from "./channels.js";

// preload.cts is what actually runs in the renderer; PUSH_ADAPTERS in
// channels.ts (checked against the inline copy below, in case (c)) has no
// other runtime consumer, so this test runs the real preload.cts, in Node,
// with `electron` mocked, rather than re-describing its behaviour.
//
// `vi.mock("electron")` does not intercept a module loaded under the `.cts`
// extension, so preload.cts is copied to a `.ts` sibling and that copy is
// imported instead — renaming to `.ts` lets vitest's own transform pipeline
// handle it, with the mock applied. The copy is made once in beforeAll and
// removed in afterAll, in a directory next to (not inside) src/ — a real OS
// tmpdir does not work here: vitest only intercepts imports for modules
// inside its project root, so a module loaded from outside it (or from
// node_modules) falls through to Node's native loader, which cannot resolve
// "electron" at all. preload.cts's only local imports are `import type`,
// which erase before the copy is made, so the copy needs no siblings.
const preloadDir = mkdtempSync(
  join(fileURLToPath(new URL("..", import.meta.url)), ".jarvis-preload-"),
);
const preloadCopyPath = join(preloadDir, "preload.ts");

beforeAll(() => {
  copyFileSync(new URL("./preload.cts", import.meta.url), preloadCopyPath);
});

afterAll(() => {
  rmSync(preloadDir, { recursive: true, force: true });
});

async function loadPreload(): Promise<void> {
  await import(pathToFileURL(preloadCopyPath).href);
}

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn() },
}));

const ORIGINAL_ARGV = [...process.argv];

beforeEach(async () => {
  vi.resetModules();
  process.argv = [...ORIGINAL_ARGV];
  // `vi.resetModules()` only clears vite-node's module cache, so preload.cts
  // gets re-evaluated on the next import; the mocked "electron" module's
  // `vi.fn()`s are a separate registry and survive that reset, so they need
  // clearing by hand or each test would see every prior test's calls too.
  const { contextBridge, ipcRenderer } = await electronMocks();
  contextBridge.exposeInMainWorld.mockClear();
  ipcRenderer.invoke.mockClear();
  ipcRenderer.on.mockClear();
});

afterEach(() => {
  process.argv = [...ORIGINAL_ARGV];
});

async function electronMocks() {
  const electron = (await import("electron")) as unknown as {
    contextBridge: { exposeInMainWorld: ReturnType<typeof vi.fn> };
    ipcRenderer: { invoke: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
  };
  return electron;
}

/** The api object preload.cts handed to `contextBridge.exposeInMainWorld`. */
async function exposedApi(): Promise<Record<string, (...args: unknown[]) => unknown>> {
  const { contextBridge } = await electronMocks();
  expect(contextBridge.exposeInMainWorld).toHaveBeenCalledTimes(1);
  const [name, api] = contextBridge.exposeInMainWorld.mock.calls[0] as [
    string,
    Record<string, (...args: unknown[]) => unknown>,
  ];
  expect(name).toBe("jarvis");
  return api;
}

/** The handler preload.cts registered via `ipcRenderer.on(channel, ...)`. */
async function pushHandler(channel: string): Promise<(event: unknown, payload: unknown) => void> {
  const { ipcRenderer } = await electronMocks();
  const call = (
    ipcRenderer.on.mock.calls as [string, (event: unknown, payload: unknown) => void][]
  ).find(([registeredChannel]) => registeredChannel === channel);
  expect(call, `ipcRenderer.on was never called with channel "${channel}"`).toBeDefined();
  return call![1];
}

describe("preload.cts (the real file, run in Node)", () => {
  it("(a) exposes platform, firstRun, and every invoke/push method", async () => {
    process.argv.push(...preloadChannelArgs());
    await loadPreload();
    const api = await exposedApi();
    expect(new Set(Object.keys(api))).toEqual(
      new Set([
        "platform",
        "firstRun",
        ...Object.keys(INVOKE_CHANNELS),
        ...Object.keys(PUSH_CHANNELS),
      ]),
    );
  });

  it("(b) forwards an invoke call's channel and args exactly", async () => {
    process.argv.push(...preloadChannelArgs());
    await loadPreload();
    const api = await exposedApi();
    const { ipcRenderer } = await electronMocks();

    api.gitDiff?.("s1", "a.ts");

    expect(ipcRenderer.invoke).toHaveBeenCalledWith(INVOKE_CHANNELS.gitDiff, "s1", "a.ts");
  });

  it.each([
    ["onTerminalData", { paneKey: "p1", chunk: "hello" }],
    ["onTerminalExit", { paneKey: "p1", code: 0 }],
  ] as const)("(c) %s matches channels.ts's own PUSH_ADAPTERS entry", async (key, payload) => {
    process.argv.push(...preloadChannelArgs());
    await loadPreload();
    const api = await exposedApi();
    const callback = vi.fn();

    api[key]?.(callback);
    const handler = await pushHandler(PUSH_CHANNELS[key]);
    handler(undefined, payload);

    expect(callback).toHaveBeenCalledWith(...PUSH_ADAPTERS[key](payload as never));
  });

  it("(d) passes a plain push payload through unchanged", async () => {
    process.argv.push(...preloadChannelArgs());
    await loadPreload();
    const api = await exposedApi();
    const callback = vi.fn();

    api.onMetrics?.(callback);
    const handler = await pushHandler(PUSH_CHANNELS.onMetrics);
    const payload = { cpuPercent: 12 };
    handler(undefined, payload);

    expect(callback).toHaveBeenCalledWith(payload);
  });

  it("(e) throws naming the flag when it's missing entirely", async () => {
    await expect(loadPreload()).rejects.toThrow(CHANNELS_ARG_PREFIX);
  });

  it("(f) throws naming the flag on truncated JSON", async () => {
    process.argv.push(`${CHANNELS_ARG_PREFIX}{"inv`);
    await expect(loadPreload()).rejects.toThrow(CHANNELS_ARG_PREFIX);
  });

  it("(g) throws naming the flag and the missing shape for {}", async () => {
    process.argv.push(`${CHANNELS_ARG_PREFIX}{}`);
    const error = await loadPreload().then(
      () => null,
      (caught: unknown) => caught as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain(CHANNELS_ARG_PREFIX);
    expect(error?.message).toMatch(/invoke\/push/);
  });

  it("(h) throws naming the flag and the missing shape for null", async () => {
    process.argv.push(`${CHANNELS_ARG_PREFIX}null`);
    const error = await loadPreload().then(
      () => null,
      (caught: unknown) => caught as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain(CHANNELS_ARG_PREFIX);
    expect(error?.message).toMatch(/invoke\/push/);
  });

  it("(i) throws naming the flag and the missing shape when invoke/push are arrays", async () => {
    process.argv.push(`${CHANNELS_ARG_PREFIX}{"invoke":[],"push":[]}`);
    const error = await loadPreload().then(
      () => null,
      (caught: unknown) => caught as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain(CHANNELS_ARG_PREFIX);
    expect(error?.message).toMatch(/invoke\/push/);
  });
});
