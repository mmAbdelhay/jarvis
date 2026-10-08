// Registry (add-on) MCP servers (contracts M2.5 §3, overridden by §7).
// jarvis-pkg installs them to ~/.local/share/jarvis/mcp/<id>/<version>/ and
// writes ~/.config/jarvis/mcp.d/<id>.json. jarvisd reads those at start and
// on change, checks every field, and launches each as a transient user
// SERVICE:
//   systemd-run --user --pipe --quiet --collect -p NoNewPrivileges=yes
//     -p PrivateNetwork=<!network> -p ProtectHome=read-only
//     [-p ReadWritePaths=<paths>] -p InaccessiblePaths=-<absolute> -- env -i … <command>
//
// Trust (§7 #2): the `tier` in mcp.d is never believed. Tier, permissions and
// tool risks come from the verified index cache that only jarvis-pkg writes
// (after the signature check); the installed entry point is re-hashed against
// the index at every launch, and a mismatch means the server is not started.
// A risk the server reports at runtime may only be stricter than the index
// (capSession). The sandbox FAILS CLOSED: one probe through the same
// properties must show a private network and a read-only $HOME, or no add-on
// server starts.
//
// No electron here (core/no-electron.test.ts).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, watch } from "node:fs";
import { posix } from "node:path";
import {
  isRecord,
  type McpSession,
  parseRegistrySearch,
  raiseRisk,
  type RegistryEntry,
  type RegistryRuntime,
  type RegistryTier,
  type ToolRisk,
} from "@jarvis/core";

export type Registration = {
  id: string;
  version: string;
  /** From the verified index; "community" while the index has no such entry. */
  tier: RegistryTier;
  runtime: RegistryRuntime;
  command: string[];
  /** As declared: "~/"-prefixed (what registry:list shows). */
  permissions: { network: boolean; paths: string[] };
  /** The declared paths expanded under $HOME (what systemd-run gets). */
  writablePaths: string[];
  /** Tool risks from the verified index (empty while it has no such entry). */
  tools: { name: string; risk: "safe" | "confirm" }[];
};

export const RESERVED_SERVER_IDS: ReadonlySet<string> = new Set([
  "jarvis-pkg",
  "jarvis-diag",
  "jarvis-helper",
  "jarvis-installer",
  "jarvis-installer-backend",
]);
/** The official servers J builds. Any other `jarvis-` id is refused (§7 #2). */
export const OFFICIAL_SERVER_IDS: ReadonlySet<string> = new Set([
  "jarvis-files",
  "jarvis-web",
  "jarvis-clock",
]);
export const BUNDLED_NODE = "/usr/lib/jarvis/node/bin/node";
export const SYSTEM_PYTHON = "/usr/bin/python3";
const ENV = "/usr/bin/env";
const MAX_DECLARED_PATHS = 8;
const SERVER_ID = /^[a-z0-9][a-z0-9-]{1,47}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+~-]{0,31}$/;
/** No leading dot: hidden folders (~/.config, ~/.ssh, ~/.local) are never writable. */
const PATH_SEGMENT = /^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]{0,127}$/;

const BASE_ARGV = ["systemd-run", "--user", "--pipe", "--quiet", "--collect"];

/** Secrets and control sockets an add-on never sees (§7 #1). systemd does not
 *  expand specifiers (%h, %t) in transient-unit properties and requires
 *  absolute paths, so jarvisd builds them from $HOME and the runtime dir. The
 *  leading "-" makes a path that does not exist (no ~/.gnupg yet) harmless
 *  instead of a failed unit start. */
function inaccessiblePaths(home: string, runtimeDir: string): string[] {
  return [
    posix.join(runtimeDir, "bus"),
    "/run/dbus/system_bus_socket",
    posix.join(home, ".ssh"),
    posix.join(home, ".gnupg"),
    posix.join(home, ".local", "share", "keyrings"),
    posix.join(home, ".config", "jarvis"),
  ];
}

/** $XDG_RUNTIME_DIR, else /run/user/<uid>; must be absolute. */
export function resolveRuntimeDir(
  env: Readonly<Record<string, string | undefined>>,
  uid: number | undefined,
): string | undefined {
  const fromEnv = env["XDG_RUNTIME_DIR"];
  if (fromEnv !== undefined && posix.isAbsolute(fromEnv)) return posix.normalize(fromEnv);
  if (uid !== undefined && uid >= 0) return `/run/user/${uid}`;
  return undefined;
}

