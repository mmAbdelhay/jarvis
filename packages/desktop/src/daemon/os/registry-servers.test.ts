import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { McpSession, McpTool, RegistryEntry } from "@jarvis/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindToIndex,
  BUNDLED_NODE,
  capSession,
  createRegistryServers,
  expandDeclaredPath,
  maskedHomeEntries,
  nodeVerifyUnpacked,
  parseRegistration,
  parseTimerRequest,
  PROBE_SCRIPT,
  sandboxProbe,
  resolveRuntimeDir,
  sandboxArgv,
  tarListing,
  type TimerRequest,
  timerArgv,
  withClockTimer,
} from "./registry-servers.js";

const HOME = "/home/ali";
const RUN = "/run/user/1000";
const SANDBOX_PROBE = sandboxProbe(HOME, RUN);
const dir = (id: string, version: string) => `${HOME}/.local/share/jarvis/mcp/${id}/${version}`;
const files = {
  id: "jarvis-files",
  version: "1.0.0",
  tier: "official",
  command: [`${dir("jarvis-files", "1.0.0")}/server`],
  permissions: { network: false, paths: [] },
};
const entryFor = (over: Partial<RegistryEntry> = {}): RegistryEntry => ({
  id: "jarvis-files",
  name: "Files",
  description: "",
  tier: "official",
  version: "1.0.0",
  artifact: { url: "https://x/f.tar.gz", sha256: "a".repeat(64), runtime: "go-static" },
  permissions: { network: false, paths: [] },
  tools: [{ name: "files.search", risk: "safe" }],
  ...over,
});

