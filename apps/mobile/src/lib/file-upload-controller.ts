// The generic "pick a file, stage it on the laptop" client (M9 Task 5,
// Interfaces): used both for a multipart request attachment (the result's
// `fileId` becomes a `{ uploadId }` multipart field value — never a path,
// api-store.ts's own ApiAction never carries anything else) and for the
// Postman import flow (pick a JSON export, upload it, then
// `remote:readJsonUpload` + `api:importPostman` elsewhere).
//
// `files` is the same shape as native-recording-files.ts's `RecordingFiles`
// (read/size/remove over a `file://` uri) — the native singleton it already
// exports satisfies this structurally, so no new native code is needed to
// wire this up (M8 already wrote the one seam this file needs).
//
// Behaviour rule 4 (task-5-brief.md): size is checked against the wire's
// own `MAX_FILE_BYTES` *before* `readBase64` ever allocates a base64 copy
// of the file — an over-limit pick never reaches native file I/O or the
// socket. Cancellation (this controller's own `cancel()`, or `dispose()` on
// unmount) is checked at every await boundary and handed to `RpcClient`'s
// `cancelled()` predicate so an in-flight paced upload stops sending
// further chunks; either way the app-local picker copy is removed.
//
// Fix round 1 (I6): `pickAndUpload()` used to collapse every non-success
// outcome to a bare `undefined` — a screen could not tell "you cancelled"
// from "that file is too big" from "the laptop refused it: <verbatim
// text>". It now resolves a discriminated `FileUploadResult`, and a second
// call while one is already in flight is refused `{ kind: "busy" }` before
// it ever touches the picker or the shared `currentUri`/`stopped` state —
// previously a second tap here could pick a *second* file into the same
// mutable `currentUri` and have the first call's own cleanup() delete it
// out from under the second call's still-pending upload.
import { FILE_UPLOAD_CHANNEL, MAX_FILE_BYTES, parseUploadedFile } from "@jarvis/wire";
import type { UploadedFile } from "@jarvis/wire";
import type { Language } from "./i18n";
import type { FilePicker } from "./file-picker";
import type { RpcClient } from "./rpc-client";

export type UploadFiles = {
  readBase64(uri: string): Promise<string>;
  size(uri: string): number | undefined;
  remove(uri: string): void;
};

export type FileUploadResult =
  | { kind: "ok"; file: UploadedFile }
  /** The user backed out of the native picker, or `cancel()`/`dispose()`
   *  was called before the upload finished. */
  | { kind: "cancelled" }
  /** The picked file (by its own claimed size, or the native module's
   *  authoritative re-check) is over `MAX_FILE_BYTES` — never read. */
  | { kind: "overLimit" }
  /** A pick/upload was already in progress on this controller, or the
   *  socket already had another upload in flight (including the voice
   *  lane) when this one reached the wire. */
  | { kind: "busy" }
  /** Not connected when the upload would have been sent. */
  | { kind: "offline" }
  /** The laptop explicitly refused the upload — `text`/`language` are its
   *  own message, shown verbatim (global-constraints.md rule 7), never
   *  routed through the i18n table. */
  | { kind: "refused"; text: string; language: Language }
  /** Anything else: a read that threw, a timeout, or a reply that didn't
   *  parse as an `UploadedFile`. */
  | { kind: "failed" };

export type FileUploadController = {
  /** Fix round 1 (I10): `onProgress`, when given, is threaded straight
   *  through to `RpcClient.upload()`'s own — called after each chunk is
   *  handed to the transport, cumulative decoded bytes sent and the total.
   *  Never called before the first chunk (a pick, a size check or the
   *  base64 read give no useful "progress" of their own). */
  pickAndUpload(onProgress?: (sent: number, total: number) => void): Promise<FileUploadResult>;
  /** Stops the current pick/upload, if any: no `remote:uploadFile` call is
   *  made if one hasn't started yet, and no further chunk is sent if one
   *  is already paced mid-transfer. Always cleans up the app-local picker
   *  copy. A no-op if nothing is in flight. */
  cancel(): void;
  /** Same effect as `cancel()`, for the owning screen's unmount — no
   *  further state is touched, and `pickAndUpload()`'s promise (if still
   *  pending) settles to `{ kind: "cancelled" }` rather than being left
   *  dangling. */
  dispose(): void;
};