function properties(
  network: boolean,
  writablePaths: readonly string[],
  home: string,
  runtimeDir: string,
): string[] {
  const argv = [
    "-p",
    "NoNewPrivileges=yes",
    "-p",
    `PrivateNetwork=${network ? "no" : "yes"}`,
    "-p",
    "ProtectHome=read-only",
  ];
  if (writablePaths.length > 0) argv.push("-p", `ReadWritePaths=${writablePaths.join(" ")}`);
  for (const path of inaccessiblePaths(home, runtimeDir)) {
    argv.push("-p", `InaccessiblePaths=-${path}`);
  }
  return argv;
}

/** Run once before any add-on server: inside the sandbox only `lo` may exist
 *  and $HOME must not be writable. Exit 0 = the sandbox applied. */
export function sandboxProbe(home: string, runtimeDir: string): string[] {
  return [
    ...BASE_ARGV,
    ...properties(false, [], home, runtimeDir),
    "--",
    "/bin/sh",
    "-c",
    'test "$(grep -c : /proc/net/dev)" -le 1 && test ! -w "$HOME"',
  ];
}

export function installDir(home: string, id: string, version: string): string {
  return posix.join(home, ".local", "share", "jarvis", "mcp", id, version);
}

export function expandDeclaredPath(home: string, raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.startsWith("~/")) return undefined;
  const segments = raw.slice(2).split("/");
  if (segments.at(-1) === "") segments.pop();
  if (segments.length === 0 || !segments.every((segment) => PATH_SEGMENT.test(segment))) {
    return undefined;
  }
  return posix.join(home, ...segments);
}

const expandHome = (home: string, value: string) =>
  value.startsWith("~/") ? posix.join(home, value.slice(2)) : value;

function expandPaths(home: string, declared: readonly unknown[]): string[] | undefined {
  const out: string[] = [];
  for (const path of declared) {
    const expanded = expandDeclaredPath(home, path);
    if (expanded === undefined) return undefined;
    out.push(expanded);
  }
  return out;
}

/** Checks a registration file. Its `tier`, `permissions` and `tools` are only
 *  shape-checked here: bindToIndex replaces them with the verified index's. */
export function parseRegistration(
  raw: unknown,
  context: { home: string; fileId: string },
): { ok: true; value: Registration } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (!isRecord(raw)) return fail("must be a JSON object");
  const { id, version, tier, command, permissions } = raw;
  if (typeof id !== "string" || !SERVER_ID.test(id)) return fail("id must be a-z, 0-9 and -");
  if (id !== context.fileId) return fail(`id "${id}" does not match the file name`);
  if (RESERVED_SERVER_IDS.has(id)) return fail(`"${id}" is reserved for Jarvis's own servers`);
  if (typeof version !== "string" || !VERSION.test(version) || version.includes("..")) {
    return fail("version is not a plain version string");
  }
  if (tier !== "official" && tier !== "reviewed" && tier !== "community") {
    return fail("tier must be official, reviewed or community");
  }
  if (!isRecord(permissions) || typeof permissions["network"] !== "boolean") {
    return fail("permissions must be {network: boolean, paths: string[]}");
  }
  const declared = permissions["paths"];
  if (!Array.isArray(declared) || declared.length > MAX_DECLARED_PATHS) {
    return fail(`permissions.paths must be a list of at most ${MAX_DECLARED_PATHS}`);
  }
  const writablePaths = expandPaths(context.home, declared);
  if (writablePaths === undefined) return fail("permissions.paths must be plain folders under ~/");
  if (!Array.isArray(command) || !command.every((part) => typeof part === "string")) {
    return fail("command must be a list of strings");
  }
  const argv = (command as string[]).map((part) => expandHome(context.home, part));
  const dir = installDir(context.home, id, version);
  let runtime: RegistryRuntime;
  if (argv.length === 1 && argv[0] === `${dir}/server`) runtime = "go-static";
  else if (argv.length === 2 && argv[0] === BUNDLED_NODE && argv[1] === `${dir}/server.js`)
    runtime = "node";
  else if (argv.length === 2 && argv[0] === SYSTEM_PYTHON && argv[1] === `${dir}/server.py`)
    runtime = "python";
  else return fail(`command must be the installed server under ${dir}/`);
  return {
    ok: true,
    value: {
      id,
      version,
      tier: "community",
      runtime,
      command: argv,
      permissions: { network: permissions["network"], paths: [...(declared as string[])] },
      writablePaths,
      tools: [],
    },
  };
}

/** Takes tier, permissions and tool risks from the verified index entry
 *  (§7 #2). `jarvis-` ids are official-tier only. */
