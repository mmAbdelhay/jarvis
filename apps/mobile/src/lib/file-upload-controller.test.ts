import { FILE_UPLOAD_CHANNEL, MAX_FILE_BYTES } from "@jarvis/wire";
import { describe, expect, it, vi } from "vitest";
import { createFileUploadController } from "./file-upload-controller";
import type { UploadFiles } from "./file-upload-controller";
import type { FilePicker, PickedFile } from "./file-picker";
import type { ClientState, RpcClient, RpcError, RpcResult } from "./rpc-client";

function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value };
}

function err(error: RpcError): RpcResult {
  return { ok: false, error };
}

function fakeClient(overrides: Partial<RpcClient> = {}): RpcClient {
  const base: RpcClient = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    call: vi.fn(async (): Promise<RpcResult> => err({ kind: "offline" })),
    upload: vi.fn(async (): Promise<RpcResult> => err({ kind: "offline" })),
    subscribe: vi.fn((): RpcResult<void> => ok(undefined)),
    unsubscribe: vi.fn(),
    onPush: vi.fn(() => () => {}),
    onState: vi.fn(() => () => {}),
    state: vi.fn((): ClientState => "open"),
    capabilities: vi.fn(() => []),
    subscriptions: vi.fn(() => []),
    lastFrameAt: vi.fn(() => undefined),
    setAppActive: vi.fn(),
  };
  return { ...base, ...overrides };
}

function fakeFiles(overrides: Partial<UploadFiles> = {}): UploadFiles {
  return {
    readBase64: vi.fn(async () => "QQ=="),
    size: vi.fn(() => 2),
    remove: vi.fn(),
    ...overrides,
  };
}

function fakePicker(picked: PickedFile | undefined): FilePicker {
  return { pick: vi.fn(async () => picked) };
}

const PICKED: PickedFile = {
  uri: "file:///cache/picked.json",
  name: "collection.postman.json",
  contentType: "application/json",
  bytes: 2,
};

/** The exact base64 shape (length, padding) for `byteLength` decoded bytes
 *  — same arithmetic as rpc-client.test.ts's own helper. All-`A` content;
 *  only the shape matters for these tests. */
function base64ForByteLength(byteLength: number): string {
  const remainder = byteLength % 3;
  const padding = remainder === 0 ? 0 : remainder === 1 ? 2 : 1;
  const chars = Math.ceil(byteLength / 3) * 4;
  return "A".repeat(chars - padding) + "=".repeat(padding);
}

