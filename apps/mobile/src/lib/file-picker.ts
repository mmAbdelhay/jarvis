// The native document picker boundary (M9 Task 5, Interfaces): `pick()` is
// the *only* place apps/mobile ever asks the OS for an arbitrary file. Every
// other file-shaped value in this app (a recording, an already-staged
// upload) has its own narrower path.
//
// Same split as native-recording-files.ts / native-voice-recorder.tsx:
// `buildFilePicker` takes an injected module loader and is exercised by
// file-picker.test.ts with a fake `expo-document-picker`; `nativeFilePicker`
// is the concrete singleton, loaded lazily with `require` so a static
// `import` of `expo-document-picker` never reaches Vitest (native only —
// global constraint, no Expo/simulator run here either).
//
// `expo-document-picker@57.0.2` (the SDK-57 line) is the version this is
// written against — see its `src/types.ts`: `getDocumentAsync` resolves
// `{ canceled: true; assets: null }` or `{ canceled: false; assets:
// DocumentPickerAsset[] }`, where an asset's `size`/`mimeType` are each
// optional. Every field below is read defensively; a picked file this
// module cannot describe with a real name, uri and positive byte count is
// treated as "no file" (undefined), the same outcome as the user cancelling
// — never handed to the upload controller as a guess.

declare function require(id: string): unknown;

export type PickedFile = { uri: string; name: string; contentType: string; bytes: number };

export type FilePicker = { pick(): Promise<PickedFile | undefined> };

type DocumentPickerAsset = {
  name: string;
  size?: number;
  uri: string;
  mimeType?: string;
};

type DocumentPickerResult =
  | { canceled: true; assets: null }
  | { canceled: false; assets: DocumentPickerAsset[] };

export type ExpoDocumentPickerModule = {
  getDocumentAsync(options?: {
    multiple?: boolean;
    copyToCacheDirectory?: boolean;
  }): Promise<DocumentPickerResult>;
};

function loadExpoDocumentPicker(): ExpoDocumentPickerModule {
  return require("expo-document-picker") as ExpoDocumentPickerModule;
}

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

function isPositiveFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Builds the `FilePicker` behaviour over an already-obtained
 *  `ExpoDocumentPickerModule` loader — see the file header for why this is
 *  separate from `nativeFilePicker`. */
export function buildFilePicker(loadPicker: () => ExpoDocumentPickerModule): FilePicker {
  return {
    async pick(): Promise<PickedFile | undefined> {
      let result: DocumentPickerResult;
      try {
        const picker = loadPicker();
        result = await picker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true });
      } catch {
        // A throw from the native module (unavailable, OS-level refusal) is
        // "no file", the same as the user cancelling — never surfaced as a
        // crash.
        return undefined;
      }
      if (result.canceled) return undefined;
      const asset = result.assets[0];
      if (asset === undefined) return undefined;
      if (typeof asset.uri !== "string" || asset.uri.length === 0) return undefined;
      if (typeof asset.name !== "string" || asset.name.length === 0) return undefined;
      if (!isPositiveFiniteInteger(asset.size)) return undefined;
      const contentType =
        typeof asset.mimeType === "string" && asset.mimeType.length > 0
          ? asset.mimeType
          : DEFAULT_CONTENT_TYPE;
      return { uri: asset.uri, name: asset.name, contentType, bytes: asset.size };
    },
  };
}

export const nativeFilePicker: FilePicker = buildFilePicker(loadExpoDocumentPicker);
