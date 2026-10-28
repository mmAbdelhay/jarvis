import { describe, expect, it, vi } from "vitest";
import { composeSubmission, createAttachTray, submit } from "./claude-compose";

const failedText = () => "Upload failed";
import type { SessionInput, SendResult } from "./session-input";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

describe("attach tray", () => {
  it("busy while uploading; remove cancels; paths in pick order; maxFiles enforced", async () => {
    const a = deferred<{ fileId: string }>();
    const b = deferred<{ fileId: string }>();
    const upload = vi.fn((pick: { name: string }) => (pick.name === "a" ? a.promise : b.promise));
    const attach = vi.fn(async (fileId: string) => ({ ok: true as const, path: `/${fileId}` }));
    const tray = createAttachTray({ send: upload, attach, failedText, maxFiles: 2 });
    const listener = vi.fn();
    tray.subscribe(listener);
    tray.add({ name: "a" });
    tray.add({ name: "b" });
    tray.add({ name: "c" });
    expect(upload).toHaveBeenCalledTimes(2);
    expect(tray.busy()).toBe(true);
    b.resolve({ fileId: "b" });
    await flush();
    expect(tray.busy()).toBe(true);
    a.resolve({ fileId: "a" });
    await flush();
    expect(tray.paths()).toEqual(["/a", "/b"]);
    expect(tray.busy()).toBe(false);
    expect(listener).toHaveBeenCalled();
    tray.clear();
    expect(tray.items()).toEqual([]);

    const late = deferred<{ fileId: string }>();
    const cancelled = createAttachTray({
      send: () => late.promise,
      attach,
      failedText,
      maxFiles: 1,
    });
    cancelled.add({ name: "late" });
    const id = cancelled.items()[0]?.id;
    if (!id) throw new Error("missing item");
    cancelled.remove(id);
    late.resolve({ fileId: "late" });
    await flush();
    expect(cancelled.busy()).toBe(false);
    expect(cancelled.items()).toEqual([]);
    expect(attach).not.toHaveBeenCalledWith("late");
  });

  it("reports upload and attach errors", async () => {
    const tray = createAttachTray({
      send: async () => ({ error: "upload failed" }),
      attach: vi.fn(),
      failedText,
      maxFiles: 1,
    });
    tray.add({ name: "a" });
    await flush();
    expect(tray.items()[0]).toMatchObject({ state: "error", error: "upload failed" });
    const other = createAttachTray({
      send: async () => ({ fileId: "a" }),
      attach: async () => ({ ok: false, error: "attach failed" }),
      failedText,
      maxFiles: 1,
    });
    other.add({ name: "a" });
    await flush();
    expect(other.items()[0]).toMatchObject({ state: "error", error: "attach failed" });
  });

  it("a send that throws shows the screen's own failed text, never the error's", async () => {
    const tray = createAttachTray({
      send: async () => {
        throw new Error("socket closed");
      },
      attach: vi.fn(),
      failedText: () => "فشل الرفع",
      maxFiles: 1,
    });
    tray.add({ name: "a" });
    await flush();
    expect(tray.items()[0]).toMatchObject({ state: "error", error: "فشل الرفع" });
  });
});

it("composeSubmission prefixes @paths; empty text → only enter", () => {
  expect(composeSubmission("hello", ["p1", "p2"])).toEqual({ text: "@p1 @p2 hello", enter: true });
  expect(composeSubmission("", [])).toEqual({ text: "", enter: true });
});

it("submit blocked while busy; empty text sends only enter; text sends text then enter", async () => {
  const events: string[] = [];
  let result: SendResult = { kind: "sent" };
  const input = {
    sendText: async (text: string) => {
      events.push(text);
      return result;
    },
    sendKey: async (key: string) => {
      events.push(key);
      return result;
    },
  } as SessionInput;
  let busy = true;
  const tray = { busy: () => busy, paths: () => [] as string[], clear: vi.fn() };
  expect(await submit(input, tray, "hi")).toBe("blocked");
  expect(events).toEqual([]);
  busy = false;
  expect(await submit(input, tray, "")).toBe("sent");
  expect(events).toEqual(["enter"]);
  expect(await submit(input, tray, "hi")).toBe("sent");
  expect(events).toEqual(["enter", "hi", "enter"]);
  result = { kind: "offline" };
  expect(await submit(input, tray, "draft")).toEqual(result);
  expect(events).toEqual(["enter", "hi", "enter", "draft"]);
  expect(tray.clear).toHaveBeenCalledTimes(2);
});

it("submit includes attachment paths and keeps the tray if Enter fails", async () => {
  const events: string[] = [];
  const input = {
    sendText: async (text: string) => {
      events.push(text);
      return { kind: "sent" };
    },
    sendKey: async (key: string) => {
      events.push(key);
      return { kind: "uncertain" };
    },
  } as SessionInput;
  const tray = { busy: () => false, paths: () => ["/one", "/two"], clear: vi.fn() };
  expect(await submit(input, tray, "")).toEqual({ kind: "uncertain" });
  expect(events).toEqual(["@/one @/two ", "enter"]);
  expect(tray.clear).not.toHaveBeenCalled();
});
