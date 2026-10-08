// Registry (add-on) MCP servers (contracts M2.5 §3, overridden by §7).
// jarvis-pkg installs them to ~/.local/share/jarvis/mcp/<id>/<version>/ and
// writes ~/.config/jarvis/mcp.d/<id>.json. jarvisd reads those at start and
// on change, checks every field, and launches each as a transient user
// SERVICE:
//   systemd-run --user --pipe --quiet --collect -p NoNewPrivileges=yes
//     -p PrivateNetwork=<!network> -p ProtectHome=read-only
//     [-p ReadWritePaths=<paths>] -p InaccessiblePaths=-<absolute> -- env -i … <command>
//
// Beyond §7 #1 (final review): the WHOLE runtime dir is inaccessible (the
// user manager's private socket, gpg/ssh agents, wayland and pipewire live
// there, and filesystem sockets are not network-namespaced), and so is every
// hidden entry of $HOME except the path down to the installed servers
// (~/.aws, ~/.config/gh, ~/.mozilla, ~/.netrc, … are never readable). A
// server can still READ your plain (non-hidden) home folders (threat model R5).
//
// Trust (§7 #2): the `tier` in mcp.d is never believed. Tier, permissions and
// tool risks come from the verified index cache that only jarvis-pkg writes
// (after the signature check). At every launch the verified tarball jarvis-pkg
// keeps beside the version folder (~/.local/share/jarvis/mcp/<id>/<version>.tar.gz)
// is re-hashed against the index sha256 (the hash of the .tar.gz, §3, §7 #7),
// and the unpacked folder must hold exactly the tarball's files with the same
// bytes; any mismatch means the server is not started (contract gap 10).
//
// clock.timer: the official jarvis-clock server only validates and returns the
// timer; jarvisd starts the transient user timer (the user manager is out of
// every add-on's reach).
// A risk the server reports at runtime may only be stricter than the index
// (capSession). The sandbox FAILS CLOSED: one probe through the same
// properties must show a private network and a read-only $HOME, or no add-on
// server starts.
//
// No electron here (core/no-electron.test.ts).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, watch } from "node:fs";
import { lstat, readdir, readFile as readFileAsync } from "node:fs/promises";
import { posix } from "node:path";
import { gunzip } from "node:zlib";
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
  "jarvis-settings",
  "jarvis-apps",
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

/** Secrets and control sockets an add-on never sees (§7 #1, widened by the
 *  final review). systemd does not expand specifiers (%h, %t) in
 *  transient-unit properties and requires absolute paths, so jarvisd builds
 *  them from $HOME and the runtime dir. The leading "-" makes a path that does
 *  not exist (no ~/.gnupg yet) harmless instead of a failed unit start.
 *  `masked` is maskedHomeEntries' list (every hidden home entry except the way
 *  down to the installed servers); the fixed list stays as a floor. */
function inaccessiblePaths(home: string, runtimeDir: string, masked: readonly string[]): string[] {
  const all = [
    // The whole runtime dir: the user manager (systemd/private, which
    // `systemd-run --user` falls back to), the session bus, gpg-agent,
    // ssh agents (keyring/, gcr/), wayland-*, pipewire-*.
    runtimeDir,
    "/run/dbus/system_bus_socket",
    // X11 and ICE sockets (keystroke injection into the session).
    "/tmp/.X11-unix",
    "/tmp/.ICE-unix",
    posix.join(home, ".ssh"),
    posix.join(home, ".gnupg"),
    posix.join(home, ".local", "share", "keyrings"),
    posix.join(home, ".config", "jarvis"),
    ...masked,
  ];
  return [...new Set(all)];
}

/** The path under $HOME an add-on must still traverse: its own install dir. */
const KEEP_UNDER_HOME = [".local", "share", "jarvis", "mcp"] as const;
/** systemd property words: plain paths pass as they are; anything else is
 *  double-quoted with \ and " escaped. Control characters and "%" are never
 *  passed (no safe spelling); such an entry is reported instead. */
