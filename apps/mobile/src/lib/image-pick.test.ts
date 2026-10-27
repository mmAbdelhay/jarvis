// Photo picker contracts: native permissions, mapping, cancellation and browser selection.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as picker from "expo-image-picker";
import { pickImages } from "./image-pick";
import { pickImages as pickWebImages } from "./image-pick.web";

vi.mock("expo-image-picker", () => ({
  requestMediaLibraryPermissionsAsync: vi.fn(),
  requestCameraPermissionsAsync: vi.fn(),
  launchImageLibraryAsync: vi.fn(),
  launchCameraAsync: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(picker.requestMediaLibraryPermissionsAsync).mockResolvedValue({
    granted: true,
  } as never);
  vi.mocked(picker.requestCameraPermissionsAsync).mockResolvedValue({ granted: true } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function assets(items: object[]) {
  return { canceled: false, assets: items } as picker.ImagePickerResult;
}

describe("pickImages", () => {
  it("library pick maps assets to name, type and size", async () => {
    vi.mocked(picker.launchImageLibraryAsync).mockResolvedValue(
      assets([{ uri: "file:///one", fileName: "one.png", mimeType: "image/png", fileSize: 42 }]),
    );
    await expect(pickImages("library", 2)).resolves.toEqual([
      { uri: "file:///one", name: "one.png", contentType: "image/png", size: 42 },
    ]);
    expect(picker.launchImageLibraryAsync).toHaveBeenCalledWith({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      selectionLimit: 2,
      quality: 0.85,
    });
    expect(picker.requestMediaLibraryPermissionsAsync).toHaveBeenCalledOnce();
    expect(
      vi.mocked(picker.requestMediaLibraryPermissionsAsync).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(picker.launchImageLibraryAsync).mock.invocationCallOrder[0]);
  });
  it("missing fileName and mimeType fall back to photo-N.jpg and image/jpeg", async () => {
    vi.mocked(picker.launchImageLibraryAsync).mockResolvedValue(
      assets([{ uri: "a" }, { uri: "b", fileName: null, mimeType: null }]),
    );
    const result = await pickImages("library", 2);
    expect(result).toEqual([
      { uri: "a", name: "photo-1.jpg", contentType: "image/jpeg" },
      { uri: "b", name: "photo-2.jpg", contentType: "image/jpeg" },
    ]);
    expect(result[0]).not.toHaveProperty("size");
  });
  it('denied permission returns "denied" without opening the picker', async () => {
    vi.mocked(picker.requestMediaLibraryPermissionsAsync).mockResolvedValue({
      granted: false,
    } as never);
    vi.mocked(picker.requestCameraPermissionsAsync).mockResolvedValue({ granted: false } as never);
    await expect(pickImages("library", 1)).resolves.toBe("denied");
    await expect(pickImages("camera", 1)).resolves.toBe("denied");
    expect(picker.launchImageLibraryAsync).not.toHaveBeenCalled();
    expect(picker.launchCameraAsync).not.toHaveBeenCalled();
  });
  it('cancelled picker returns "cancelled"', async () => {
    vi.mocked(picker.launchImageLibraryAsync).mockResolvedValue({ canceled: true, assets: null });
    await expect(pickImages("library", 1)).resolves.toBe("cancelled");
  });
  it("caps results at maxCount", async () => {
    vi.mocked(picker.launchImageLibraryAsync).mockResolvedValue(
      assets([{ uri: "a" }, { uri: "b" }]),
    );
    await expect(pickImages("library", 1)).resolves.toEqual([
      { uri: "a", name: "photo-1.jpg", contentType: "image/jpeg" },
    ]);
    expect(picker.launchImageLibraryAsync).toHaveBeenCalledWith({
      mediaTypes: ["images"],
      allowsMultipleSelection: false,
      selectionLimit: 1,
      quality: 0.85,
    });
  });
  it('maxCount 0 returns "cancelled" without opening', async () => {
    for (const source of ["library", "camera"] as const) {
      await expect(pickImages(source, 0)).resolves.toBe("cancelled");
      await expect(pickImages(source, -1)).resolves.toBe("cancelled");
    }
    expect(picker.requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
    expect(picker.requestCameraPermissionsAsync).not.toHaveBeenCalled();
    expect(picker.launchImageLibraryAsync).not.toHaveBeenCalled();
    expect(picker.launchCameraAsync).not.toHaveBeenCalled();
  });
  it("camera uses launchCameraAsync", async () => {
    vi.mocked(picker.launchCameraAsync).mockResolvedValue(assets([{ uri: "camera" }]));
    await expect(pickImages("camera", 1)).resolves.toEqual([
      { uri: "camera", name: "photo-1.jpg", contentType: "image/jpeg" },
    ]);
    expect(picker.requestCameraPermissionsAsync).toHaveBeenCalledOnce();
    expect(picker.launchCameraAsync).toHaveBeenCalledWith({
      mediaTypes: ["images"],
      quality: 0.85,
    });
    expect(picker.launchImageLibraryAsync).not.toHaveBeenCalled();
  });
  it('picker throwing returns "cancelled"', async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(picker.launchImageLibraryAsync).mockRejectedValue(new Error("private-uri/name"));
    await expect(pickImages("library", 1)).resolves.toBe("cancelled");
    vi.mocked(picker.requestCameraPermissionsAsync).mockRejectedValue(new Error("private"));
    await expect(pickImages("camera", 1)).resolves.toBe("cancelled");
    expect(log.mock.calls).toEqual([["[image-pick] failed"], ["[image-pick] failed"]]);
  });
});

function browserInput(files: object[], event = "change") {
  const handlers: Record<string, () => void> = {};
  const input = {
    type: "",
    accept: "",
    multiple: false,
    style: { display: "" },
    files,
    addEventListener: vi.fn((name: string, handler: () => void) => {
      handlers[name] = handler;
    }),
    remove: vi.fn(),
    click: vi.fn(() => handlers[event]()),
  };
  const createElement = vi.fn(() => input);
  vi.stubGlobal("document", { createElement, body: { appendChild: vi.fn() } });
  const createObjectURL = vi.fn(() => "blob:photo");
  vi.stubGlobal("URL", { createObjectURL });
  return { input, createElement, createObjectURL };
}

describe("web pickImages", () => {
  it.each(["library", "camera"] as const)(
    "maps and caps %s selection using hidden image input",
    async (source) => {
      const { input, createElement, createObjectURL } = browserInput([
        { name: "one.png", type: "", size: 12 },
        { name: "two.png", type: "image/png", size: 20 },
      ]);
      await expect(pickWebImages(source, 1)).resolves.toEqual([
        { uri: "blob:photo", name: "one.png", contentType: "image/jpeg", size: 12 },
      ]);
      expect(createElement).toHaveBeenCalledWith("input");
      expect(input).toMatchObject({
        type: "file",
        accept: "image/*",
        multiple: false,
        style: { display: "none" },
      });
      expect(createObjectURL).toHaveBeenCalledOnce();
      expect(input.remove).toHaveBeenCalledOnce();
    },
  );
  it("allows multiple files and preserves their MIME type", async () => {
    const { input } = browserInput([{ name: "one.png", type: "image/png", size: 12 }]);
    await expect(pickWebImages("library", 2)).resolves.toEqual([
      { uri: "blob:photo", name: "one.png", contentType: "image/png", size: 12 },
    ]);
    expect(input.multiple).toBe(true);
  });
  it.each(["change", "cancel"])("returns cancelled for empty %s", async (event) => {
    const { input } = browserInput([], event);
    await expect(pickWebImages("library", 1)).resolves.toBe("cancelled");
    expect(input.remove).toHaveBeenCalledOnce();
  });
  it("does not open for zero maxCount", async () => {
    const { createElement } = browserInput([]);
    await expect(pickWebImages("camera", 0)).resolves.toBe("cancelled");
    expect(createElement).not.toHaveBeenCalled();
  });
  it("catches browser selection errors without logging private data", async () => {
    const { input } = browserInput([]);
    input.click.mockImplementation(() => {
      throw new Error("private");
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(pickWebImages("library", 1)).resolves.toBe("cancelled");
    expect(log.mock.calls).toEqual([["[image-pick] failed"]]);
    expect(input.remove).toHaveBeenCalledOnce();
  });
});
