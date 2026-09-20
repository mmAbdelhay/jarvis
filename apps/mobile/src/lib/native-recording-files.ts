// A thin wrapper over `expo-file-system`'s `File` — behaviour rule 7 in
// task-6-brief.md. Names used from the installed `expo-file-system@57.0.7`:
//   `new File(uri)` (File.d.ts constructor, accepts a `file:///` string).
//   `File#base64(): Promise<string>` and `File#size: number` (both
//     inherited from `NativeFileSystemFile`, internal/NativeFileSystem.types.d.ts —
//     `size` is "0 if the file does not exist, or it cannot be read").
//   `File#delete(): void` (same base class).
//
// `nativeRecordingFiles` itself is not exercised by any test here (native
// only — global constraint): `expo-file-system` is loaded lazily with
// `require` inside each function, as `native-transport.ts` does, so a
// static `import` never reaches Vitest. `buildRecordingFiles` below is
// exported separately and IS unit-tested (native-recording-files.test.ts,
// M8 final fix wave M1): it takes an `ExpoFileSystemModule` loader as a
// plain argument instead of calling `require` itself, so a test can hand
// it a fake `File` whose constructor/`size` getter throws — the same
// shape `native-speaker.ts`'s `buildSpeaker` and
// `native-voice-recorder.tsx`'s `buildVoiceRecorder` use.
import type { RecordingFiles } from "./recording-files";

// Declared locally, not imported from `@types/node` — see
// native-transport.ts's identical declaration and its comment.
declare function require(id: string): unknown;

type FileInstance = {
  base64(): Promise<string>;
  size: number;
  delete(): void;
};

type FileConstructor = new (uri: string) => FileInstance;

export type ExpoFileSystemModule = { File: FileConstructor };

function loadExpoFileSystem(): ExpoFileSystemModule {
  return require("expo-file-system") as ExpoFileSystemModule;
}

function isFileUri(uri: string): boolean {
  return uri.startsWith("file://");
}

/** Builds the `RecordingFiles` behaviour over an already-obtained
 * `ExpoFileSystemModule` loader — see the file header for why this is
 * separate from `nativeRecordingFiles`. */
export function buildRecordingFiles(loadFileSystem: () => ExpoFileSystemModule): RecordingFiles {
  return {
    readBase64(uri: string): Promise<string> {
      if (!isFileUri(uri)) {
        return Promise.reject(new Error("nativeRecordingFiles.readBase64: not a file:// uri"));
      }
      const { File } = loadFileSystem();
      return new File(uri).base64();
    },

    size(uri: string): number | undefined {
      if (!isFileUri(uri)) return undefined;
      // M1: both `new File(uri)` and the `size` getter can throw (an
      // unreadable/removed file) rather than returning 0. `size` already
      // contracts `undefined` as "unusable" (the `RecordingFiles` doc
      // comment), and `voice-controller.ts`'s `send()` maps that to the
      // existing `tooLarge` failure path — a throw here must not strand
      // the caller mid-`stop()` with no result at all.
      try {
        const { File } = loadFileSystem();
        const value = new File(uri).size;
        return Number.isFinite(value) ? value : undefined;
      } catch {
        return undefined;
      }
    },

    remove(uri: string): void {
      if (!isFileUri(uri)) return;
      try {
        const { File } = loadFileSystem();
        new File(uri).delete();
      } catch {
        // `remove` never throws.
      }
    },
  };
}

export const nativeRecordingFiles: RecordingFiles = buildRecordingFiles(loadExpoFileSystem);
