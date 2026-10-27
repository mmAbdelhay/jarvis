import { ATTACH_UPLOAD_CHANNEL, FILE_UPLOAD_CHANNEL, MAX_FILE_BYTES } from "@jarvis/wire";
import { describe, expect, it, vi } from "vitest";
import { type AttachPick, attachPickOf, createAttachUploader } from "./claude-attach";
import { createAttachTray } from "./claude-compose";
import type { UploadFiles } from "./file-upload-controller";
import type { ClientState, RpcClient, RpcResult } from "./rpc-client";

function fakeClient(overrides: Partial<RpcClient> = {}): RpcClient {
  const base: RpcClient = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    call: vi.fn(async (): Promise<RpcResult> => ({ ok: false, error: { kind: "offline" } })),
    upload: vi.fn(async (): Promise<RpcResult> => ({ ok: false, error: { kind: "offline" } })),
    subscribe: vi.fn((): RpcResult<void> => ({ ok: true, value: undefined })),
    unsubscribe: vi.fn(),
    onPush: vi.fn(() => () => {}),
    onState: vi.fn(() => () => {}),
    state: vi.fn((): ClientState => "open"),
    capabilities: vi.fn(() => []),
    subscriptions: vi.fn(() => []),
    lastFrameAt: vi.fn(() => undefined),
    setAppActive: vi.fn(),
    unlock: vi.fn(),
    lock: vi.fn(),
  };
  return { ...base, ...overrides };
}

function fakeFiles(): UploadFiles {
  return { readBase64: vi.fn(async () => "QQ=="), size: vi.fn(() => 1), remove: vi.fn() };
}

function staged(n: number) {
  const fileId = String(n).repeat(32);
  return { fileId, name: "x.jpg", contentType: "image/jpeg", bytes: 1, expiresAt: 9e12 };
}

const PHOTO = (name: string): AttachPick => ({
  uri: `file:///cache/${name}`,
  name,
  contentType: "image/jpeg",
  bytes: 1,
});

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("attach uploader", () => {
  it("tray integration: pick 2 → 2 chips uploading → done → paths", async () => {
    const uploads: ((result: RpcResult) => void)[] = [];
    let id = 0;
    const client = fakeClient({
      upload: vi.fn(
        (_channel, _args, _base64, options) =>
          new Promise<RpcResult>((resolve) => {
            options?.onProgress?.(1, 2);
            uploads.push(resolve);
          }),
      ),
      call: vi.fn(
        async (_channel: string, args: unknown[]): Promise<RpcResult> => ({
          ok: true,
          value: { ok: true, path: `.jarvis/uploads/${String(args[1]).slice(0, 2)}.jpg` },
        }),
      ),
    });
    const files = fakeFiles();
    const uploader = createAttachUploader({
      client,
      files,
      paneKey: "pane",
      errorText: (kind) => kind,
    });
    const tray = createAttachTray<AttachPick>({ ...uploader, maxFiles: 4 });
    tray.add(PHOTO("a.jpg"));
    tray.add(PHOTO("b.jpg"));
    await flush();
    expect(tray.items().map((item) => item.state)).toEqual(["uploading", "uploading"]);
    expect(tray.busy()).toBe(true);
    // One upload on the socket at a time: the second waits for the first.
    expect(client.upload).toHaveBeenCalledTimes(1);
    expect(client.upload).toHaveBeenLastCalledWith(
      FILE_UPLOAD_CHANNEL,
      [{ name: "a.jpg", contentType: "image/jpeg" }],
      "QQ==",
      expect.anything(),
    );
    expect(tray.items()[0]?.progress).toBe(0.5);
    uploads.shift()?.({ ok: true, value: staged(++id) });
    await flush();
    expect(client.upload).toHaveBeenCalledTimes(2);
    uploads.shift()?.({ ok: true, value: staged(++id) });
    await flush();
    expect(client.call).toHaveBeenCalledWith(ATTACH_UPLOAD_CHANNEL, ["pane", "1".repeat(32)], {
      whenNotOpen: "reject",
    });
    expect(tray.items().map((item) => item.state)).toEqual(["done", "done"]);
    expect(tray.busy()).toBe(false);
    expect(tray.paths()).toEqual([".jarvis/uploads/11.jpg", ".jarvis/uploads/22.jpg"]);
    expect(files.remove).toHaveBeenCalledTimes(2);
  });

  it("an over-limit pick is refused before it is read", async () => {
    const client = fakeClient();
    const files = fakeFiles();
    const uploader = createAttachUploader({
      client,
      files,
      paneKey: "pane",
      errorText: (kind) => `text:${kind}`,
    });
    const result = await uploader.upload({ ...PHOTO("big.jpg"), bytes: MAX_FILE_BYTES + 1 });
    expect(result).toEqual({ error: "text:overLimit" });
    expect(files.readBase64).not.toHaveBeenCalled();
    expect(client.upload).not.toHaveBeenCalled();
  });

  it("a malformed attach reply is an error, never a path", async () => {
    const client = fakeClient({
      call: vi.fn(async (): Promise<RpcResult> => ({ ok: true, value: { ok: true } })),
    });
    const uploader = createAttachUploader({
      client,
      files: fakeFiles(),
      paneKey: "pane",
      errorText: (kind) => `text:${kind}`,
    });
    await expect(uploader.attach("f1")).resolves.toEqual({ ok: false, error: "text:failed" });
  });

  it("dispose skips queued uploads", async () => {
    const client = fakeClient({ upload: vi.fn(() => new Promise<RpcResult>(() => {})) });
    const uploader = createAttachUploader({
      client,
      files: fakeFiles(),
      paneKey: "pane",
      errorText: (kind) => kind,
    });
    void uploader.upload(PHOTO("a.jpg"));
    const queued = uploader.upload(PHOTO("b.jpg"));
    await flush();
    uploader.dispose();
    await expect(queued).resolves.toEqual({ error: "cancelled" });
    expect(client.upload).toHaveBeenCalledTimes(1);
  });

  it("a chip removed while queued is never uploaded; while running, its chunks stop", async () => {
    let cancelledCheck: (() => boolean) | undefined;
    const client = fakeClient({
      upload: vi.fn((_channel, _args, _base64, options) => {
        cancelledCheck = options?.cancelled;
        return new Promise<RpcResult>(() => {});
      }),
    });
    const files = fakeFiles();
    const uploader = createAttachUploader({
      client,
      files,
      paneKey: "pane",
      errorText: (kind) => kind,
    });
    const tray = createAttachTray<AttachPick>({ ...uploader, maxFiles: 4 });
    tray.add(PHOTO("a.jpg"));
    tray.add(PHOTO("b.jpg"));
    await flush();
    const [first, second] = tray.items();
    tray.remove(second?.id ?? "");
    expect(cancelledCheck?.()).toBe(false);
    tray.remove(first?.id ?? "");
    expect(cancelledCheck?.()).toBe(true);
    expect(client.upload).toHaveBeenCalledTimes(1);
    expect(files.remove).toHaveBeenCalledWith("file:///cache/b.jpg");
  });

  it("attachPickOf maps an image pick's optional size to bytes", () => {
    expect(attachPickOf({ uri: "u", name: "n.png", contentType: "image/png", size: 5 })).toEqual({
      uri: "u",
      name: "n.png",
      contentType: "image/png",
      bytes: 5,
    });
    expect(attachPickOf({ uri: "u", name: "n.png", contentType: "image/png" }).bytes).toBe(0);
  });
});
