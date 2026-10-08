import type { McpSession, McpTool, RegistryEntry } from "@jarvis/core";
import { describe, expect, it } from "vitest";
import {
  bindToIndex,
  BUNDLED_NODE,
  capSession,
  createRegistryServers,
  expandDeclaredPath,
  parseRegistration,
  sandboxProbe,
  resolveRuntimeDir,
  sandboxArgv,
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
          command: ["/usr/bin/python3", `${dir("py", "0.1")}/server.py`],
          version: "0.1",
        },
        "py",
      ),
    ).toMatchObject({ ok: true, value: { runtime: "python" } });
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
      "InaccessiblePaths=-/run/user/1000/bus",
      "-p",
      "InaccessiblePaths=-/run/dbus/system_bus_socket",
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
    opts: { hash?: string; index?: string } = {},
  ) {
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
      listDir: async () => Object.keys(fileMap),
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
    return { registry, connects, probes, logs, hashed };
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
    expect(probes[0]).toEqual(SANDBOX_PROBE);
    expect(logs.filter((l) => l.includes("sandbox"))).toHaveLength(1);
  });

  it("launches each valid, verified registration sandboxed and reports the index's tier", async () => {
    const { registry, connects, logs, hashed } = setup(
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
    expect(hashed).toEqual([`${dir("jarvis-files", "1.0.0")}/server`]);
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