const PLAIN_PATH = /^[A-Za-z0-9._@+,=:/-]+$/;
const UNSPEAKABLE = /[\p{Cc}%]/u;
function systemdPathWord(prefix: string, path: string): string {
  return PLAIN_PATH.test(path)
    ? `${prefix}${path}`
    : `"${`${prefix}${path}`.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** Every hidden entry of $HOME, and every entry beside the path down to
 *  ~/.local/share/jarvis/mcp, as absolute paths (sorted). Undefined when
 *  $HOME itself cannot be listed: the caller then starts nothing. */
export async function maskedHomeEntries(
  home: string,
  listDir: (dir: string) => Promise<string[]>,
  log: (line: string) => void = () => {},
): Promise<string[] | undefined> {
  const out: string[] = [];
  let dir = home;
  for (let depth = 0; depth < KEEP_UNDER_HOME.length; depth++) {
    let names: string[];
    try {
      names = await listDir(dir);
    } catch {
      if (depth === 0) return undefined;
      break;
    }
    for (const name of [...names].sort()) {
      if (name === "." || name === ".." || name === KEEP_UNDER_HOME[depth]) continue;
      if (depth === 0 && !name.startsWith(".")) continue;
      const path = posix.join(dir, name);
      if (UNSPEAKABLE.test(path)) {
        log(`[registry] cannot hide ${JSON.stringify(path)} from add-ons (odd name)`);
        continue;
      }
      out.push(path);
    }
    dir = posix.join(dir, KEEP_UNDER_HOME[depth] as string);
  }
  return out;
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
  masked: readonly string[],
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
  for (const path of inaccessiblePaths(home, runtimeDir, masked)) {
    argv.push("-p", `InaccessiblePaths=${systemdPathWord("-", path)}`);
  }
  return argv;
}

/** Run once before any add-on server: inside the sandbox only `lo` may exist,
 *  $HOME must not be writable, the runtime dir (the user manager's socket,
 *  agents) must be unreachable and no masked home entry readable. Paths go in
 *  as arguments, never into the script text. Exit 0 = the sandbox applied. */
export const PROBE_SCRIPT =
  'rt=$1; shift; test "$(grep -c : /proc/net/dev)" -le 1 && test ! -w "$HOME" && ' +
  'test ! -x "$rt" && test ! -e "$rt/systemd/private" && test ! -e "$rt/bus" && ' +
  'for p in "$@"; do test ! -r "$p" || exit 1; done';
export function sandboxProbe(
  home: string,
  runtimeDir: string,
  masked: readonly string[] = [],
): string[] {
  return [
    ...BASE_ARGV,
    ...properties(false, [], home, runtimeDir, masked),
    "--",
    "/bin/sh",
    "-c",
    PROBE_SCRIPT,
    "sh",
    runtimeDir,
    ...masked,
  ];
}

export function installDir(home: string, id: string, version: string): string {
  return posix.join(home, ".local", "share", "jarvis", "mcp", id, version);
}

/** The verified tarball jarvis-pkg keeps: ~/.local/share/jarvis/mcp/<id>/<version>.tar.gz. */
export function artifactPath(home: string, id: string, version: string): string {
  return posix.join(home, ".local", "share", "jarvis", "mcp", id, `${version}.tar.gz`);
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
  // jarvis-pkg writes python3 -I (isolated: no PYTHON* env, no user site, no
  // script-dir-first import surprises from the caller's cwd).
  else if (
    argv.length === 3 &&
    argv[0] === SYSTEM_PYTHON &&
    argv[1] === "-I" &&
    argv[2] === `${dir}/server.py`
  )
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
  masked: readonly string[] = [],
): string[] {
  // A clean environment: no session variables, tokens or proxies from jarvisd.
  return [
    ...BASE_ARGV,
    ...properties(
      registration.permissions.network,
      registration.writablePaths,
      home,
      runtimeDir,
      masked,
    ),
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

/** A clock.timer the official jarvis-clock server validated and returned;
 *  jarvisd starts it (the server cannot reach the user manager). */
export type TimerRequest = { unit: string; seconds: number; label: string };
export const TIMER_SUMMARY = "Jarvis timer";
const TIMER_UNIT = /^jarvis-timer-[0-9a-f]{8}$/;
// Control and bidi-control characters never reach a notification.
const TIMER_LABEL_BAD = /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export function parseTimerRequest(data: unknown): TimerRequest | undefined {
  if (!isRecord(data)) return undefined;
  const { timerId, seconds, label } = data;
  if (typeof timerId !== "string" || !TIMER_UNIT.test(timerId)) return undefined;
  if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 1 || seconds > 86_400)
    return undefined;
  if (typeof label !== "string" || label.length === 0 || [...label].length > 100) return undefined;
  if (TIMER_LABEL_BAD.test(label)) return undefined;
  return { unit: timerId, seconds, label };
}

/** The transient user timer jarvisd starts for clock.timer (outside any sandbox). */
export function timerArgv(timer: TimerRequest): string[] {
  return [
    "systemd-run",
    "--user",
    "--quiet",
    "--collect",
    `--unit=${timer.unit}`,
    `--on-active=${timer.seconds}s`,
    "--timer-property=AccuracySec=1s",
    "--",
    "/usr/bin/notify-send",
    "--app-name=Jarvis",
    "--",
    TIMER_SUMMARY,
    timer.label,
  ];
}

/** jarvis-clock (official tier only): a successful clock.timer result is a
 *  request jarvisd carries out; a bad request or a failed start is an error. */
export function withClockTimer(
  session: McpSession,
  startTimer: (timer: TimerRequest) => Promise<void>,
): McpSession {
  const failed = (text: string) => ({
    isError: true,
    structuredContent: { code: "failed", message: text },
    text,
  });
  return {
    name: session.name,
    get alive() {
      return session.alive;
    },
    listTools: () => session.listTools(),
    async callTool(name, args, options) {
      const result = await session.callTool(name, args, options);
      if (name !== "clock.timer" || result.isError) return result;
      const timer = parseTimerRequest(result.structuredContent);
      if (timer === undefined)
        return failed("could not start the timer: the request was malformed");
      try {
        await startTimer(timer);
      } catch (error) {
        return failed(
          `could not start the timer: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return result;
    },
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
  /** Throws unless `dir` holds exactly the files of the gzip tar at
   *  `tarball`, byte for byte (nodeVerifyUnpacked). */
  verifyUnpacked(tarball: string, dir: string): Promise<void>;
  /** clock.timer from the official jarvis-clock (absent → the tool fails). */
  startTimer?(timer: TimerRequest): Promise<void>;
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
        // Contract gap 10: entry.artifact.sha256 is the hash of the .tar.gz
        // (contracts §3, §7 #7). jarvis-pkg keeps the verified tarball beside
        // the version folder; jarvisd re-hashes it, then checks the unpacked
        // folder holds exactly its files (every file of node/python servers).
        const tarball = artifactPath(deps.home, file.id, file.version);
        let digest: string;
        try {
          digest = await deps.hashFile(tarball);
        } catch (error) {
          logOnce(
            `[registry] ${file.id}: cannot read the installed artifact: ${error instanceof Error ? error.message : String(error)}; not started`,
          );
          continue;
        }
        if (digest !== entry.artifact.sha256) {
          logOnce(
            `[registry] ${file.id}: the installed artifact does not match the verified index; not started`,
          );
          continue;
        }
        try {
          await deps.verifyUnpacked(tarball, installDir(deps.home, file.id, file.version));
        } catch (error) {
          logOnce(
            `[registry] ${file.id}: the installed files do not match the verified index (${error instanceof Error ? error.message : String(error)}); not started`,
          );
          continue;
        }
        launchable.push(result.value);
      }
      if (launchable.length === 0) return { ...EMPTY_REGISTRY, installed: bound };
      const masked = await maskedHomeEntries(deps.home, deps.listDir, logOnce);
      if (masked === undefined) {
        logOnce(`[registry] cannot list ${deps.home}; add-on tool servers stay off`);
        return { sessions: [], tiers: new Map(), installed: bound, sandbox: "unavailable" };
      }
      if (!sandboxOk) {
        try {
          sandboxOk = (await deps.runProbe(sandboxProbe(deps.home, deps.runtimeDir, masked))) === 0;
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
          deps.connect(
            registration.id,
            sandboxArgv(registration, deps.home, deps.runtimeDir, masked),
          ),
        ),
      );
      const sessions: McpSession[] = [];
      const tiers = new Map<string, RegistryTier>();
      settled.forEach((result, position) => {
        const registration = launchable[position] as Registration;
        if (result.status === "fulfilled") {
          const capped = capSession(result.value, registration.tools);
          sessions.push(
            registration.id === "jarvis-clock" && registration.tier === "official"
              ? withClockTimer(capped, (timer) =>
                  deps.startTimer === undefined
                    ? Promise.reject(new Error("timers are not available here"))
                    : deps.startTimer(timer),
                )
              : capped,
          );
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

/** Limits match jarvis-pkg's unpack (contracts §7 #7). */
const MAX_UNPACKED = 256 * 1024 * 1024;
const MAX_ENTRIES = 2000;

/** The files and folders of a gzip tar, with each file's sha256. Accepts what
 *  jarvis-pkg's Unpack accepts (ustar/pax, regular files and folders, pax
 *  global headers skipped) and throws on anything else. Pure. */
export function tarListing(
  tar: Buffer,
): Map<string, { kind: "file"; sha256: string } | { kind: "dir" }> {
  const out = new Map<string, { kind: "file"; sha256: string } | { kind: "dir" }>();
  const field = (block: Buffer, start: number, length: number) => {
    const raw = block.subarray(start, start + length);
    const end = raw.indexOf(0);
    return raw.subarray(0, end === -1 ? length : end).toString("utf8");
  };
  const octal = (block: Buffer, start: number, length: number) => {
    const text = field(block, start, length).trim();
    if (!/^[0-7]*$/.test(text)) throw new Error("a tar header has a bad number");
    return text === "" ? 0 : Number.parseInt(text, 8);
  };
  let offset = 0;
  let paxPath: string | undefined;
  let total = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    if (body.length !== size) throw new Error("the tarball is truncated");
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "g") continue;
    if (type === "x") {
      for (const record of body.toString("utf8").split("\n")) {
        const match = /^\d+ path=(.*)$/.exec(record);
        if (match !== null) paxPath = match[1];
      }
      continue;
    }
    const prefix = field(header, 345, 155);
    let name =
      paxPath ?? (prefix === "" ? field(header, 0, 100) : `${prefix}/${field(header, 0, 100)}`);
    paxPath = undefined;
    if (
      name.startsWith("/") ||
      name.split("/").includes("..") ||
      name.includes("\\") ||
      name.includes("\u0000")
    ) {
      throw new Error(`the tarball lists an unsafe name ${JSON.stringify(name)}`);
    }
    name = posix.normalize(name).replace(/\/$/, "");
    if (name === "." || name === "") continue;
    if (out.has(name)) throw new Error(`the tarball lists ${name} twice`);
    if (out.size + 1 > MAX_ENTRIES) throw new Error("the tarball has too many entries");
    if (type === "5") {
      out.set(name, { kind: "dir" });
    } else if (type === "0" || type === "\0") {
      total += size;
      if (total > MAX_UNPACKED) throw new Error("the tarball unpacks too large");
      out.set(name, { kind: "file", sha256: createHash("sha256").update(body).digest("hex") });
    } else {
      throw new Error(`the tarball entry ${name} is not a file or folder`);
    }
  }
  // Parent folders a tar may leave implicit.
  for (const name of [...out.keys()]) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      const known = out.get(parent);
      if (known === undefined) out.set(parent, { kind: "dir" });
      else if (known.kind !== "dir") throw new Error(`${parent} is both a file and a folder`);
    }
  }
  return out;
}

