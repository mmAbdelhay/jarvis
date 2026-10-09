import { describe, expect, it } from "vitest";
import {
  CuClientError,
  isCuPauseReason,
  parseCuCapture,
  parseCuErrorCode,
  parseCuWindows,
  PNG_BASE64_PREFIX,
} from "./cu-protocol.js";

const window = {
  windowId: 7,
  appId: "org.gimp.GIMP",
  title: "beach.xcf",
  x: 0,
  y: 0,
  w: 800,
  h: 600,
  focused: true,
  allowed: true,
};

describe("jarvis-cu answers, parsed field by field (contracts §1)", () => {
  it("reads a window list and drops malformed entries", () => {
    expect(parseCuWindows([window, { ...window, focused: "yes" }, null])).toEqual([
      { ...window, windowId: "7" },
    ]);
    expect(() => parseCuWindows({})).toThrow(CuClientError);
  });

  it("reads a capture and refuses anything that is not a PNG in bounds", () => {
    const png = `${PNG_BASE64_PREFIX}AAAA`;
    expect(
      parseCuCapture({ pngBase64: png, width: 1280, height: 800, scale: 1.5, windows: [window] }),
    ).toMatchObject({
      width: 1280,
      height: 800,
      scale: 1.5,
      windows: [{ appId: "org.gimp.GIMP" }],
    });
    for (const bad of [
      { pngBase64: "R0lGODlh", width: 1, height: 1, scale: 1, windows: [] },
      { pngBase64: `${png}!`, width: 1, height: 1, scale: 1, windows: [] },
      { pngBase64: png, width: 0, height: 1, scale: 1, windows: [] },
      { pngBase64: png, width: 5000, height: 1, scale: 1, windows: [] },
      { pngBase64: png, width: 1, height: 1, scale: 0, windows: [] },
      null,
    ]) {
      expect(() => parseCuCapture(bad), JSON.stringify(bad)).toThrow(CuClientError);
    }
  });

  it("maps error codes and pause reasons", () => {
    expect(parseCuErrorCode("outside")).toBe("outside");
    expect(parseCuErrorCode("weird")).toBe("failed");
    expect(isCuPauseReason("esc")).toBe(true);
    expect(isCuPauseReason("bored")).toBe(false);
  });
});

import { createFakeCuClient } from "./cu-fake-client.js";
import { CU_MODEL_TEXT, CU_TEXT, joinApps } from "./cu-text.js";

it("supports app discovery before begin and accessibility descriptions in capture space", async () => {
  const fake = createFakeCuClient();
  expect(await fake.client.apps()).toEqual([{ appId: "org.gimp.GIMP", name: "GIMP" }]);
  expect(await fake.client.describeAt(20, 30)).toEqual({ role: "unknown" });
  expect(fake.calls).toEqual([
    { op: "apps", args: [] },
    { op: "describeAt", args: [20, 30] },
  ]);
  expect(CU_MODEL_TEXT.needAppsNoList).toContain("running app ids");
  expect(CU_TEXT.en.sessionDetail).toContain("fullscreen");
  expect(joinApps(["GIMP", "Files"], "ar")).toBe("GIMP، Files");
});

it("records failures, repeats the last capture and removes event subscriptions", async () => {
  const fake = createFakeCuClient({ captures: ["first", "last"], fail: { type: "excluded" } });
  expect((await fake.client.capture(1280)).pngBase64).toBe("first");
  expect((await fake.client.capture(1280)).pngBase64).toBe("last");
  expect((await fake.client.capture(1280)).pngBase64).toBe("last");
  await expect(fake.client.type("private")).rejects.toMatchObject({ code: "excluded" });
  const events: string[] = [];
  const offPause = fake.client.onPaused((reason) => events.push(reason));
  const offGone = fake.client.onGone(() => events.push("gone"));
  fake.pause("physical-input");
  fake.gone();
  offPause();
  offGone();
  fake.pause("locked");
  fake.gone();
  expect(events).toEqual(["physical-input", "gone"]);
});

import { parseCuAppList, parseCuDescription } from "./cu-protocol.js";
it("parses discovery and accessibility fields without accepting extra wire fields", () => {
  expect(
    parseCuAppList([
      { appId: "org.gimp.GIMP", name: "GIMP", title: "private" },
      null,
      { appId: 1, name: "bad" },
    ]),
  ).toEqual([{ appId: "org.gimp.GIMP", name: "GIMP" }]);
  expect(() => parseCuAppList({})).toThrow(CuClientError);
  expect(parseCuDescription({ role: "button", name: "Save", extra: true })).toEqual({
    role: "button",
    name: "Save",
  });
  expect(parseCuDescription({ role: "unknown" })).toEqual({ role: "unknown" });
  expect(() => parseCuDescription({ role: 1 })).toThrow(CuClientError);
  expect(() => parseCuDescription({ role: "button", name: 1 })).toThrow(CuClientError);
});

it("bounds untrusted window and image payloads", () => {
  expect(parseCuWindows(Array.from({ length: 70 }, () => window))).toHaveLength(64);
  expect(
    parseCuWindows([
      { ...window, x: Infinity },
      { ...window, w: NaN },
      { ...window, allowed: 1 },
    ]),
  ).toEqual([]);
  expect(parseCuWindows([{ ...window, title: "x".repeat(600) }])[0]?.title).toHaveLength(512);
  for (const patch of [
    { width: 1.5 },
    { height: Infinity },
    { scale: NaN },
    { windows: {} },
    { pngBase64: `iVBORw0KGgo${"A".repeat(16 * 1024 * 1024)}` },
  ]) {
    expect(() =>
      parseCuCapture({
        pngBase64: "iVBORw0KGgoAAAA",
        width: 1,
        height: 1,
        scale: 1,
        windows: [],
        ...patch,
      }),
    ).toThrow(CuClientError);
  }
});