export function bindToIndex(
  registration: Registration,
  entry: RegistryEntry,
  home: string,
): { ok: true; value: Registration } | { ok: false; error: string } {
  if (entry.id !== registration.id || entry.version !== registration.version) {
    return {
      ok: false,
      error: `the verified index has no ${registration.id} ${registration.version}`,
    };
  }
  if (entry.artifact.runtime !== registration.runtime) {
    return { ok: false, error: "the runtime does not match the verified index" };
  }
  if (registration.id.startsWith("jarvis-") && entry.tier !== "official") {
    return {
      ok: false,
      error: `the jarvis- prefix is official-tier only; ${registration.id} is ${entry.tier}`,
    };
  }
  const writablePaths = expandPaths(home, entry.permissions.paths);
  if (writablePaths === undefined) {
    return {
      ok: false,
      error: "the verified index lists a path that is not a plain folder under ~/",
    };
  }
  return {
    ok: true,
    value: {
      ...registration,
      tier: entry.tier,
      permissions: { network: entry.permissions.network, paths: [...entry.permissions.paths] },
      writablePaths,
      tools: entry.tools.map((tool) => ({ ...tool })),
    },
  };
}

export function sandboxArgv(
  registration: Registration,
  home: string,
  runtimeDir: string,
): string[] {
  // A clean environment: no session variables, tokens or proxies from jarvisd.
  return [
    ...BASE_ARGV,
    ...properties(registration.permissions.network, registration.writablePaths, home, runtimeDir),
    "--",
    ENV,
    "-i",
    "PATH=/usr/bin:/bin",
    `HOME=${home}`,
    "LANG=C.UTF-8",
    ...registration.command,
  ];
}

/** Risks the server reports at runtime may only be stricter than the index
 *  (§7 #3); a tool the index does not list is `confirm`. */
export function capSession(session: McpSession, tools: Registration["tools"]): McpSession {
  const indexed = new Map(tools.map((tool) => [tool.name, tool.risk] as const));
  return {
    name: session.name,
    get alive() {
      return session.alive;
    },
    async listTools() {
      return (await session.listTools()).map((tool) => {
        const meta = isRecord(tool.meta) ? tool.meta : {};
        const jarvis = isRecord(meta["jarvis"]) ? meta["jarvis"] : {};
        const reported = jarvis["risk"];
        const risk: ToolRisk = raiseRisk(
          indexed.get(tool.name) ?? "confirm",
          reported === "safe" || reported === "confirm" || reported === "password"
            ? reported
            : "safe",
        );
        return { ...tool, meta: { ...meta, jarvis: { ...jarvis, risk } } };
      });
    },
    callTool: (name, args, options) => session.callTool(name, args, options),
    close: () => session.close(),
  };
}

export type LoadedRegistry = {
  sessions: McpSession[];
  tiers: ReadonlyMap<string, RegistryTier>;
  installed: Registration[];
  sandbox: "ok" | "unavailable" | "unused";
};

export const EMPTY_REGISTRY: LoadedRegistry = {
  sessions: [],
  tiers: new Map(),
  installed: [],
  sandbox: "unused",
};

