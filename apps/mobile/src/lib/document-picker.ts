// The `FilePicker` behaviour over any document-picker-shaped module (moved
// out of file-picker.ts for Task 13): file-picker.ts binds it to
// `expo-document-picker`, file-picker.web.ts to an `<input type=file>`.
// Platform-neutral on purpose — a `.web.ts` sibling cannot import
// `./file-picker` (on web that resolves to itself).

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
