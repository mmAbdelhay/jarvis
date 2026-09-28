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

import { buildFilePicker, type ExpoDocumentPickerModule, type FilePicker } from "./document-picker";

export { buildFilePicker } from "./document-picker";
export type { ExpoDocumentPickerModule, FilePicker, PickedFile } from "./document-picker";

declare function require(id: string): unknown;

function loadExpoDocumentPicker(): ExpoDocumentPickerModule {
  return require("expo-document-picker") as ExpoDocumentPickerModule;
}

export const nativeFilePicker: FilePicker = buildFilePicker(loadExpoDocumentPicker);