/** deps.verifyUnpacked: `dir` must hold exactly the tarball's entries (no
 *  extra file, no link), each file with the tarball's bytes. */
export async function nodeVerifyUnpacked(tarball: string, dir: string): Promise<void> {
  const packed = await readFileAsync(tarball);
  const tar = await new Promise<Buffer>((resolve, reject) =>
    gunzip(packed, { maxOutputLength: MAX_UNPACKED + 8 * 1024 * 1024 }, (error, out) =>
      error === null ? resolve(out) : reject(error),
    ),
  );
  const expected = tarListing(tar);
  const seen = new Set<string>();
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(posix.join(dir, relative));
    for (const name of entries) {
      const rel = relative === "" ? name : `${relative}/${name}`;
      const want = expected.get(rel);
      if (want === undefined) throw new Error(`${rel} is not part of the artifact`);
      const stat = await lstat(posix.join(dir, rel));
      seen.add(rel);
      if (want.kind === "dir") {
        if (!stat.isDirectory()) throw new Error(`${rel} should be a folder`);
        await walk(rel);
      } else {
        if (!stat.isFile()) throw new Error(`${rel} should be a regular file`);
        if ((await nodeHashFile(posix.join(dir, rel))) !== want.sha256) {
          throw new Error(`${rel} was changed`);
        }
      }
    }
  };
  if (!(await lstat(dir)).isDirectory()) throw new Error("the install folder is missing");
  await walk("");
  for (const name of expected.keys()) {
    if (!seen.has(name)) throw new Error(`${name} is missing`);
  }
}

/** deps.startTimer: runs timerArgv with jarvisd's environment (it reaches the
 *  user manager); rejects with systemd-run's message on failure. */
export function nodeStartTimer(env: NodeJS.ProcessEnv): (timer: TimerRequest) => Promise<void> {
  return (timer) =>
    new Promise((resolve, reject) => {
      const [command, ...args] = timerArgv(timer);
      const child = spawn(command as string, args, { env, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 2_000) stderr += chunk.toString("utf8");
      });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
      timeout.unref();
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `systemd-run exited with ${code ?? "a signal"}`));
      });
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