export function createRegistryServers(deps: {
  home: string;
  /** Absolute $XDG_RUNTIME_DIR or /run/user/<uid> (no specifiers reach systemd). */
  runtimeDir: string;
  dir: string;
  /** ~/.cache/jarvis/registry/index.verified.json (written by jarvis-pkg only). */
  indexPath: string;
  now(): number;
  listDir(dir: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  /** sha256 (hex) of a file. */
  hashFile(path: string): Promise<string>;
  runProbe(argv: readonly string[]): Promise<number>;
  connect(name: string, argv: readonly string[]): Promise<McpSession>;
  log(line: string): void;
}): { load(): Promise<LoadedRegistry> } {
  let sandboxOk = false;
  let warned = false;
  const reported = new Set<string>();
  /** Each distinct problem is logged once, not at every reload. */
  const logOnce = (line: string) => {
    if (reported.has(line)) return;
    reported.add(line);
    deps.log(line);
  };

  async function registrations(): Promise<Registration[]> {
    let names: string[];
    try {
      names = (await deps.listDir(deps.dir)).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      logOnce(
        `[registry] cannot read ${deps.dir}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
    const out: Registration[] = [];
    for (const name of names) {
      let raw: unknown;
      try {
        raw = JSON.parse(await deps.readFile(posix.join(deps.dir, name)));
      } catch {
        logOnce(`[registry] ${name}: not readable JSON; skipped`);
        continue;
      }
      const parsed = parseRegistration(raw, {
        home: deps.home,
        fileId: name.slice(0, -".json".length),
      });
      if (!parsed.ok) {
        logOnce(`[registry] ${name}: ${parsed.error}; skipped`);
        continue;
      }
      out.push(parsed.value);
    }
    return out;
  }

  async function verifiedIndex(): Promise<RegistryEntry[]> {
    try {
      const raw: unknown = JSON.parse(await deps.readFile(deps.indexPath));
      if (!isRecord(raw) || raw["version"] !== 1) throw new Error("not a version 1 index");
      const validUntil =
        typeof raw["validUntil"] === "string" ? Date.parse(raw["validUntil"]) : Number.NaN;
      if (!(validUntil > deps.now())) throw new Error("expired or missing validUntil");
      return parseRegistrySearch(raw);
    } catch (error) {
      logOnce(
        `[registry] no usable verified index (${error instanceof Error ? error.message : String(error)}); add-on tool servers stay off`,
      );
      return [];
    }
  }

  return {
    async load() {
      const files = await registrations();
      if (files.length === 0) return { ...EMPTY_REGISTRY };
      const index = await verifiedIndex();
      const bound: Registration[] = [];
      const launchable: Registration[] = [];
      for (const file of files) {
        const entry = index.find((e) => e.id === file.id && e.version === file.version);
        if (entry === undefined) {
          bound.push(file);
          if (index.length > 0)
            logOnce(`[registry] ${file.id}: not in the verified index; not started`);
          continue;
        }
        const result = bindToIndex(file, entry, deps.home);
        if (!result.ok) {
          bound.push(file);
          logOnce(`[registry] ${file.id}: ${result.error}; not started`);
          continue;
        }
        bound.push(result.value);
        let digest: string;
        try {
          digest = await deps.hashFile(file.command.at(-1) ?? "");
        } catch (error) {
          logOnce(
            `[registry] ${file.id}: cannot read the installed server: ${error instanceof Error ? error.message : String(error)}; not started`,
          );
          continue;
        }
        if (digest !== entry.artifact.sha256) {
          logOnce(
            `[registry] ${file.id}: the installed server does not match the verified index; not started`,
          );
          continue;
        }
        launchable.push(result.value);
      }
      if (launchable.length === 0) return { ...EMPTY_REGISTRY, installed: bound };
      if (!sandboxOk) {
        try {
          sandboxOk = (await deps.runProbe(sandboxProbe(deps.home, deps.runtimeDir))) === 0;
        } catch {
          sandboxOk = false;
        }
      }
      if (!sandboxOk) {
        if (!warned) {
          deps.log(
            "[registry] the user sandbox did not apply (systemd-run --user); add-on tool servers stay off",
          );
          warned = true;
        }
        return { sessions: [], tiers: new Map(), installed: bound, sandbox: "unavailable" };
      }
      const settled = await Promise.allSettled(
        launchable.map((registration) =>
          deps.connect(registration.id, sandboxArgv(registration, deps.home, deps.runtimeDir)),
        ),
      );
      const sessions: McpSession[] = [];
      const tiers = new Map<string, RegistryTier>();
      settled.forEach((result, position) => {
        const registration = launchable[position] as Registration;
        if (result.status === "fulfilled") {
          sessions.push(capSession(result.value, registration.tools));
          tiers.set(registration.id, registration.tier);
        } else {
          const reason =
            result.reason instanceof Error ? result.reason.message : String(result.reason);
          deps.log(`[registry] ${registration.id} did not start: ${reason}`);
        }
      });
      return { sessions, tiers, installed: bound, sandbox: "ok" };
    },
  };
}

export function nodeHashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export function nodeRunProbe(env: NodeJS.ProcessEnv): (argv: readonly string[]) => Promise<number> {
  return (argv) =>
    new Promise((resolve) => {
      const [command, ...args] = argv;
      if (command === undefined) {
        resolve(1);
        return;
      }
      const child = spawn(command, args, { env, stdio: "ignore" });
      const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      timer.unref();
      child.on("error", () => {
        clearTimeout(timer);
        resolve(1);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });
    });
}

/** Watches `dir` (created if missing); also fine for a single file's folder. */
export function nodeWatchDirectory(
  dir: string,
  onChange: () => void,
  log: (line: string) => void,
): () => void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // Watching below fails and says why.
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    const watcher = watch(dir, () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(onChange, 500);
      timer.unref();
    });
    watcher.on("error", (error) => log(`[registry] watching ${dir} stopped: ${error.message}`));
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      watcher.close();
    };
  } catch (error) {
    log(
      `[registry] cannot watch ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return () => {};
  }
}
