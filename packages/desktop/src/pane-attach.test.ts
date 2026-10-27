import { describe, expect, it, vi } from "vitest";
import { attachFileName, createPaneAttach } from "./pane-attach.js";
import { MESSAGES } from "./messages.js";

const fileId = "a".repeat(32);
const now = new Date(2026, 0, 2, 3, 4, 5).getTime();

function harness() {
  const deps = {
    uploads: {
      resolve: vi.fn(
        async (): Promise<
          { bytes: Uint8Array; name: string; contentType: string } | undefined
        > => ({
          bytes: new Uint8Array([1, 2]),
          name: "phone.jpg",
          contentType: "image/jpeg",
        }),
      ),
      release: vi.fn(async () => undefined),
    },
    cwdFor: vi.fn(async (): Promise<string | undefined> => "/project"),
    fs: {
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
      realpath: vi.fn(async (path: string) => path),
      lstat: vi.fn(async () => ({ isSymbolicLink: (): boolean => false })),
    },
    now: () => now,
    randomHex: vi.fn(() => "abcdef"),
    log: vi.fn(),
  };
  return {
    deps,
    attach: (...args: Parameters<ReturnType<typeof createPaneAttach>["attach"]>) =>
      createPaneAttach(deps).attach(...args),
  };
}

describe("attachFileName", () => {
  it.each([
    ["image/jpeg", "x.jpeg", "jpg"],
    ["unknown", "x.PDF", "pdf"],
    ["unknown", "../../etc", "bin"],
    ["unknown", "x.pdf\0.exe", "bin"],
    ["image/png", "x\0.pdf", "png"],
  ])("%s + %s → .%s", (type, name, extension) => {
    expect(attachFileName(now, "abcdef", type, name)).toBe(`20260102-030405-abcdef.${extension}`);
  });
});

describe("attach", () => {
  it("writes into .jarvis/uploads, returns relative path, releases staged copy", async () => {
    const { deps, attach } = harness();
    deps.uploads.release.mockImplementation(async () => {
      expect(deps.fs.writeFile).toHaveBeenCalledWith(
        "/project/.jarvis/uploads/20260102-030405-abcdef.jpg",
        new Uint8Array([1, 2]),
        { flag: "wx", mode: 0o600 },
      );
    });
    expect(await attach("device", "pane", fileId)).toEqual({
      ok: true,
      path: ".jarvis/uploads/20260102-030405-abcdef.jpg",
    });
    expect(deps.fs.mkdir).toHaveBeenCalledWith("/project/.jarvis/uploads", {
      recursive: true,
      mode: 0o700,
    });
    expect(deps.fs.writeFile).toHaveBeenCalledWith("/project/.jarvis/uploads/.gitignore", "*\n", {
      flag: "wx",
      mode: 0o600,
    });
    expect(deps.uploads.release).toHaveBeenCalledWith("device", fileId);
    expect(deps.randomHex).toHaveBeenCalledWith(3);
  });

  it("symlinked uploads dir → error, nothing written", async () => {
    const { deps, attach } = harness();
    deps.fs.lstat.mockResolvedValue({ isSymbolicLink: () => true });
    expect((await attach("device", "pane", fileId)).ok).toBe(false);
    expect(deps.fs.writeFile).not.toHaveBeenCalled();
    expect(deps.uploads.release).not.toHaveBeenCalled();
  });

  it("redirected parent → error, nothing written", async () => {
    const { deps, attach } = harness();
    deps.fs.realpath.mockImplementation(async (path) =>
      path === "/project" ? path : "/elsewhere/uploads",
    );
    expect((await attach("device", "pane", fileId)).ok).toBe(false);
    expect(deps.fs.writeFile).not.toHaveBeenCalled();
  });

  it("unknown fileId → generic error, no release", async () => {
    const { deps, attach } = harness();
    deps.uploads.resolve.mockResolvedValue(undefined);
    expect(await attach("device", "pane", fileId)).toEqual({
      ok: false,
      error: MESSAGES.fileUploadNotFound("en"),
    });
    expect(deps.uploads.release).not.toHaveBeenCalled();
  });

  it("no cwd → generic error", async () => {
    const { deps, attach } = harness();
    deps.cwdFor.mockResolvedValue(undefined);
    expect(await attach("device", "pane", fileId)).toEqual({
      ok: false,
      error: MESSAGES.fileUploadFailed("en"),
    });
    expect(deps.fs.writeFile).not.toHaveBeenCalled();
  });

  it("keeps an existing gitignore and never releases after a failed file write", async () => {
    const { deps, attach } = harness();
    deps.fs.writeFile
      .mockRejectedValueOnce({ code: "EEXIST" })
      .mockRejectedValueOnce(new Error("private path"));
    expect((await attach("device", "pane", fileId)).ok).toBe(false);
    expect(deps.uploads.release).not.toHaveBeenCalled();
    expect(JSON.stringify(deps.log.mock.calls)).not.toContain("private path");
  });

  it.each([
    [null, fileId],
    ["pane", {}],
    ["", fileId],
  ])("rejects malformed arguments", async (pane, id) => {
    const { deps, attach } = harness();
    expect((await attach("device", pane, id)).ok).toBe(false);
    expect(deps.uploads.resolve).not.toHaveBeenCalled();
    expect(deps.fs.writeFile).not.toHaveBeenCalled();
  });
});