describe("parseRegistration (contracts §3, §7)", () => {
  const parse = (raw: unknown, fileId = "jarvis-files") =>
    parseRegistration(raw, { home: HOME, fileId });

  it("accepts the three runtimes' exact entry points, with ~ expanded", () => {
    expect(parse(files)).toMatchObject({ ok: true, value: { runtime: "go-static" } });
    expect(
      parse(
        {
          ...files,
          id: "notes",
          tier: "reviewed",
          command: [BUNDLED_NODE, "~/.local/share/jarvis/mcp/notes/2.0/server.js"],
          version: "2.0",
        },
        "notes",
      ),
    ).toMatchObject({
      ok: true,
      value: { runtime: "node", command: [BUNDLED_NODE, `${dir("notes", "2.0")}/server.js`] },
    });
    expect(
      parse(
        {
          ...files,
          id: "py",
          tier: "community",
          // What jarvis-pkg's registry.Command writes (os/go/internal/registry/store.go).
          command: ["/usr/bin/python3", "-I", `${dir("py", "0.1")}/server.py`],
          version: "0.1",
        },
        "py",
      ),
    ).toMatchObject({ ok: true, value: { runtime: "python" } });
  });

  it("accepts the python registration jarvis-pkg really writes (Go golden)", () => {
    const written: unknown = JSON.parse(
      readFileSync(
        new URL(
          "../../../../../os/go/internal/pkgtools/testdata/registration-python.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(parse(written, "old-py")).toMatchObject({
      ok: true,
      value: {
        runtime: "python",
        command: ["/usr/bin/python3", "-I", `${dir("old-py", "0.1")}/server.py`],
      },
    });
  });

  it("refuses python without -I (isolated mode) and any other interpreter flag", () => {
    const py = (command: string[]) =>
      parse({ ...files, id: "py", version: "0.1", command }, "py").ok;
    expect(py(["/usr/bin/python3", `${dir("py", "0.1")}/server.py`])).toBe(false);
    expect(py(["/usr/bin/python3", "-c", `${dir("py", "0.1")}/server.py`])).toBe(false);
    expect(py(["/usr/bin/python3", "-I", "-c", `${dir("py", "0.1")}/server.py`])).toBe(false);
  });

  it("never believes the file's tier: it is community until the index says otherwise", () => {
    expect(parse(files)).toMatchObject({ ok: true, value: { tier: "community" } });
  });

  it("refuses reserved ids, mismatched file names, foreign commands and bad versions", () => {
    expect(parse({ ...files, id: "jarvis-pkg" }, "jarvis-pkg").ok).toBe(false);
    expect(parse(files, "other").ok).toBe(false);
    expect(parse({ ...files, command: ["/bin/sh", "-c", "curl x | sh"] }).ok).toBe(false);
    expect(
      parse({ ...files, command: [`${dir("jarvis-files", "1.0.0")}/../../x/server`] }).ok,
    ).toBe(false);
    expect(parse({ ...files, command: [`${dir("jarvis-files", "9.9")}/server`] }).ok).toBe(false);
    expect(parse({ ...files, version: "../1" }).ok).toBe(false);
    expect(parse({ ...files, tier: "root" }).ok).toBe(false);
    expect(parse({ ...files, permissions: { network: "yes", paths: [] } }).ok).toBe(false);
  });

  it("refuses declared paths outside plain home folders", () => {
    for (const bad of [
      "/etc",
      "~",
      "~/",
      "~/.config",
      "~/.local/x",
      "~/.ssh/keys",
      "~/Docs/../.config",
      "~/a b",
      "~/x:y",
    ]) {
      expect(parse({ ...files, permissions: { network: false, paths: [bad] } }).ok).toBe(false);
    }
    expect(
      parse({
        ...files,
        permissions: { network: false, paths: ["~/Documents/Notes", "~/Music/"] },
      }),
    ).toMatchObject({
      ok: true,
      value: { writablePaths: [`${HOME}/Documents/Notes`, `${HOME}/Music`] },
    });
    expect(expandDeclaredPath(HOME, "~/Pictures")).toBe(`${HOME}/Pictures`);
  });
});

describe("bindToIndex (contracts §7 #2)", () => {
  const registration = () => {
    const parsed = parseRegistration(files, { home: HOME, fileId: "jarvis-files" });
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  };

  it("takes tier, permissions and tool risks from the index", () => {
    const bound = bindToIndex(
      registration(),
      entryFor({ permissions: { network: true, paths: ["~/Music"] } }),
      HOME,
    );
    expect(bound).toMatchObject({
      ok: true,
      value: {
        tier: "official",
        permissions: { network: true, paths: ["~/Music"] },
        writablePaths: [`${HOME}/Music`],
        tools: [{ name: "files.search", risk: "safe" }],
      },
    });
  });

  it("refuses the jarvis- prefix outside the official tier, and other mismatches", () => {
    expect(bindToIndex(registration(), entryFor({ tier: "community" }), HOME).ok).toBe(false);
    expect(bindToIndex(registration(), entryFor({ version: "2.0.0" }), HOME).ok).toBe(false);
    expect(
      bindToIndex(
        registration(),
        entryFor({ artifact: { url: "u", sha256: "a".repeat(64), runtime: "node" } }),
        HOME,
      ).ok,
    ).toBe(false);
    expect(
      bindToIndex(
        registration(),
        entryFor({ permissions: { network: false, paths: ["~/.ssh"] } }),
        HOME,
      ).ok,
    ).toBe(false);
  });
});

describe("sandboxArgv (contracts §7 #1)", () => {
  it("is a transient user service with the hardening properties and a scrubbed environment", () => {
    const parsed = parseRegistration(
      {
        ...files,
        id: "notes",
        version: "2.0",
        command: [`${dir("notes", "2.0")}/server`],
        permissions: { network: true, paths: ["~/Documents/Notes"] },
      },
      { home: HOME, fileId: "notes" },
    );
    if (!parsed.ok) throw new Error(parsed.error);
    expect(sandboxArgv(parsed.value, HOME, RUN)).toEqual([
      "systemd-run",
      "--user",
      "--pipe",
      "--quiet",
      "--collect",
      "-p",
      "NoNewPrivileges=yes",
      "-p",
      "PrivateNetwork=no",
      "-p",
      "ProtectHome=read-only",
      "-p",
      `ReadWritePaths=${HOME}/Documents/Notes`,
      "-p",
      "InaccessiblePaths=-/run/user/1000",
      "-p",
      "InaccessiblePaths=-/run/dbus/system_bus_socket",
      "-p",
      "InaccessiblePaths=-/tmp/.X11-unix",
      "-p",
      "InaccessiblePaths=-/tmp/.ICE-unix",
      "-p",
      `InaccessiblePaths=-${HOME}/.ssh`,
      "-p",
      `InaccessiblePaths=-${HOME}/.gnupg`,
      "-p",
      `InaccessiblePaths=-${HOME}/.local/share/keyrings`,
      "-p",
      `InaccessiblePaths=-${HOME}/.config/jarvis`,
      "--",
      "/usr/bin/env",
      "-i",
      "PATH=/usr/bin:/bin",
      `HOME=${HOME}`,
      "LANG=C.UTF-8",
      `${dir("notes", "2.0")}/server`,
    ]);
    const offline = parseRegistration(files, { home: HOME, fileId: "jarvis-files" });
    if (!offline.ok) throw new Error(offline.error);
    const argv = sandboxArgv(offline.value, HOME, RUN);
    expect(argv).toContain("PrivateNetwork=yes");
    expect(argv).not.toContain("--scope");
    expect(argv.some((a) => a.startsWith("ReadWritePaths="))).toBe(false);
  });

  it("passes systemd no specifiers: every path is absolute", () => {
    const parsed = parseRegistration(
      {
        id: "notes",
        version: "2.0",
        tier: "community",
        command: [`${dir("notes", "2.0")}/server`],
        permissions: { network: false, paths: [] },
      },
      { home: HOME, fileId: "notes" },
    );
    if (!parsed.ok) throw new Error(parsed.error);
    for (const argv of [sandboxArgv(parsed.value, HOME, RUN), SANDBOX_PROBE]) {
      expect(argv.some((a) => a.includes("%"))).toBe(false);
      for (const a of argv.filter((x) => x.startsWith("InaccessiblePaths=-"))) {
        expect(a.slice("InaccessiblePaths=-".length).startsWith("/")).toBe(true);
      }
    }
  });

  it("resolves the runtime dir from the env, else the uid, and needs an absolute path", () => {
    expect(resolveRuntimeDir({ XDG_RUNTIME_DIR: "/run/user/7" }, 1000)).toBe("/run/user/7");
    expect(resolveRuntimeDir({ XDG_RUNTIME_DIR: "relative" }, 1000)).toBe("/run/user/1000");
    expect(resolveRuntimeDir({}, 42)).toBe("/run/user/42");
    expect(resolveRuntimeDir({}, undefined)).toBeUndefined();
  });

  it("probes through the same properties", () => {
    expect(SANDBOX_PROBE).toContain("--pipe");
    expect(SANDBOX_PROBE).toContain("NoNewPrivileges=yes");
    expect(SANDBOX_PROBE).toContain("PrivateNetwork=yes");
  });

  it("hides the whole runtime dir (user manager, agents, wayland) and every masked home entry", () => {
    const masked = [`${HOME}/.aws`, `${HOME}/.config`, `${HOME}/.my dir`];
    const parsed = parseRegistration(files, { home: HOME, fileId: "jarvis-files" });
    if (!parsed.ok) throw new Error(parsed.error);
    const argv = sandboxArgv(parsed.value, HOME, RUN, masked);
    expect(argv).toContain(`InaccessiblePaths=-${RUN}`);
    expect(argv.some((a) => a.startsWith(`InaccessiblePaths=-${RUN}/`))).toBe(false);
    expect(argv).toContain(`InaccessiblePaths=-${HOME}/.aws`);
    expect(argv).toContain(`InaccessiblePaths=-${HOME}/.config`);
    expect(argv).toContain(`InaccessiblePaths="-${HOME}/.my dir"`);
    const probe = sandboxProbe(HOME, RUN, masked);
    expect(probe).toContain(`InaccessiblePaths=-${HOME}/.aws`);
    // The probe checks the runtime dir and every masked path, passed as
    // arguments (never spliced into the script).
    expect(probe.slice(probe.indexOf(PROBE_SCRIPT) + 1)).toEqual(["sh", RUN, ...masked]);
    expect(PROBE_SCRIPT).toContain('test ! -e "$rt/systemd/private"');
  });

  it("masks every hidden home entry except the way down to the installed servers", async () => {
    const tree: Record<string, string[]> = {
      [HOME]: ["Documents", ".aws", ".bashrc", ".local", ".mozilla", ".netrc", ".config", "x\ny"],
      [`${HOME}/.local`]: ["bin", "share", "state"],
      [`${HOME}/.local/share`]: ["jarvis", "keyrings", "Trash"],
      [`${HOME}/.local/share/jarvis`]: ["mcp", "memory.sqlite"],
      [`${HOME}/.local/share/jarvis/mcp`]: ["jarvis-files"],
    };
    const listDir = async (path: string) => {
      const names = tree[path];
      if (names === undefined) throw new Error("ENOENT");
      return names;
    };
    expect(await maskedHomeEntries(HOME, listDir)).toEqual([
      `${HOME}/.aws`,
      `${HOME}/.bashrc`,
      `${HOME}/.config`,
      `${HOME}/.mozilla`,
      `${HOME}/.netrc`,
      `${HOME}/.local/bin`,
      `${HOME}/.local/state`,
      `${HOME}/.local/share/Trash`,
      `${HOME}/.local/share/keyrings`,
      `${HOME}/.local/share/jarvis/memory.sqlite`,
    ]);
    await expect(
      maskedHomeEntries(HOME, async () => {
        throw new Error("EACCES");
      }),
    ).resolves.toBeUndefined();
  });
});

describe("clock.timer is started by jarvisd, not by the sandboxed server", () => {
  const ok = { timerId: "jarvis-timer-abcd1234", seconds: 300, label: "Tea", firesAt: "x" };

  it("parses only a well-formed request", () => {
    expect(parseTimerRequest(ok)).toEqual({
      unit: "jarvis-timer-abcd1234",
      seconds: 300,
      label: "Tea",
    });
    for (const bad of [
      { ...ok, timerId: "evil.service" },
      { ...ok, seconds: 0 },
      { ...ok, seconds: 86_401 },
      { ...ok, seconds: 1.5 },
      { ...ok, label: "" },
      { ...ok, label: "a\u202eb" },
      { ...ok, label: "\u001b[2J" },
      { ...ok, label: "x".repeat(101) },
      null,
    ]) {
      expect(parseTimerRequest(bad)).toBeUndefined();
    }
    expect(timerArgv({ unit: "jarvis-timer-abcd1234", seconds: 300, label: "-rf" })).toEqual([
      "systemd-run",
      "--user",
      "--quiet",
      "--collect",
      "--unit=jarvis-timer-abcd1234",
      "--on-active=300s",
      "--timer-property=AccuracySec=1s",
      "--",
      "/usr/bin/notify-send",
      "--app-name=Jarvis",
      "--",
      "Jarvis timer",
      "-rf",
    ]);
  });

  it("starts the timer after a successful clock.timer and reports a failed start", async () => {
    const started: TimerRequest[] = [];
    const inner: McpSession = {
      name: "jarvis-clock",
      alive: true,
      listTools: async () => [],
      callTool: async (name) =>
        name === "clock.timer"
          ? { isError: false, structuredContent: ok, text: "{}" }
          : { isError: false, structuredContent: { utc: "now" }, text: "{}" },
      close: () => {},
    };
    const wrapped = withClockTimer(inner, async (timer) => {
      started.push(timer);
    });
    await expect(wrapped.callTool("clock.timer", {}, { timeoutMs: 1 })).resolves.toMatchObject({
      isError: false,
    });
    await wrapped.callTool("clock.now", {}, { timeoutMs: 1 });
    expect(started).toEqual([{ unit: "jarvis-timer-abcd1234", seconds: 300, label: "Tea" }]);
    const failing = withClockTimer(inner, async () => {
      throw new Error("Failed to connect to bus");
    });
    await expect(failing.callTool("clock.timer", {}, { timeoutMs: 1 })).resolves.toMatchObject({
      isError: true,
      text: expect.stringContaining("Failed to connect to bus"),
    });
  });
});

/** A minimal ustar writer (what jarvis-pkg's Pack produces). */
function ustar(entries: { name: string; data?: string; dir?: boolean; type?: string }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.data ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write(entry.type ?? (entry.dir === true ? "5" : "0"), 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

describe("installed artifact verification (contract gap 10)", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  });
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");

  it("lists a tarball's files with their hashes and refuses links and escapes", () => {
    const listing = tarListing(
      ustar([
        { name: "./", dir: true },
        { name: "server.js", data: "a" },
        { name: "lib/x.js", data: "b" },
      ]),
    );
    expect([...listing.entries()]).toEqual([
      ["server.js", { kind: "file", sha256: sha("a") }],
      ["lib/x.js", { kind: "file", sha256: sha("b") }],
      ["lib", { kind: "dir" }],
    ]);
    expect(() => tarListing(ustar([{ name: "../x", data: "a" }]))).toThrow(/unsafe/);
    expect(() => tarListing(ustar([{ name: "link", type: "2" }]))).toThrow(/not a file/);
  });

  function installed(): { tarball: string; dir: string } {
    const root = mkdtempSync(join(tmpdir(), "jarvis-verify-"));
    temps.push(root);
    const tarball = join(root, "1.0.tar.gz");
    writeFileSync(
      tarball,
      gzipSync(
        ustar([
          { name: "server.py", data: "print(1)" },
          { name: "pkg/util.py", data: "x=1" },
        ]),
      ),
    );
    const dir = join(root, "1.0");
    mkdirSync(join(dir, "pkg"), { recursive: true });
    writeFileSync(join(dir, "server.py"), "print(1)");
    writeFileSync(join(dir, "pkg", "util.py"), "x=1");
    return { tarball, dir };
  }

  it("accepts an untouched install and refuses changed, extra, missing or linked files", async () => {
    const good = installed();
    await expect(nodeVerifyUnpacked(good.tarball, good.dir)).resolves.toBeUndefined();

    const changed = installed();
    writeFileSync(join(changed.dir, "pkg", "util.py"), "import os");
    await expect(nodeVerifyUnpacked(changed.tarball, changed.dir)).rejects.toThrow(/changed/);

    const extra = installed();
    writeFileSync(join(extra.dir, "pkg", "evil.py"), "x");
    await expect(nodeVerifyUnpacked(extra.tarball, extra.dir)).rejects.toThrow(/not part/);

    const missing = installed();
    rmSync(join(missing.dir, "pkg", "util.py"));
    await expect(nodeVerifyUnpacked(missing.tarball, missing.dir)).rejects.toThrow(/missing/);

    const linked = installed();
    rmSync(join(linked.dir, "server.py"));
    symlinkSync("/etc/passwd", join(linked.dir, "server.py"));
    await expect(nodeVerifyUnpacked(linked.tarball, linked.dir)).rejects.toThrow(/regular file/);
  });

  it.skipIf(process.platform === "win32")(
    "reads a tarball made by the system tar (pax/ustar) the same way",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "jarvis-systar-"));
      temps.push(root);
      const src = join(root, "src");
      mkdirSync(join(src, "lib"), { recursive: true });
      writeFileSync(join(src, "server"), "bin");
      chmodSync(join(src, "server"), 0o755);
      writeFileSync(join(src, "lib", "a.txt"), "a");
      const tarball = join(root, "a.tar.gz");
      execFileSync("tar", ["-czf", tarball, "-C", src, "."], {
        env: { ...process.env, COPYFILE_DISABLE: "1" },
      });
      await expect(nodeVerifyUnpacked(tarball, src)).resolves.toBeUndefined();
    },
  );
});

