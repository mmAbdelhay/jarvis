import { describe, expect, it } from "vitest";
import type { ExpoDocumentPickerModule } from "./file-picker";
import { buildFilePicker } from "./file-picker";

function fakeModule(getDocumentAsync: ExpoDocumentPickerModule["getDocumentAsync"]) {
  return { getDocumentAsync };
}

describe("buildFilePicker", () => {
  it("returns a PickedFile built field by field from a successful pick", async () => {
    const picker = buildFilePicker(() =>
      fakeModule(async () => ({
        canceled: false,
        assets: [
          {
            name: "report.pdf",
            size: 4096,
            uri: "file:///cache/report.pdf",
            mimeType: "application/pdf",
          },
        ],
      })),
    );
    await expect(picker.pick()).resolves.toEqual({
      uri: "file:///cache/report.pdf",
      name: "report.pdf",
      contentType: "application/pdf",
      bytes: 4096,
    });
  });

  it("falls back to application/octet-stream when mimeType is missing", async () => {
    const picker = buildFilePicker(() =>
      fakeModule(async () => ({
        canceled: false,
        assets: [{ name: "data.bin", size: 10, uri: "file:///cache/data.bin" }],
      })),
    );
    await expect(picker.pick()).resolves.toEqual({
      uri: "file:///cache/data.bin",
      name: "data.bin",
      contentType: "application/octet-stream",
      bytes: 10,
    });
  });

  it("resolves undefined when the user cancels", async () => {
    const picker = buildFilePicker(() =>
      fakeModule(async () => ({ canceled: true, assets: null })),
    );
    await expect(picker.pick()).resolves.toBeUndefined();
  });

  it("resolves undefined for a missing/zero/non-finite size rather than guessing", async () => {
    for (const size of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const picker = buildFilePicker(() =>
        fakeModule(async () => ({
          canceled: false,
          assets: [{ name: "x", size, uri: "file:///cache/x" }],
        })),
      );
      await expect(picker.pick()).resolves.toBeUndefined();
    }
  });

  it("resolves undefined for an empty/missing uri or name", async () => {
    const noUri = buildFilePicker(() =>
      fakeModule(async () => ({
        canceled: false,
        assets: [{ name: "x", size: 1, uri: "" }],
      })),
    );
    await expect(noUri.pick()).resolves.toBeUndefined();

    const noName = buildFilePicker(() =>
      fakeModule(async () => ({
        canceled: false,
        assets: [{ name: "", size: 1, uri: "file:///cache/x" }],
      })),
    );
    await expect(noName.pick()).resolves.toBeUndefined();
  });

  it("resolves undefined when assets is empty despite canceled: false", async () => {
    const picker = buildFilePicker(() => fakeModule(async () => ({ canceled: false, assets: [] })));
    await expect(picker.pick()).resolves.toBeUndefined();
  });

  it("resolves undefined, never throws, when the native module itself throws", async () => {
    const picker = buildFilePicker(() =>
      fakeModule(async () => {
        throw new Error("native module missing");
      }),
    );
    await expect(picker.pick()).resolves.toBeUndefined();
  });
});