describe("createFileUploadController", () => {
  it("resolves cancelled and touches neither files nor the client when the user cancels the picker", async () => {
    const files = fakeFiles();
    const client = fakeClient();
    const controller = createFileUploadController({
      client,
      files,
      picker: fakePicker(undefined),
    });

    await expect(controller.pickAndUpload()).resolves.toEqual({ kind: "cancelled" });
    expect(files.readBase64).not.toHaveBeenCalled();
    expect(client.upload).not.toHaveBeenCalled();
  });

  it("resolves overLimit for a file over MAX_FILE_BYTES by the picker's own claimed size, before reading it", async () => {
    const files = fakeFiles();
    const client = fakeClient();
    const controller = createFileUploadController({
      client,
      files,
      picker: fakePicker({ ...PICKED, bytes: MAX_FILE_BYTES + 1 }),
    });

    await expect(controller.pickAndUpload()).resolves.toEqual({ kind: "overLimit" });
    expect(files.size).not.toHaveBeenCalled();
    expect(files.readBase64).not.toHaveBeenCalled();
    expect(client.upload).not.toHaveBeenCalled();
    expect(files.remove).toHaveBeenCalledWith(PICKED.uri);
  });

  it("resolves overLimit for a file over MAX_FILE_BYTES by files.size()'s authoritative re-check, before reading it", async () => {
    const files = fakeFiles({ size: vi.fn(() => MAX_FILE_BYTES + 1) });
    const client = fakeClient();
    const controller = createFileUploadController({ client, files, picker: fakePicker(PICKED) });

    await expect(controller.pickAndUpload()).resolves.toEqual({ kind: "overLimit" });
    expect(files.readBase64).not.toHaveBeenCalled();
    expect(client.upload).not.toHaveBeenCalled();
  });

  it("resolves overLimit when files.size() can't read the file (undefined) rather than guessing from the picker's claim", async () => {
    const files = fakeFiles({ size: vi.fn(() => undefined) });
    const client = fakeClient();
    const controller = createFileUploadController({ client, files, picker: fakePicker(PICKED) });

    await expect(controller.pickAndUpload()).resolves.toEqual({ kind: "overLimit" });
    expect(files.readBase64).not.toHaveBeenCalled();
  });

  it("uploads on the wire channel with {name, contentType} and resolves ok with the parsed UploadedFile, removing the local copy", async () => {
    const files = fakeFiles();
    const uploaded = {
      fileId: "a".repeat(32),
      name: PICKED.name,
      contentType: PICKED.contentType,
      bytes: PICKED.bytes,
      expiresAt: 1_000,
    };
    const client = fakeClient({ upload: vi.fn(async (): Promise<RpcResult> => ok(uploaded)) });
    const controller = createFileUploadController({ client, files, picker: fakePicker(PICKED) });

    await expect(controller.pickAndUpload()).resolves.toEqual({ kind: "ok", file: uploaded });
    expect(client.upload).toHaveBeenCalledWith(
      FILE_UPLOAD_CHANNEL,
      [{ name: PICKED.name, contentType: PICKED.contentType }],
      "QQ==",
      expect.objectContaining({ cancelled: expect.any(Function) }),
    );
    expect(files.remove).toHaveBeenCalledWith(PICKED.uri);
  });

  it("Tests (I6): discriminates offline/timeout/busy/refused outcomes, and still removes the local copy each time", async () => {
    const cases: Array<{ error: RpcError; expected: unknown }> = [
      { error: { kind: "offline" }, expected: { kind: "offline" } },
      { error: { kind: "timeout" }, expected: { kind: "failed" } },
      { error: { kind: "busy" }, expected: { kind: "busy" } },
      {
        error: {
          kind: "remote",
          code: "bad-request",
          text: "too large for this project",
          language: "en",
        },
        expected: { kind: "refused", text: "too large for this project", language: "en" },
      },
    ];
    for (const { error, expected } of cases) {
      const files = fakeFiles();
      const client = fakeClient({ upload: vi.fn(async (): Promise<RpcResult> => err(error)) });
      const controller = createFileUploadController({ client, files, picker: fakePicker(PICKED) });

      await expect(controller.pickAndUpload()).resolves.toEqual(expected);
      expect(files.remove).toHaveBeenCalledWith(PICKED.uri);
    }
  });

  it("resolves failed for a malformed upload reply rather than trusting it", async () => {
    const files = fakeFiles();
    const client = fakeClient({
      upload: vi.fn(async (): Promise<RpcResult> => ok({ oops: true })),
    });
    const controller = createFileUploadController({ client, files, picker: fakePicker(PICKED) });

    await expect(controller.pickAndUpload()).resolves.toEqual({ kind: "failed" });
  });

  it("a second file upload while the socket already refuses busy resolves busy cleanly (simultaneous voice/file upload)", async () => {
    const files = fakeFiles();
    const client = fakeClient({
      upload: vi.fn(async (): Promise<RpcResult> => err({ kind: "busy" })),
    });
    const controller = createFileUploadController({ client, files, picker: fakePicker(PICKED) });

    await expect(controller.pickAndUpload()).resolves.toEqual({ kind: "busy" });
  });

  it("Tests (I6): a second pickAndUpload() while the first is still in flight resolves busy immediately, without picking a second file or deleting the first's copy [bite-proof: drop the inProgress guard; the test hangs waiting for a distinct busy result]", async () => {
    const files = fakeFiles();
    let resolvePick: (value: PickedFile) => void = () => {};
    const picker: FilePicker = {
      pick: vi.fn(
        () =>
          new Promise<PickedFile>((resolve) => {
            resolvePick = resolve;
          }),
      ),
    };
    const client = fakeClient();
    const controller = createFileUploadController({ client, files, picker });

    const first = controller.pickAndUpload();
    const second = controller.pickAndUpload();

    await expect(second).resolves.toEqual({ kind: "busy" });
    expect(picker.pick).toHaveBeenCalledTimes(1); // the second call never opened a picker at all
    expect(files.remove).not.toHaveBeenCalled();

    resolvePick(PICKED);
    await first;
  });

  it("refuses offline before ever calling upload() when the socket isn't open, and still cleans up", async () => {
    const files = fakeFiles();
    const client = fakeClient({ state: vi.fn((): ClientState => "reconnecting") });
    const controller = createFileUploadController({ client, files, picker: fakePicker(PICKED) });

    await expect(controller.pickAndUpload()).resolves.toEqual({ kind: "offline" });
    expect(client.upload).not.toHaveBeenCalled();
    expect(files.remove).toHaveBeenCalledWith(PICKED.uri);
  });

  it("cancel() during the base64 read stops the upload before it ever reaches the client, and cleans up", async () => {
    const files = fakeFiles();
    let resolveRead: (value: string) => void = () => {};
    const readStarted = new Promise<void>((resolveStarted) => {
      files.readBase64 = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveStarted();
            resolveRead = resolve;
          }),
      );
    });
    const client = fakeClient();
    const controller = createFileUploadController({ client, files, picker: fakePicker(PICKED) });

    const pending = controller.pickAndUpload();
    // Let the async flow reach (and call) files.readBase64 before
    // cancelling mid-read — otherwise cancel() would race pick() itself
    // rather than exercise the read in progress.
    await readStarted;
    controller.cancel();
    resolveRead("QQ==");

    await expect(pending).resolves.toEqual({ kind: "cancelled" });
    expect(client.upload).not.toHaveBeenCalled();
    expect(files.remove).toHaveBeenCalledWith(PICKED.uri);
  });

  it("passes a cancelled() predicate that reflects cancel() called after upload() has started", async () => {
    const files = fakeFiles();
    let capturedCancelled: (() => boolean) | undefined;
    const client = fakeClient({
      upload: vi.fn(async (_ch, _args, _b64, options): Promise<RpcResult> => {
        capturedCancelled = (options as { cancelled?: () => boolean }).cancelled;
        return err({ kind: "cancelled" });
      }),
    });
    const controller = createFileUploadController({ client, files, picker: fakePicker(PICKED) });

    const pending = controller.pickAndUpload();
    await pending;
    expect(capturedCancelled).toBeDefined();
    expect(capturedCancelled?.()).toBe(false);

    controller.cancel();
    expect(capturedCancelled?.()).toBe(true);
  });

  it("Tests (I10): pickAndUpload's own onProgress argument is threaded straight through to client.upload()'s option of the same name", async () => {
    const files = fakeFiles();
    let capturedOnProgress: ((sent: number, total: number) => void) | undefined;
    const client = fakeClient({
      upload: vi.fn(async (_ch, _args, _b64, options): Promise<RpcResult> => {
        capturedOnProgress = (options as { onProgress?: (sent: number, total: number) => void })
          .onProgress;
        return err({ kind: "offline" });
      }),
    });
    const controller = createFileUploadController({ client, files, picker: fakePicker(PICKED) });
    const seen: Array<[number, number]> = [];

    await controller.pickAndUpload((sent, total) => seen.push([sent, total]));
    expect(capturedOnProgress).toBeDefined();
    capturedOnProgress?.(1, 2);
    expect(seen).toEqual([[1, 2]]);
  });

  it("dispose() prevents any further pick from starting, even on a later call", async () => {
    const files = fakeFiles();
    const picker = fakePicker(PICKED);
    const client = fakeClient();
    const controller = createFileUploadController({ client, files, picker });

    controller.dispose();
    await expect(controller.pickAndUpload()).resolves.toEqual({ kind: "cancelled" });
    expect(picker.pick).not.toHaveBeenCalled();
  });

  it(
    "Tests (I8, reworded fix round 2): a real >=25 MiB base64 payload — exactly one bounded read, and the exact " +
      "content that read produced reaches upload() once, unmodified",
    async () => {
      // A genuine 25 MiB (MAX_FILE_BYTES) decoded payload: ~34.95M base64
      // characters, built once.
      const bigBase64 = base64ForByteLength(MAX_FILE_BYTES);
      expect(bigBase64.length).toBeGreaterThan(34_000_000);

      const files = fakeFiles({
        size: vi.fn(() => MAX_FILE_BYTES),
        readBase64: vi.fn(async () => bigBase64),
      });
      let capturedBase64: string | undefined;
      const client = fakeClient({
        upload: vi.fn(async (_ch, _args, base64): Promise<RpcResult> => {
          capturedBase64 = base64;
          return err({ kind: "offline" });
        }),
      });
      const controller = createFileUploadController({
        client,
        files,
        picker: fakePicker({ ...PICKED, bytes: MAX_FILE_BYTES }),
      });

      await expect(controller.pickAndUpload()).resolves.toEqual({ kind: "offline" });
      expect(files.readBase64).toHaveBeenCalledTimes(1);
      expect(client.upload).toHaveBeenCalledTimes(1);
      // Fix round 2: reworded — JS strings are primitives, so `toBe` and
      // `toEqual` compare the same way here (by value) and this assertion
      // cannot distinguish "the exact same in-memory string" from "a
      // separately built string with identical content"; no unit test can
      // observe that distinction for a primitive. What this genuinely
      // proves: `readBase64()` is called exactly once, `upload()` is
      // called exactly once, and the ~34.95M-character value handed to
      // `upload()` is byte-for-byte the value `readBase64()` produced —
      // the controller never truncates, re-encodes or otherwise mutates
      // it in between, and never routes a second, independently-read copy
      // through a different path.
      expect(capturedBase64).toBe(bigBase64);
    },
  );
});