export type FileUploadControllerDeps = {
  client: RpcClient;
  files: UploadFiles;
  picker: FilePicker;
};

export function createFileUploadController(deps: FileUploadControllerDeps): FileUploadController {
  const { client, files, picker } = deps;
  // `stopped` drives both cancel() and dispose(): once either fires, every
  // later await-boundary check below treats the current attempt (if any)
  // as over, and RpcClient's own `cancelled()` predicate stops a
  // mid-transfer upload from sending its remaining chunks. `disposed` is
  // dispose()'s own, permanent half — unlike cancel(), a disposed
  // controller (its owning screen has unmounted) never starts another
  // pick, even if something still holds a reference and calls
  // pickAndUpload() again. `inProgress` is this fix round's own re-entrancy
  // guard — see the file header.
  let stopped = false;
  let disposed = false;
  let inProgress = false;
  let currentUri: string | undefined;

  function cleanup(): void {
    if (currentUri !== undefined) {
      files.remove(currentUri);
      currentUri = undefined;
    }
  }

  async function pickAndUpload(
    onProgress?: (sent: number, total: number) => void,
  ): Promise<FileUploadResult> {
    if (disposed) return { kind: "cancelled" };
    if (inProgress) return { kind: "busy" };
    inProgress = true;
    try {
      return await runPickAndUpload(onProgress);
    } finally {
      inProgress = false;
    }
  }

  async function runPickAndUpload(
    onProgress: ((sent: number, total: number) => void) | undefined,
  ): Promise<FileUploadResult> {
    // A fresh attempt un-latches a stop left by a previous cancelled
    // attempt — cancel() only ever applies to the attempt in progress when
    // it was called, not to a later one.
    stopped = false;

    const picked = await picker.pick();
    if (picked === undefined) {
      cleanup();
      return { kind: "cancelled" };
    }
    // Set before the `stopped` check below: the native picker already
    // copied this file into the app's cache the moment it resolved
    // (`copyToCacheDirectory: true`), so a cancel that lands in the same
    // tick still has a real local copy to clean up.
    currentUri = picked.uri;
    if (stopped) {
      cleanup();
      return { kind: "cancelled" };
    }

    // Behaviour rule 4: checked before a single byte is read — an
    // over-limit file is refused without ever allocating its base64 copy.
    // The picker's own claimed `bytes` is a first, cheap filter; `files.
    // size(uri)` is the authoritative re-check against the file that will
    // actually be read.
    if (picked.bytes > MAX_FILE_BYTES) {
      cleanup();
      return { kind: "overLimit" };
    }
    const actualSize = files.size(picked.uri);
    if (actualSize === undefined || actualSize > MAX_FILE_BYTES) {
      cleanup();
      return { kind: "overLimit" };
    }

    let base64: string;
    try {
      base64 = await files.readBase64(picked.uri);
    } catch {
      cleanup();
      return { kind: "failed" };
    }
    if (stopped) {
      cleanup();
      return { kind: "cancelled" };
    }

    // Re-checked "just before upload", the same discipline voice-
    // controller.ts's send() uses: a cancel during the (possibly slow)
    // base64 read must still stop the request from ever reaching the
    // socket, not just the chunks after it.
    if (client.state() !== "open") {
      cleanup();
      return { kind: "offline" };
    }

    const result = await client.upload(
      FILE_UPLOAD_CHANNEL,
      [{ name: picked.name, contentType: picked.contentType }],
      base64,
      { cancelled: () => stopped, onProgress },
    );
    // `base64` goes out of scope here — this function never keeps a second
    // reference to it (e.g. a copy sliced off for retry), so at most one
    // ~25 MiB decoded-then-re-encoded string is live per upload attempt,
    // never several.
    cleanup();
    if (!result.ok) {
      switch (result.error.kind) {
        case "cancelled":
          return { kind: "cancelled" };
        case "busy":
          return { kind: "busy" };
        case "offline":
          return { kind: "offline" };
        case "remote":
          return { kind: "refused", text: result.error.text, language: result.error.language };
        case "timeout":
        case "unsupported":
          return { kind: "failed" };
      }
    }
    const file = parseUploadedFile(result.value);
    return file === undefined ? { kind: "failed" } : { kind: "ok", file };
  }

  function cancel(): void {
    stopped = true;
  }

  function dispose(): void {
    stopped = true;
    disposed = true;
  }

  return { pickAndUpload, cancel, dispose };
}
