// A CuClient for tests (core, desktop): records ops, returns a fresh PNG-ish
// capture each time unless told otherwise, and can push pause/gone events.
// Exported like createFakeProvider; never used by jarvisd at run time.
import type { CuPauseReason } from "./contract.js";
import {
  type CuClient,
  CuClientError,
  type CuErrorCode,
  type CuWindow,
  PNG_BASE64_PREFIX,
} from "./cu-protocol.js";

export const FAKE_CU_WINDOW: CuWindow = {
  windowId: "1",
  appId: "org.gimp.GIMP",
  title: "beach.xcf – GIMP",
  x: 0,
  y: 0,
  w: 1280,
  h: 800,
  focused: true,
  allowed: true,
};

export function createFakeCuClient(
  options: {
    captures?: string[];
    windows?: CuWindow[];
    fail?: Partial<Record<string, CuErrorCode>>;
  } = {},
): {
  client: CuClient;
  calls: { op: string; args: unknown[] }[];
  pause(reason: CuPauseReason): void;
  gone(): void;
} {
  const calls: { op: string; args: unknown[] }[] = [];
  const paused = new Set<(reason: CuPauseReason) => void>();
  const gone = new Set<() => void>();
  let captures = 0;
  const op = async (name: string, ...args: unknown[]) => {
    calls.push({ op: name, args });
    const code = options.fail?.[name];
    if (code !== undefined) throw new CuClientError(code, `${name} refused (${code})`);
  };
  const windows = options.windows ?? [FAKE_CU_WINDOW];
  const client: CuClient = {
    apps: async () => {
      await op("apps");
      return [...new Set(windows.map((window) => window.appId))].map((appId) => ({
        appId,
        name: appId === "org.gimp.GIMP" ? "GIMP" : appId,
      }));
    },
    describeAt: async (x, y) => {
      await op("describeAt", x, y);
      return { role: "unknown" };
    },
    describeFocused: async () => {
      await op("describeFocused");
      return { role: "unknown" };
    },
    begin: (sessionId, appIds) => op("begin", sessionId, [...appIds]),
    windows: async () => {
      await op("windows");
      return windows;
    },
    capture: async (maxEdge) => {
      await op("capture", maxEdge);
      const list = options.captures;
      const png =
        list !== undefined && list.length > 0
          ? (list[Math.min(captures, list.length - 1)] as string)
          : `${PNG_BASE64_PREFIX}A${captures}`;
      captures++;
      return { pngBase64: png, width: 1280, height: 800, scale: 1, windows };
    },
    click: (x, y, button, double) => op("click", x, y, button, double),
    type: (text) => op("type", text),
    key: (combo) => op("key", combo),
    scroll: (x, y, dx, dy) => op("scroll", x, y, dx, dy),
    drag: (x1, y1, x2, y2) => op("drag", x1, y1, x2, y2),
    end: () => op("end"),
    onPaused(listener) {
      paused.add(listener);
      return () => paused.delete(listener);
    },
    onGone(listener) {
      gone.add(listener);
      return () => gone.delete(listener);
    },
  };
  return {
    client,
    calls,
    pause: (reason) => {
      for (const listener of [...paused]) listener(reason);
    },
    gone: () => {
      for (const listener of [...gone]) listener();
    },
  };
}
