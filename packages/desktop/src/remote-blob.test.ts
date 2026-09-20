import {
  FILE_UPLOAD_CHANNEL,
  MAX_FILE_BYTES,
  MAX_VOICE_BYTES,
  VOICE_UPLOAD_CHANNEL,
} from "@jarvis/wire";
import { describe, expect, it, vi } from "vitest";
import { CHANNEL_POLICY } from "./remote-policy.js";
import { INVOKE_CHANNELS } from "./channels.js";
import { blobLimitOf, createBlobTable, type BlobHandler } from "./remote-blob.js";

function table(overrides: Partial<{ uploadAudio: BlobHandler; uploadFile: BlobHandler }> = {}) {
  return createBlobTable({
    uploadAudio: vi.fn(async () => undefined),
    uploadFile: vi.fn(async () => undefined),
    ...overrides,
  });
}

describe("createBlobTable", () => {
  it("has exactly two keys, remote:uploadAudio and remote:uploadFile, with their own maxBytes", () => {
    const uploadAudio: BlobHandler = vi.fn(async () => undefined);
    const uploadFile: BlobHandler = vi.fn(async () => undefined);
    const t = createBlobTable({ uploadAudio, uploadFile });

    expect(Object.keys(t).sort()).toEqual([FILE_UPLOAD_CHANNEL, VOICE_UPLOAD_CHANNEL].sort());
    expect(t[VOICE_UPLOAD_CHANNEL]?.maxBytes).toBe(4_194_304);
    expect(t[VOICE_UPLOAD_CHANNEL]?.maxBytes).toBe(MAX_VOICE_BYTES);
    expect(t[VOICE_UPLOAD_CHANNEL]?.handler).toBe(uploadAudio);
    expect(t[FILE_UPLOAD_CHANNEL]?.maxBytes).toBe(26_214_400);
    expect(t[FILE_UPLOAD_CHANNEL]?.maxBytes).toBe(MAX_FILE_BYTES);
    expect(t[FILE_UPLOAD_CHANNEL]?.handler).toBe(uploadFile);
  });

  it("no blob-table key equals any CHANNEL_POLICY key or any INVOKE_CHANNELS value", () => {
    const t = table();
    const policyKeys = new Set<string>(Object.keys(CHANNEL_POLICY));
    const invokeValues = new Set<string>(Object.values(INVOKE_CHANNELS));

    for (const key of Object.keys(t)) {
      expect(policyKeys.has(key)).toBe(false);
      expect(invokeValues.has(key)).toBe(false);
    }
  });
});

describe("blobLimitOf", () => {
  it("returns each channel's own maxBytes", () => {
    const t = table();
    expect(blobLimitOf(t, VOICE_UPLOAD_CHANNEL)).toBe(4_194_304);
    expect(blobLimitOf(t, FILE_UPLOAD_CHANNEL)).toBe(26_214_400);
  });

  it("returns undefined for __proto__, constructor and session:input", () => {
    const t = table();
    expect(blobLimitOf(t, "__proto__")).toBeUndefined();
    expect(blobLimitOf(t, "constructor")).toBeUndefined();
    expect(blobLimitOf(t, "session:input")).toBeUndefined();
  });
});
