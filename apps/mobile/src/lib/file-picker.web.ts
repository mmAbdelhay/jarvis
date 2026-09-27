// The browser build's file picker (Task 13): a transient
// `<input type="file">` in place of `expo-document-picker`'s native
// module, fed through the same `buildFilePicker` validation (name, size >
// 0, content type fallback). The picked `File` is registered in
// `webBlobs`, so the upload controller reads it through the web
// `RecordingFiles` (native-recording-files.web.ts) by its `blob:` url —
// the same uri-keyed path native uses for a `file://` copy.
import { buildFilePicker, type ExpoDocumentPickerModule, type FilePicker } from "./document-picker";
import { webBlobs } from "./web-blob-registry";

export type { FilePicker, PickedFile } from "./document-picker";

function chooseFile(): Promise<File | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.style.display = "none";
    const finish = (file: File | undefined): void => {
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => finish(input.files?.[0] ?? undefined), { once: true });
    input.addEventListener("cancel", () => finish(undefined), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

const webDocumentPicker: ExpoDocumentPickerModule = {
  async getDocumentAsync() {
    const file = await chooseFile();
    // An empty or unnamed file is "no file" in buildFilePicker anyway —
    // refused here, before it is registered, so it never leaks a blob url.
    if (file === undefined || file.size <= 0 || file.name.length === 0) {
      return { canceled: true, assets: null };
    }
    return {
      canceled: false,
      assets: [
        {
          name: file.name,
          size: file.size,
          uri: webBlobs.add(file),
          mimeType: file.type,
        },
      ],
    };
  },
};

export const nativeFilePicker: FilePicker = buildFilePicker(() => webDocumentPicker);
