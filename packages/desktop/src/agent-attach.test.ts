import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type AgentAttachDeps, createAgentAttach } from "./agent-attach.js";

const BASE = join("/", "data", "agent-attach");
const DAY = 24 * 60 * 60 * 1000;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const PDF = Buffer.from("%PDF-1.4 hello");

function setup(options: { base?: string; agent?: boolean } = {}) {
  const written = new Map<string, { bytes: Buffer; mode: number }>();
  const dirs = new Map<string, number>();
  const removed: string[] = [];
  const old = new Map<string, number>();
  const deps: AgentAttachDeps = {
    baseDir: options.base ?? BASE,
    sessions: {
      live: vi.fn((paneKey: unknown) => paneKey === "t1"),
      session: vi.fn(async () =>
        options.agent === false
          ? undefined
          : { paneKey: "t1", pid: 1, vendor: "anthropic" as const, sessionId: "s", cwd: "/r" },
      ),
    },
    fs: {
      mkdir: vi.fn(async (path: string, mode: number) => void dirs.set(path, mode)),
      writeFile: vi.fn(async (path: string, bytes: Buffer, mode: number) => {
        if (written.has(path)) throw new Error("EEXIST");
        written.set(path, { bytes, mode });
      }),
      list: vi.fn(async (path: string) =>
        path === BASE
          ? [{ name: "pane1", isDirectory: true, mtimeMs: 0 }]
          : [
              { name: "old.png", isDirectory: false, mtimeMs: old.get("old.png") ?? 0 },
              { name: "new.png", isDirectory: false, mtimeMs: 1_000 * DAY },
            ],
      ),
      remove: vi.fn(async (path: string) => void removed.push(path)),
    },
    now: () => 1_000 * DAY,
    random: () => "abc123",
    log: vi.fn(),
  };
  return { attach: createAgentAttach(deps), deps, written, dirs, removed };
}

describe("agentAttach", () => {
  it("writes a private file with a generated name and answers its path as a reference", async () => {
    const t = setup();
    const out = await t.attach.attach("t1", { name: "../../shot.PNG", bytes: PNG });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.path.startsWith(BASE)).toBe(true);
    expect(out.path).toMatch(/[\\/]\d{8}-\d{6}-abc123\.png$/);
    expect(out.path).not.toContain("shot");
    expect(out.kind).toBe("image");
    expect(out.ref).toBe(out.path);
    const [file] = [...t.written];
    expect(file?.[1].mode).toBe(0o600);
    expect([...t.dirs.values()].every((mode) => mode === 0o700)).toBe(true);
    for (const dir of t.dirs.keys()) expect(dir.startsWith(BASE)).toBe(true);
  });

  it("quotes a path with spaces, and a PDF is a file", async () => {
    const t = setup({ base: join("/", "data", "App Support", "agent-attach") });
    const out = await t.attach.attach("t1", { name: "doc.pdf", bytes: PDF });
    expect(out.ok && out.kind).toBe("file");
    if (out.ok) expect(out.ref).toBe(`"${out.path}"`);
    const image = await t.attach.attach("t1", { name: "a.png", bytes: PNG });
    if (image.ok) expect(image.ref).toBe(`"${image.path}"`);
  });

  it("accepts text without NUL bytes, and refuses anything else", async () => {
    const t = setup();
    expect((await t.attach.attach("t1", { name: "notes.md", bytes: Buffer.from("# hi") })).ok).toBe(
      true,
    );
    expect(await t.attach.attach("t1", { name: "x.txt", bytes: Buffer.from([65, 0, 66]) })).toEqual(
      { ok: false, reason: "invalid" },
    );
    expect(await t.attach.attach("t1", { name: "x.png", bytes: Buffer.from("not a png") })).toEqual(
      { ok: false, reason: "invalid" },
    );
    expect(await t.attach.attach("t1", { name: "run.sh", bytes: Buffer.from("echo") })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await t.attach.attach("t1", { name: "noext", bytes: Buffer.from("x") })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await t.attach.attach("t1", { name: "a\0.png", bytes: PNG })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await t.attach.attach("t1", { name: "e.txt", bytes: Buffer.alloc(0) })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await t.attach.attach("t1", "nope")).toEqual({ ok: false, reason: "invalid" });
    expect(await t.attach.attach("t1", { name: 5, bytes: PNG })).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("refuses more than 25 MB", async () => {
    const t = setup();
    const big = Buffer.alloc(25 * 1024 * 1024 + 1, 65);
    expect(await t.attach.attach("t1", { name: "big.txt", bytes: big })).toEqual({
      ok: false,
      reason: "toolarge",
    });
    expect(t.written.size).toBe(0);
  });

  it("refuses a pane that is gone or has no agent, and a failing write", async () => {
    expect(await setup().attach.attach("zz", { name: "a.png", bytes: PNG })).toEqual({
      ok: false,
      reason: "gone",
    });
    expect(
      await setup({ agent: false }).attach.attach("t1", { name: "a.png", bytes: PNG }),
    ).toEqual({ ok: false, reason: "gone" });
    const t = setup();
    vi.mocked(t.deps.fs.writeFile).mockRejectedValue(new Error("ENOSPC /secret"));
    expect(await t.attach.attach("t1", { name: "a.png", bytes: PNG })).toEqual({
      ok: false,
      reason: "failed",
    });
    for (const call of vi.mocked(t.deps.log).mock.calls)
      expect(String(call[0])).not.toContain("secret");
  });

  it("prunes files older than 7 days inside its own directory only", async () => {
    const t = setup();
    await t.attach.attach("t1", { name: "a.png", bytes: PNG });
    expect(t.removed).toEqual([join(BASE, "pane1", "old.png")]);
  });
});
