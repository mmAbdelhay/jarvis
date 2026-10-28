import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachFileName, createPaneAttach, createPaneAttachCwd } from "./pane-attach.js";
import { MESSAGES } from "./messages.js";

const enoent = (): Error => Object.assign(new Error("missing"), { code: "ENOENT" });

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
      lstat: vi.fn(async (_path: string) => ({ isSymbolicLink: (): boolean => false })),
      chmod: vi.fn(async () => undefined),
      rm: vi.fn(async () => undefined),
    },
    language: "en" as "ar" | "en",
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
        join("/project", ".jarvis", "uploads", "20260102-030405-abcdef.jpg"),
        new Uint8Array([1, 2]),
        { flag: "wx", mode: 0o600 },
      );
    });
    expect(await attach("device", "pane", fileId)).toEqual({
      ok: true,
      path: ".jarvis/uploads/20260102-030405-abcdef.jpg",
    });
    expect(deps.fs.mkdir).toHaveBeenCalledWith(join("/project", ".jarvis", "uploads"), {
      recursive: true,
      mode: 0o700,
    });
    expect(deps.fs.writeFile).toHaveBeenCalledWith(
      join("/project", ".jarvis", "uploads", ".gitignore"),
      "*\n",
      {
        flag: "wx",
        mode: 0o600,
      },
    );
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

  it("answers its generic errors in the app's language", async () => {
    const { deps } = harness();
    deps.cwdFor.mockResolvedValue(undefined);
    const attach = createPaneAttach({ ...deps, language: "ar" });
    expect(await attach.attach("device", "pane", fileId)).toEqual({
      ok: false,
      error: MESSAGES.fileUploadFailed("ar"),
    });
    deps.uploads.resolve.mockResolvedValue(undefined);
    expect(await attach.attach("device", "pane", fileId)).toEqual({
      ok: false,
      error: MESSAGES.fileUploadNotFound("ar"),
    });
  });

  it.each([[join("/project", ".jarvis")], [join("/project", ".jarvis", "uploads")]])(
    "symlink at %s → refused before any mkdir",
    async (link) => {
      const { deps, attach } = harness();
      deps.fs.lstat.mockImplementation(async (path: string) => ({
        isSymbolicLink: () => path === link,
      }));
      expect((await attach("device", "pane", fileId)).ok).toBe(false);
      expect(deps.fs.mkdir).not.toHaveBeenCalled();
      expect(deps.fs.writeFile).not.toHaveBeenCalled();
      expect(deps.log).toHaveBeenCalledWith("pane-attach: directory");
    },
  );

  it("missing .jarvis → no lstat of uploads, mkdir goes ahead", async () => {
    const { deps, attach } = harness();
    deps.fs.lstat.mockRejectedValueOnce(enoent());
    expect((await attach("device", "pane", fileId)).ok).toBe(true);
    const mkdirAt = deps.fs.mkdir.mock.invocationCallOrder[0] ?? 0;
    const beforeMkdir = deps.fs.lstat.mock.calls.filter(
      (_, i) => (deps.fs.lstat.mock.invocationCallOrder[i] ?? 0) < mkdirAt,
    );
    expect(beforeMkdir).toEqual([[join("/project", ".jarvis")]]);
  });

  it("chmods the uploads dir to 0700 after the realpath check", async () => {
    const { deps, attach } = harness();
    expect((await attach("device", "pane", fileId)).ok).toBe(true);
    expect(deps.fs.chmod).toHaveBeenCalledWith(join("/project", ".jarvis", "uploads"), 0o700);
    expect(deps.fs.chmod.mock.invocationCallOrder[0]).toBeGreaterThan(
      deps.fs.realpath.mock.invocationCallOrder.at(-1) ?? Number.POSITIVE_INFINITY,
    );
  });

  it("never chmods a directory that failed the realpath check", async () => {
    const { deps, attach } = harness();
    deps.fs.realpath.mockImplementation(async (path) =>
      path === "/project" ? path : "/elsewhere/uploads",
    );
    expect((await attach("device", "pane", fileId)).ok).toBe(false);
    expect(deps.fs.chmod).not.toHaveBeenCalled();
  });

  it("removes the half-written file after a failed write, keeping the staged copy", async () => {
    const { deps, attach } = harness();
    deps.fs.writeFile
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
    expect((await attach("device", "pane", fileId)).ok).toBe(false);
    expect(deps.fs.rm).toHaveBeenCalledWith(
      join("/project", ".jarvis", "uploads", "20260102-030405-abcdef.jpg"),
      {
        force: true,
      },
    );
    expect(deps.uploads.release).not.toHaveBeenCalled();
  });

  it("leaves a file it did not create alone (EEXIST)", async () => {
    const { deps, attach } = harness();
    deps.fs.writeFile
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error("exists"), { code: "EEXIST" }));
    expect((await attach("device", "pane", fileId)).ok).toBe(false);
    expect(deps.fs.rm).not.toHaveBeenCalled();
  });

  it("a failing rm still answers the generic error", async () => {
    const { deps, attach } = harness();
    deps.fs.writeFile
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
    deps.fs.rm.mockRejectedValue(new Error("private path"));
    expect(await attach("device", "pane", fileId)).toEqual({
      ok: false,
      error: MESSAGES.fileUploadFailed("en"),
    });
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

describe("attach on a real filesystem", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  async function realAttach(cwd: string) {
    const uploads = {
      resolve: vi.fn(async () => ({
        bytes: new Uint8Array([1, 2, 3]),
        name: "phone.png",
        contentType: "image/png",
      })),
      release: vi.fn(async () => undefined),
    };
    const attach = createPaneAttach({
      uploads,
      cwdFor: async () => cwd,
      fs: { mkdir, writeFile, realpath, lstat, chmod, rm },
      language: "en",
      now: () => now,
      randomHex: () => "abcdef",
      log: () => undefined,
    });
    return { uploads, result: await attach.attach("device", "pane", fileId) };
  }

  it("refuses a symlinked .jarvis and creates nothing outside the project", async () => {
    const root = await mkdtemp(join(tmpdir(), "pane-attach-"));
    roots.push(root);
    const project = join(root, "project");
    const outside = join(root, "outside");
    await mkdir(project);
    await mkdir(outside);
    await symlink(outside, join(project, ".jarvis"));

    const { uploads, result } = await realAttach(project);
    expect(result.ok).toBe(false);
    expect(await readdir(outside)).toEqual([]);
    expect(uploads.release).not.toHaveBeenCalled();
  });

  it("keeps an existing .gitignore and writes the file into a 0700 uploads dir", async () => {
    const root = await mkdtemp(join(tmpdir(), "pane-attach-"));
    roots.push(root);
    const directory = join(root, ".jarvis", "uploads");
    await mkdir(directory, { recursive: true, mode: 0o755 });
    await writeFile(join(directory, ".gitignore"), "kept\n");

    const { uploads, result } = await realAttach(root);
    expect(result).toEqual({ ok: true, path: ".jarvis/uploads/20260102-030405-abcdef.png" });
    expect(await readFile(join(directory, ".gitignore"), "utf8")).toBe("kept\n");
    expect([...(await readFile(join(directory, "20260102-030405-abcdef.png")))]).toEqual([1, 2, 3]);
    if (process.platform !== "win32") expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect(uploads.release).toHaveBeenCalledWith("device", fileId);
  });
});

describe("createPaneAttachCwd", () => {
  function cwdHarness() {
    return {
      panes: vi.fn(() => [{ paneKey: "t1", exited: false }]),
      scanAgents: vi.fn(async () => [
        {
          pid: 42,
          agentId: "claude",
          command: "claude",
          cwd: "/claude/cwd",
          startedAt: 0,
          terminalPaneKey: "t1",
          foreground: true,
        },
      ]),
      agents: vi.fn(() => [{ id: "claude", vendor: "anthropic" as const }]),
      paneStartDir: vi.fn((_paneKey: string): string | undefined => "/pane/start"),
    };
  }

  it("is the Claude process's cwd in a live pane, else the pane's start dir", async () => {
    const deps = cwdHarness();
    expect(await createPaneAttachCwd(deps)("t1")).toBe("/claude/cwd");
    deps.scanAgents.mockRejectedValue(new Error("scan"));
    expect(await createPaneAttachCwd(deps)("t1")).toBe("/pane/start");
  });

  it.each([
    ["an exited pane", [{ paneKey: "t1", exited: true }]],
    ["an unknown pane", [{ paneKey: "other", exited: false }]],
  ])("is undefined for %s, without scanning", async (_, panes) => {
    const deps = cwdHarness();
    deps.panes.mockReturnValue(panes);
    expect(await createPaneAttachCwd(deps)("t1")).toBeUndefined();
    expect(deps.scanAgents).not.toHaveBeenCalled();
    expect(deps.paneStartDir).not.toHaveBeenCalled();
  });

  it("an exited pane makes attach answer the generic error", async () => {
    const deps = cwdHarness();
    deps.panes.mockReturnValue([{ paneKey: "t1", exited: true }]);
    const { deps: attachDeps } = harness();
    const attach = createPaneAttach({ ...attachDeps, cwdFor: createPaneAttachCwd(deps) });
    expect(await attach.attach("device", "t1", fileId)).toEqual({
      ok: false,
      error: MESSAGES.fileUploadFailed("en"),
    });
    expect(attachDeps.fs.mkdir).not.toHaveBeenCalled();
  });

  it("is undefined when the pane list throws", async () => {
    const deps = cwdHarness();
    deps.panes.mockImplementation(() => {
      throw new Error("panes");
    });
    expect(await createPaneAttachCwd(deps)("t1")).toBeUndefined();
  });
});
