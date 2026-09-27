// The browser build's stand-in for a `file://` uri (Task 13): a recording
// (MediaRecorder) or a picked file (<input type=file>) is a `Blob` held in
// memory, handed around the app as a `blob:` object URL so the existing
// uri-keyed `RecordingFiles` contract (read/size/remove) still fits.
//
// Only a url this registry itself minted is ever resolved — a forged or
// stale `blob:` string answers `undefined`, the same as a non-`file://`
// uri does on native. `create`/`revoke` are injected so this is tested
// without a DOM; `webBlobs` below binds them to the real `URL` statics.

export type BlobRegistry<B extends { size: number }> = {
  add(blob: B): string;
  get(uri: string): B | undefined;
  size(uri: string): number | undefined;
  /** Revokes the url and forgets the blob. Never throws. */
  remove(uri: string): void;
};

export function createBlobRegistry<B extends { size: number }>(urls: {
  create(blob: B): string;
  revoke(url: string): void;
}): BlobRegistry<B> {
  const blobs = new Map<string, B>();
  return {
    add(blob) {
      const uri = urls.create(blob);
      blobs.set(uri, blob);
      return uri;
    },
    get(uri) {
      return blobs.get(uri);
    },
    size(uri) {
      return blobs.get(uri)?.size;
    },
    remove(uri) {
      if (!blobs.delete(uri)) return;
      try {
        urls.revoke(uri);
      } catch {
        // `remove` never throws.
      }
    },
  };
}

/** `data:<type>;base64,<payload>` → `<payload>`; anything else is
 * `undefined` (FileReader#readAsDataURL always produces the base64 form). */
export function dataUrlToBase64(dataUrl: string): string | undefined {
  if (!dataUrl.startsWith("data:")) return undefined;
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return undefined;
  if (!dataUrl.slice(0, comma).endsWith(";base64")) return undefined;
  return dataUrl.slice(comma + 1);
}

/** The app-wide registry — only ever called in the browser build. */
export const webBlobs: BlobRegistry<Blob> = createBlobRegistry<Blob>({
  create: (blob) => URL.createObjectURL(blob),
  revoke: (url) => URL.revokeObjectURL(url),
});

/** Reads a registered blob as base64 via FileReader. Rejects for a uri the
 * registry never minted. */
export function readRegisteredBase64(uri: string): Promise<string> {
  const blob = webBlobs.get(uri);
  if (blob === undefined) {
    return Promise.reject(new Error("webBlobs: unknown uri"));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("webBlobs: read failed"));
    reader.onload = () => {
      const base64 = typeof reader.result === "string" ? dataUrlToBase64(reader.result) : undefined;
      if (base64 === undefined) {
        reject(new Error("webBlobs: unexpected read result"));
        return;
      }
      resolve(base64);
    };
    reader.readAsDataURL(blob);
  });
}
