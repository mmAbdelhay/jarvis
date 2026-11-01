// Task 9: the attach tray's upload and attach steps for a Claude pane. A
// picked photo or file is staged on the laptop through the existing
// file-upload-controller (its size check runs before any read, and its
// paced chunks report progress), then copied into the pane's project with
// terminal:attachUpload. The socket takes one upload at a time, so picks
// queue here and go one after another. File contents are never logged.
import { ATTACH_UPLOAD_CHANNEL, type AttachUploadResult } from "@jarvis/wire";
import {
  createFileUploadController,
  type FileUploadController,
  type FileUploadResult,
  type UploadFiles,
} from "./file-upload-controller";
import type { PickedFile as ImagePick } from "./image-pick";
import type { RpcClient } from "./rpc-client";

/** One staged-to-be pick, from the photo picker or the document picker. */
export type AttachPick = { uri: string; name: string; contentType: string; bytes: number };

/** Why a pick did not reach the laptop; the screen turns it into text. */
export type AttachErrorKind = Exclude<FileUploadResult["kind"], "ok" | "refused"> | "attach";

export type AttachUploader = {
  /** Named `send`, not `upload`: only voice-controller.ts calls
   *  RpcClient.upload from a screen (voice-screen.test.ts scans for it). */
  send(
    pick: AttachPick,
    onProgress?: (fraction: number) => void,
    onCancel?: (cancel: () => void) => void,
  ): Promise<{ fileId: string } | { error: string }>;
  attach(fileId: string): Promise<AttachUploadResult>;
  /** The screen is gone: stops the current upload and drops queued ones. */
  dispose(): void;
  /** True once disposed: a screen whose effect ran twice (StrictMode)
   *  builds a fresh one instead of reusing this. */
  isDisposed(): boolean;
};

/** An image pick's optional size as the controller's byte count. A
 *  missing size is 0 here; the controller's own `files.size` re-check
 *  still refuses an over-limit file before reading it. */
export function attachPickOf(pick: ImagePick): AttachPick {
  return { uri: pick.uri, name: pick.name, contentType: pick.contentType, bytes: pick.size ?? 0 };
}

export function createAttachUploader(deps: {
  client: RpcClient;
  files: UploadFiles;
  paneKey: string;
  errorText(kind: AttachErrorKind): string;
}): AttachUploader {
  type Job = {
    pick: AttachPick;
    onProgress: ((fraction: number) => void) | undefined;
    resolve(result: { fileId: string } | { error: string }): void;
    /** Set while it runs: stops its upload at the next chunk. */
    stop?: () => void;
  };
  const queue: Job[] = [];
  let running = false;
  let disposed = false;
  let current: FileUploadController | undefined;

  function pump(): void {
    if (running) return;
    const job = queue.shift();
    if (job === undefined) return;
    running = true;
    void runOne(job)
      .catch(() => ({ error: deps.errorText("failed") }))
      .then((result) => {
        job.resolve(result);
        running = false;
        pump();
      });
  }

  async function runOne(job: Job): Promise<{ fileId: string } | { error: string }> {
    const { pick, onProgress } = job;
    const controller = createFileUploadController({
      client: deps.client,
      files: deps.files,
      picker: { pick: async () => pick },
    });
    current = controller;
    job.stop = () => controller.cancel();
    try {
      const result = await controller.pickAndUpload((sent, total) => {
        if (total > 0) onProgress?.(sent / total);
      });
      if (result.kind === "ok") return { fileId: result.file.fileId };
      // The laptop's own refusal is shown as it wrote it.
      if (result.kind === "refused") return { error: result.text };
      return { error: deps.errorText(result.kind) };
    } finally {
      current = undefined;
    }
  }

  return {
    send(pick, onProgress, onCancel) {
      if (disposed) return Promise.resolve({ error: deps.errorText("cancelled") });
      return new Promise((resolve) => {
        const job: Job = { pick, onProgress, resolve };
        // A queued pick that is dropped never starts; its local copy goes.
        onCancel?.(() => {
          if (job.stop !== undefined) {
            job.stop();
            return;
          }
          const index = queue.indexOf(job);
          if (index === -1) return;
          queue.splice(index, 1);
          deps.files.remove(pick.uri);
          resolve({ error: deps.errorText("cancelled") });
        });
        queue.push(job);
        pump();
      });
    },
    async attach(fileId) {
      const result = await deps.client.call(ATTACH_UPLOAD_CHANNEL, [deps.paneKey, fileId], {
        whenNotOpen: "reject",
      });
      if (!result.ok) {
        return {
          ok: false,
          error:
            result.error.kind === "remote"
              ? result.error.text
              : deps.errorText(result.error.kind === "offline" ? "offline" : "failed"),
        };
      }
      const value = result.value as Partial<{ ok: unknown; path: unknown; error: unknown }> | null;
      if (value?.ok === true && typeof value.path === "string" && value.path !== "") {
        return { ok: true, path: value.path };
      }
      if (value?.ok === false && typeof value.error === "string") {
        return { ok: false, error: value.error };
      }
      return { ok: false, error: deps.errorText("failed") };
    },
    isDisposed: () => disposed,
    dispose() {
      disposed = true;
      current?.dispose();
      for (const job of queue.splice(0)) {
        deps.files.remove(job.pick.uri);
        job.resolve({ error: deps.errorText("cancelled") });
      }
    },
  };
}
