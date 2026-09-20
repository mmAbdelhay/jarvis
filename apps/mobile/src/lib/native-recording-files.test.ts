// Tests `buildRecordingFiles` — the pure-loader builder extracted from
// `nativeRecordingFiles` (M8 final fix wave, M1) so the `size()` throw-
// guard has regression coverage without a simulator. It takes an
// `ExpoFileSystemModule` loader, no `require` of `expo-file-system`.
import { describe, expect, test, vi } from "vitest";
import { type ExpoFileSystemModule, buildRecordingFiles } from "./native-recording-files";

const URI = "file:///rec-1.m4a";

function fileSystemWith(overrides: {
  onConstruct?: () => void;
  size?: number | (() => number);
  base64?: () => Promise<string>;
  onDelete?: () => void;
}): ExpoFileSystemModule {
  class FakeFile {
    delete = vi.fn(() => overrides.onDelete?.());
    constructor() {
      overrides.onConstruct?.();
    }
    get size(): number {
      const s = overrides.size ?? 2_048;
      return typeof s === "function" ? s() : s;
    }
    base64(): Promise<string> {
      return (overrides.base64 ?? (() => Promise.resolve("QQ==")))();
    }
  }
  return { File: FakeFile as unknown as ExpoFileSystemModule["File"] };
}

describe("buildRecordingFiles: size()", () => {
  test("returns the file's size for a file:// uri", () => {
    const files = buildRecordingFiles(() => fileSystemWith({ size: 1_234 }));
    expect(files.size(URI)).toBe(1_234);
  });

  test("returns undefined for a non-file:// uri", () => {
    const files = buildRecordingFiles(() => fileSystemWith({}));
    expect(files.size("https://example.com/x")).toBeUndefined();
  });

  test("returns undefined when the size getter is not finite", () => {
    const files = buildRecordingFiles(() => fileSystemWith({ size: Number.NaN }));
    expect(files.size(URI)).toBeUndefined();
  });

  // M1: `new File(uri)` and the `size` getter can throw (an unreadable or
  // already-removed file) instead of returning 0. Before the fix this
  // propagated out of `size()`, rejecting `stop()` (an unhandled rejection
  // via the screen's `void controller.toggle()`) and stranding the phase
  // at `recording` with the file kept and the recorder already stopped.
  // [bite-proof: remove the try/catch around the size getter — see below]
  test("returns undefined instead of throwing when the size getter throws", () => {
    const files = buildRecordingFiles(() =>
      fileSystemWith({
        size: () => {
          throw new Error("file removed");
        },
      }),
    );
    expect(() => files.size(URI)).not.toThrow();
    expect(files.size(URI)).toBeUndefined();
  });

  // The other throw site the guard also has to cover: the `File`
  // constructor itself (not just its `size` getter) can throw for an
  // unreadable uri.
  test("returns undefined instead of throwing when the File constructor throws", () => {
    const files = buildRecordingFiles(() =>
      fileSystemWith({
        onConstruct: () => {
          throw new Error("cannot stat file");
        },
      }),
    );
    expect(() => files.size(URI)).not.toThrow();
    expect(files.size(URI)).toBeUndefined();
  });
});

describe("buildRecordingFiles: readBase64() and remove()", () => {
  test("readBase64 rejects for a non-file:// uri without touching the module", () => {
    const files = buildRecordingFiles(() => fileSystemWith({}));
    return expect(files.readBase64("https://example.com/x")).rejects.toThrow();
  });

  test("readBase64 resolves the file's base64 content", async () => {
    const files = buildRecordingFiles(() =>
      fileSystemWith({ base64: () => Promise.resolve("YWJj") }),
    );
    await expect(files.readBase64(URI)).resolves.toBe("YWJj");
  });

  test("remove() never throws even when File.delete() throws", () => {
    const files = buildRecordingFiles(() =>
      fileSystemWith({
        onDelete: () => {
          throw new Error("already gone");
        },
      }),
    );
    expect(() => files.remove(URI)).not.toThrow();
  });
});
