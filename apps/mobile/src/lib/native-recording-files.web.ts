// The browser build's `RecordingFiles` (Task 13): recordings and picked
// files are in-memory blobs registered in `webBlobs` (web-blob-registry.ts)
// rather than files on disk. Same contract as the native adapter: an
// unknown uri reads as a rejection, sizes as `undefined`, and `remove`
// never throws.
import type { RecordingFiles } from "./recording-files";
import { readRegisteredBase64, webBlobs } from "./web-blob-registry";

export const nativeRecordingFiles: RecordingFiles = {
  readBase64: readRegisteredBase64,
  size: (uri) => webBlobs.size(uri),
  remove: (uri) => webBlobs.remove(uri),
};