const tool = (name: string, risk: unknown): McpTool => ({
  name,
  description: name,
  inputSchema: { type: "object", properties: {} },
  meta: { jarvis: { risk, hidden: false } },
});

describe("capSession (contracts §7 #3)", () => {
  it("lets a server make a tool stricter than the index, never looser", async () => {
    const inner: McpSession = {
      name: "x",
      alive: true,
      listTools: async () => [
        tool("a", "confirm"),
        tool("b", "safe"),
        tool("c", "safe"),
        tool("d", undefined),
      ],
      callTool: async () => ({ isError: false, structuredContent: null, text: "" }),
      close: () => {},
    };
    const capped = capSession(inner, [
      { name: "a", risk: "safe" },
      { name: "b", risk: "confirm" },
      { name: "c", risk: "safe" },
    ]);
    const risks = (await capped.listTools()).map(
      (t) => (t.meta as { jarvis: { risk: string } }).jarvis.risk,
    );
    expect(risks).toEqual(["confirm", "confirm", "safe", "confirm"]);
  });
});

describe("createRegistryServers", () => {
  const session = (name: string): McpSession => ({
    name,
    alive: true,
    listTools: async () => [tool("files.search", "safe")],
    callTool: async () => ({ isError: false, structuredContent: null, text: "" }),
    close: () => {},
  });
  const INDEX_PATH = "/home/ali/.cache/jarvis/registry/index.verified.json";
  const goodIndex = JSON.stringify({
    version: 1,
    generatedAt: "2026-10-01T00:00:00Z",
    validUntil: "2026-11-01T00:00:00Z",
    entries: [entryFor()],
  });
  const NOW = Date.parse("2026-10-09T00:00:00Z");

  function setup(
    fileMap: Record<string, string>,
    probeCode: number,
    opts: { hash?: string; index?: string; tampered?: boolean } = {},
  ) {
    const verified: [string, string][] = [];
    const connects: { name: string; argv: readonly string[] }[] = [];
    const probes: (readonly string[])[] = [];
    const logs: string[] = [];
    const hashed: string[] = [];
    const registry = createRegistryServers({
      home: HOME,
      runtimeDir: RUN,
      dir: `${HOME}/.config/jarvis/mcp.d`,
      indexPath: INDEX_PATH,
      now: () => NOW,
      listDir: async (path) =>
        path === HOME
          ? [".aws", "Documents"]
          : path === `${HOME}/.config/jarvis/mcp.d`
            ? Object.keys(fileMap)
            : [],
      readFile: async (path) => {
        if (path === INDEX_PATH) {
          if (opts.index === "") throw new Error("ENOENT");
          return opts.index ?? goodIndex;
        }
        return fileMap[path.split("/").at(-1) ?? ""] ?? "";
      },
      hashFile: async (path) => {
        hashed.push(path);
        return opts.hash ?? "a".repeat(64);
      },
      verifyUnpacked: async (tarball, installed) => {
        verified.push([tarball, installed]);
        if (opts.tampered === true) throw new Error("server.py was changed");
      },
      runProbe: async (argv) => {
        probes.push(argv);
        return probeCode;
      },
      connect: async (name, argv) => {
        connects.push({ name, argv });
        return session(name);
      },
      log: (line) => logs.push(line),
    });
    return { registry, connects, probes, logs, hashed, verified };
  }
  const filesJson = { "jarvis-files.json": JSON.stringify(files) };

  it("starts nothing when the sandbox probe fails (fails closed), and says so once", async () => {
    const { registry, connects, probes, logs } = setup(filesJson, 1);
    const first = await registry.load();
    await registry.load();
    expect(first.sandbox).toBe("unavailable");
    expect(first.sessions).toEqual([]);
    expect(first.installed.map((r) => r.id)).toEqual(["jarvis-files"]);
    expect(connects).toEqual([]);
    expect(probes[0]).toEqual(sandboxProbe(HOME, RUN, [`${HOME}/.aws`]));
    expect(logs.filter((l) => l.includes("sandbox"))).toHaveLength(1);
  });

  it("launches each valid, verified registration sandboxed and reports the index's tier", async () => {
    const { registry, connects, logs, hashed, verified } = setup(
      {
        ...filesJson,
        "broken.json": "{",
        "evil.json": JSON.stringify({ ...files, id: "evil", command: ["/bin/sh"] }),
        README: "x",
      },
      0,
    );
    const loaded = await registry.load();
    expect(loaded.sandbox).toBe("ok");
    expect(connects.map((c) => c.name)).toEqual(["jarvis-files"]);
    expect(connects[0]?.argv.slice(0, 3)).toEqual(["systemd-run", "--user", "--pipe"]);
    // The index sha256 is the .tar.gz's (contracts §3, §7 #7): jarvisd hashes
    // the verified tarball jarvis-pkg kept, then the unpacked folder against it.
    expect(hashed).toEqual([`${HOME}/.local/share/jarvis/mcp/jarvis-files/1.0.0.tar.gz`]);
    expect(verified).toEqual([
      [`${HOME}/.local/share/jarvis/mcp/jarvis-files/1.0.0.tar.gz`, dir("jarvis-files", "1.0.0")],
    ]);
    expect(connects[0]?.argv).toContain(`InaccessiblePaths=-${HOME}/.aws`);
    expect(loaded.tiers.get("jarvis-files")).toBe("official");
    expect(logs.join("\n")).toContain("broken.json");
    expect(logs.join("\n")).toContain("evil.json");
  });

  it("does not trust a tier claimed in mcp.d: the index decides", async () => {
    const index = JSON.stringify({
      version: 1,
      generatedAt: "2026-10-01T00:00:00Z",
      validUntil: "2026-11-01T00:00:00Z",
      entries: [entryFor({ id: "notes", tier: "community", version: "2.0" })],
    });
    const notes = {
      ...files,
      id: "notes",
      tier: "official",
      version: "2.0",
      command: [`${dir("notes", "2.0")}/server`],
    };
    const { registry } = setup({ "notes.json": JSON.stringify(notes) }, 0, { index });
    const loaded = await registry.load();
    expect(loaded.tiers.get("notes")).toBe("community");
  });

  it("refuses a jarvis- id that is not official in the index", async () => {
    const index = JSON.stringify({
      version: 1,
      generatedAt: "2026-10-01T00:00:00Z",
      validUntil: "2026-11-01T00:00:00Z",
      entries: [entryFor({ tier: "community" })],
    });
    const { registry, connects } = setup(filesJson, 0, { index });
    await registry.load();
    expect(connects).toEqual([]);
  });

  it("does not start a server whose installed file no longer matches the index hash", async () => {
    const { registry, connects, logs } = setup(filesJson, 0, { hash: "b".repeat(64) });
    const loaded = await registry.load();
    expect(connects).toEqual([]);
    expect(loaded.sessions).toEqual([]);
    expect(loaded.installed.map((r) => r.id)).toEqual(["jarvis-files"]);
    expect(logs.join("\n")).toContain("does not match the verified index");
  });

  it("does not start a server whose unpacked files differ from the verified tarball", async () => {
    const { registry, connects, logs } = setup(filesJson, 0, { tampered: true });
    await registry.load();
    expect(connects).toEqual([]);
    expect(logs.join("\n")).toContain("installed files do not match");
  });

  it("starts nothing without a usable (present, unexpired) verified index", async () => {
    const missing = setup(filesJson, 0, { index: "" });
    await missing.registry.load();
    expect(missing.connects).toEqual([]);
    const expired = setup(filesJson, 0, {
      index: JSON.stringify({
        version: 1,
        validUntil: "2026-10-01T00:00:00Z",
        entries: [entryFor()],
      }),
    });
    await expired.registry.load();
    expect(expired.connects).toEqual([]);
    expect(expired.probes).toEqual([]);
  });

  it("is empty with no registrations and does not probe", async () => {
    const { registry, probes } = setup({}, 0);
    await expect(registry.load()).resolves.toMatchObject({
      sessions: [],
      installed: [],
      sandbox: "unused",
    });
    expect(probes).toEqual([]);
  });
});
