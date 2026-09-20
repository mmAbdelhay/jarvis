// The blob channels the desktop accepts from a paired phone: `remote:
// uploadAudio` (M8 Task 4) and `remote:uploadFile` (M9 Task 3). Deliberately
// separate from dispatch.ts's DispatchTable: a blob handler's signature
// differs from a request Handler's (it takes bytes and never an `Origin`
// shaped by the renderer's own desktop path — only a remote one, since a
// blob can only ever arrive over the bridge), and this table is never
// reachable from CHANNEL_POLICY, INVOKE_CHANNELS or RendererApi (global
// constraints) — it is wired into the bridge's own `blobLimit`/handling path
// in remote-access.ts, nowhere else.
import {
  FILE_UPLOAD_CHANNEL,
  MAX_FILE_BYTES,
  MAX_VOICE_BYTES,
  VOICE_UPLOAD_CHANNEL,
} from "@jarvis/wire";
import type { Origin } from "./dispatch.js";

export type RemoteOrigin = Extract<Origin, { kind: "remote" }>;

export type BlobHandler = (
  args: readonly unknown[],
  bytes: Uint8Array,
  origin: RemoteOrigin,
) => Promise<unknown>;

export type BlobTable = Readonly<Record<string, { maxBytes: number; handler: BlobHandler }>>;

export function createBlobTable(deps: {
  uploadAudio: BlobHandler;
  uploadFile: BlobHandler;
}): BlobTable {
  return {
    [VOICE_UPLOAD_CHANNEL]: { maxBytes: MAX_VOICE_BYTES, handler: deps.uploadAudio },
    [FILE_UPLOAD_CHANNEL]: { maxBytes: MAX_FILE_BYTES, handler: deps.uploadFile },
  };
}

/** `Object.hasOwn`, so a channel named "constructor" or "__proto__" can
 *  never read a value off Object.prototype instead of a real table entry. */
export function blobLimitOf(table: BlobTable, channel: string): number | undefined {
  return Object.hasOwn(table, channel) ? table[channel]?.maxBytes : undefined;
}
