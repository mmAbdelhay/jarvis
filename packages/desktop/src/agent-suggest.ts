// What the composer offers as you type: `/` commands (the vendor's built-ins
// plus the names and first description line of the custom commands and skills
// in the project and in the agent account's config directory) and `@` files
// (git's list for the project, 10 s cached, a shallow listing outside git).
// Plus the one place a file path from the chat is resolved before it opens:
// inside the pane's project root, after realpath, never an escape.
//
// Everything is bounded, never follows a symlink out of its directory, and
// logs nothing but tokens.

import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isWithin } from "@jarvis/platform";
import { BUILT_IN_COMMANDS } from "./agent-command-tables.js";
import { COMMAND_NAME, parseCommandFile } from "./agent-command-files.js";
import type { PaneAgentSession } from "./pane-agent-session.js";

export type AgentSuggestDeps = {
  sessions: {
    session(paneKey: string, fresh?: boolean): Promise<PaneAgentSession | undefined>;
    live(paneKey: unknown): boolean;
  };
  fs: {
    readdir(
      path: string,
    ): Promise<{ name: string; isDirectory: boolean; isFile: boolean; isSymlink: boolean }[]>;
    /** The first `bytes` of a file, as text. */
    readHead(path: string, bytes: number): Promise<string>;
    realpath(path: string): Promise<string>;
    isFile(path: string): Promise<boolean>;
  };
  /** Runs git in `cwd`; its stdout, or undefined when it is not a repository or fails. */
  git(cwd: string, args: string[]): Promise<string | undefined>;
  /** Where the agent works when its process's cwd could not be read: the cwd
   *  recorded in its transcript, then the pane's project path. */
  fallbackCwd?(session: PaneAgentSession): Promise<string | undefined>;
  /** The user's home directory, for the account-level folders. */
  home?: string;
  /** CODEX_HOME and the like. */
  env?: Record<string, string | undefined>;
  now(): number;
  log(token: string): void;
};

export type AgentCommandInfo = {
  name: string;
  description?: string;
  /** What the argument looks like (`[name]`), shown as a quiet line. */
  hint?: string;
  aliases?: string[];
  /** Words the CLI documents for the argument. */
  choices?: string[];
  /** `$` for a Codex skill, which is typed after `$` and shown in `/` too. */
  trigger?: "$";
  source: "built-in" | "project" | "account" | "skill" | "plugin";
};
export type AgentFileHit = { path: string; name: string };
export type AgentOpenFileResult =
  | { ok: true }
  | { ok: false; reason: "gone" | "invalid" | "outside" | "missing" | "failed" };
export type AgentResolveResult =
  | { ok: true; path: string }
  | { ok: false; reason: "gone" | "invalid" | "outside" | "missing" };

const MAX_COMMANDS = 1000;
const MAX_ENTRIES = 1000;
const HEAD_BYTES = 4096;
const JSON_BYTES = 262_144;
const FILE_TTL_MS = 10_000;
const MAX_LISTED = 50_000;
const MAX_SHALLOW = 2_000;
const MAX_HITS = 30;
const MAX_LEVELS = 12;
const NAME = COMMAND_NAME;

type Entry = { name: string; isDirectory: boolean; isFile: boolean; isSymlink: boolean };

/** The agent account's config directory, from `<config>/projects/<cwd>/<id>.jsonl`. */
function configDirOf(session: PaneAgentSession): string | undefined {
  const path = session.transcriptPath;
  if (path === undefined) return undefined;
  const projects = dirname(dirname(path));
  return basename(projects) === "projects" ? dirname(projects) : undefined;
}

/** CODEX_HOME of a rollout under `<home>/sessions/...`. */
function codexHomeOf(session: PaneAgentSession): string | undefined {
  let at = session.transcriptPath;
  if (at === undefined) return undefined;
  for (let level = 0; level < 6; level++) {
    const parent = dirname(at);
    if (parent === at) return undefined;
    if (basename(parent) === "sessions") return dirname(parent);
    at = parent;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function createAgentSuggest(deps: AgentSuggestDeps): {
  commands(paneKey: unknown): Promise<{ commands: AgentCommandInfo[] }>;
  names(session: PaneAgentSession): Promise<ReadonlySet<string>>;
  files(paneKey: unknown, query: unknown): Promise<{ files: AgentFileHit[] }>;
  resolve(paneKey: unknown, path: unknown): Promise<AgentResolveResult>;
} {
  const customCache = new Map<string, { at: number; commands: AgentCommandInfo[] }>();
  const fileCache = new Map<string, { at: number; list: string[] }>();

  function log(token: string): void {
    try {
      deps.log(`agent-suggest: ${token}`);
    } catch {
      // Diagnostics cannot break a suggestion.
    }
  }

  async function sessionOf(paneKey: unknown): Promise<PaneAgentSession | undefined> {
    if (typeof paneKey !== "string" || !deps.sessions.live(paneKey)) return undefined;
    return deps.sessions.session(paneKey);
  }

  async function metaOf(path: string): Promise<ReturnType<typeof parseCommandFile>> {
    try {
      return parseCommandFile(await deps.fs.readHead(path, HEAD_BYTES));
    } catch {
      // A file with no readable head still has a name.
      return { hidden: false };
    }
  }

  function row(
    name: string,
    meta: ReturnType<typeof parseCommandFile>,
    source: AgentCommandInfo["source"],
    trigger?: "$",
  ): AgentCommandInfo {
    return {
      name,
      ...(meta.description === undefined ? {} : { description: meta.description }),
      ...(meta.hint === undefined ? {} : { hint: meta.hint }),
      ...(trigger === undefined ? {} : { trigger }),
      source,
    };
  }

  async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
    try {
      return asRecord(JSON.parse(await deps.fs.readHead(path, JSON_BYTES)));
    } catch {
      return undefined;
    }
  }

  /** `.md` files of a commands directory, one folder deep, as `folder:name`. */
  async function commandFiles(
    dir: string,
    realBase: string,
    source: AgentCommandInfo["source"],
    prefix = "",
    depthLimit = 1,
  ): Promise<AgentCommandInfo[]> {
    const out: AgentCommandInfo[] = [];
    const walk = async (path: string, folder: string, depth: number): Promise<void> => {
      let entries: Entry[];
      try {
        if (!isWithin(await deps.fs.realpath(path), realBase)) return;
        entries = (await deps.fs.readdir(path)).slice(0, MAX_ENTRIES);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (out.length >= MAX_COMMANDS) return;
        if (entry.isSymlink) continue;
        if (entry.isDirectory && depth < depthLimit) {
          await walk(join(path, entry.name), `${folder}${entry.name}:`, depth + 1);
        } else if (entry.isFile && entry.name.endsWith(".md")) {
          const base = `${folder}${entry.name.slice(0, -3)}`;
          if (!NAME.test(base)) continue;
          const meta = await metaOf(join(path, entry.name));
          if (meta.hidden) continue;
          const name = `${prefix}${meta.name ?? base}`;
          if (NAME.test(name)) out.push(row(name, meta, source));
        }
      }
    };
    await walk(dir, "", 0);
    return out;
  }

  /** `<dir>/<skill>/SKILL.md`. A symlinked skill directory is followed only when `follow`. */
  async function skillDirs(
    dir: string,
    realBase: string,
    options: {
      follow?: boolean;
      prefix?: string;
      trigger?: "$";
      source?: AgentCommandInfo["source"];
    } = {},
  ): Promise<AgentCommandInfo[]> {
    const out: AgentCommandInfo[] = [];
    let entries: Entry[];
    try {
      if (!isWithin(await deps.fs.realpath(dir), realBase)) return out;
      entries = (await deps.fs.readdir(dir)).slice(0, MAX_ENTRIES);
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (out.length >= MAX_COMMANDS) break;
      if (!NAME.test(entry.name)) continue;
      let root: string;
      let base: string;
      try {
        if (entry.isSymlink) {
          if (options.follow !== true) continue;
          root = await deps.fs.realpath(join(dir, entry.name));
          base = root;
        } else if (entry.isDirectory) {
          root = join(dir, entry.name);
          base = realBase;
        } else continue;
        const file = join(root, "SKILL.md");
        if (!isWithin(await deps.fs.realpath(file), base)) continue;
        const meta = parseCommandFile(await deps.fs.readHead(file, HEAD_BYTES));
        if (meta.hidden) continue;
        const name = `${options.prefix ?? ""}${meta.name ?? entry.name}`;
        if (NAME.test(name)) out.push(row(name, meta, options.source ?? "skill", options.trigger));
      } catch {
        // No SKILL.md here.
      }
    }
    return out;
  }

  /** The session's working directory: its process's, else the fallback's. */
  async function rootOf(session: PaneAgentSession): Promise<string | undefined> {
    if (session.cwd !== null) return session.cwd;
    try {
      return await deps.fallbackCwd?.(session);
    } catch {
      return undefined;
    }
  }

  /** `cwd` and every parent up to (and including) the git root. */
  async function ancestors(cwd: string): Promise<string[]> {
    const out: string[] = [];
    let at = resolve(cwd);
    for (let level = 0; level < MAX_LEVELS; level++) {
      out.push(at);
      try {
        await deps.fs.realpath(join(at, ".git"));
        return out;
      } catch {
        // Not the root yet.
      }
      const parent = dirname(at);
      if (parent === at) break;
      at = parent;
    }
    return [out[0] ?? cwd];
  }

  async function realOrUndefined(path: string): Promise<string | undefined> {
    try {
      return await deps.fs.realpath(path);
    } catch {
      return undefined;
    }
  }

  async function claudePlugins(
    config: string,
    cwd: string | undefined,
    chain: string[],
  ): Promise<AgentCommandInfo[]> {
    const installed = asRecord(
      (await readJson(join(config, "plugins", "installed_plugins.json")))?.["plugins"],
    );
    if (installed === undefined) return [];
    const enabled = new Map<string, boolean>();
    const settingsFiles = [
      join(config, "settings.json"),
      ...[...chain]
        .reverse()
        .flatMap((dir) => [
          join(dir, ".claude", "settings.json"),
          join(dir, ".claude", "settings.local.json"),
        ]),
    ];
    for (const file of settingsFiles) {
      const map = asRecord((await readJson(file))?.["enabledPlugins"]);
      if (map === undefined) continue;
      for (const [key, value] of Object.entries(map)) {
        if (typeof value === "boolean") enabled.set(key, value);
      }
    }
    const out: AgentCommandInfo[] = [];
    for (const [key, value] of Object.entries(installed).slice(0, 200)) {
      if (enabled.get(key) !== true) continue;
      const pluginName = key.split("@")[0] ?? "";
      if (!NAME.test(pluginName)) continue;
      const entries = Array.isArray(value) ? value : [value];
      const entry = entries.map(asRecord).find((candidate) => {
        if (candidate === undefined || typeof candidate["installPath"] !== "string") return false;
        const scope = candidate["scope"];
        if (scope !== "project" && scope !== "local") return true;
        const projectPath = candidate["projectPath"];
        return (
          cwd !== undefined &&
          typeof projectPath === "string" &&
          isWithin(resolve(cwd), resolve(projectPath))
        );
      });
      const installPath = entry?.["installPath"];
      if (typeof installPath !== "string" || !isAbsolute(installPath)) continue;
      const real = await realOrUndefined(installPath);
      if (real === undefined) continue;
      const manifest = await readJson(join(installPath, ".claude-plugin", "plugin.json"));
      const listed = (field: unknown): string[] =>
        (typeof field === "string" ? [field] : Array.isArray(field) ? field : [])
          .filter((item): item is string => typeof item === "string")
          .slice(0, 8)
          .map((item) => resolve(installPath, item))
          .filter((path) => isWithin(path, resolve(installPath)));
      const commandDirs = [join(installPath, "commands"), ...listed(manifest?.["commands"])];
      const skillRoots = [join(installPath, "skills"), ...listed(manifest?.["skills"])];
      for (const commandDir of commandDirs) {
        out.push(...(await commandFiles(commandDir, real, "plugin", `${pluginName}:`)));
      }
      for (const skillRoot of skillRoots) {
        out.push(
          ...(await skillDirs(skillRoot, real, { prefix: `${pluginName}:`, source: "plugin" })),
        );
      }
    }
    return out;
  }

  async function discover(session: PaneAgentSession): Promise<AgentCommandInfo[]> {
    const cwd = await rootOf(session);
    const chain = cwd === undefined ? [] : await ancestors(cwd);
    const found: AgentCommandInfo[] = [];
    if (session.vendor === "anthropic") {
      for (const dir of chain) {
        const base = join(dir, ".claude");
        const realBase = await realOrUndefined(base);
        if (realBase === undefined) continue;
        found.push(...(await commandFiles(join(base, "commands"), realBase, "project")));
        found.push(...(await skillDirs(join(base, "skills"), realBase)));
      }
      const config =
        configDirOf(session) ?? (deps.home === undefined ? undefined : join(deps.home, ".claude"));
      if (config !== undefined) {
        const realBase = await realOrUndefined(config);
        if (realBase !== undefined) {
          found.push(...(await commandFiles(join(config, "commands"), realBase, "account")));
          found.push(...(await skillDirs(join(config, "skills"), realBase, { follow: true })));
          found.push(...(await claudePlugins(config, cwd, chain)));
        }
      }
    } else if (session.vendor === "openai") {
      const codexHome =
        codexHomeOf(session) ??
        deps.env?.["CODEX_HOME"] ??
        (deps.home === undefined ? undefined : join(deps.home, ".codex"));
      if (codexHome !== undefined && isAbsolute(codexHome)) {
        const realBase = await realOrUndefined(codexHome);
        if (realBase !== undefined) {
          found.push(
            ...(await commandFiles(join(codexHome, "prompts"), realBase, "account", "prompts:", 0)),
          );
        }
        const roots: { dir: string; follow: boolean }[] = [
          { dir: join(codexHome, "skills"), follow: true },
        ];
        if (deps.home !== undefined)
          roots.push({ dir: join(deps.home, ".agents", "skills"), follow: true });
        for (const dir of chain) roots.push({ dir: join(dir, ".agents", "skills"), follow: false });
        for (const { dir, follow } of roots) {
          const realDir = await realOrUndefined(dir);
          if (realDir !== undefined)
            found.push(...(await skillDirs(dir, realDir, { follow, trigger: "$" })));
        }
      }
    } else {
      const roots: { dir: string; follow: boolean }[] = [];
      for (const dir of chain) {
        for (const sub of [".github", ".agents", ".claude"])
          roots.push({ dir: join(dir, sub, "skills"), follow: false });
      }
      if (deps.home !== undefined) {
        roots.push({ dir: join(deps.home, ".copilot", "skills"), follow: true });
        roots.push({ dir: join(deps.home, ".agents", "skills"), follow: true });
      }
      for (const { dir, follow } of roots) {
        const realDir = await realOrUndefined(dir);
        if (realDir !== undefined) found.push(...(await skillDirs(dir, realDir, { follow })));
      }
    }
    const seen = new Set<string>();
    return found
      .filter((c) => {
        const key = `${c.trigger ?? "/"}${c.name}`;
        return !seen.has(key) && seen.add(key);
      })
      .slice(0, MAX_COMMANDS);
  }

  async function custom(session: PaneAgentSession): Promise<AgentCommandInfo[]> {
    const cwd = await rootOf(session);
    const key = `${session.vendor}\0${cwd ?? ""}\0${session.transcriptPath ?? ""}`;
    const cached = customCache.get(key);
    if (cached !== undefined && deps.now() - cached.at < FILE_TTL_MS) return cached.commands;
    const unique = await discover(session);
    customCache.set(key, { at: deps.now(), commands: unique });
    if (customCache.size > 16) customCache.delete(customCache.keys().next().value as string);
    return unique;
  }

  async function shallow(root: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
      let entries: Awaited<ReturnType<AgentSuggestDeps["fs"]["readdir"]>>;
      try {
        entries = await deps.fs.readdir(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (out.length >= MAX_SHALLOW) return;
        if (entry.isSymlink || entry.name.startsWith(".") || entry.name === "node_modules")
          continue;
        if (entry.isDirectory && depth < 1)
          await walk(join(dir, entry.name), `${prefix}${entry.name}/`, depth + 1);
        else if (entry.isFile) out.push(`${prefix}${entry.name}`);
      }
    };
    await walk(root, "", 0);
    return out;
  }

  async function listing(root: string): Promise<string[]> {
    const cached = fileCache.get(root);
    if (cached !== undefined && deps.now() - cached.at < FILE_TTL_MS) return cached.list;
    const out = await deps.git(root, [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ]);
    const list =
      out === undefined
        ? await shallow(root)
        : out
            .split("\0")
            .filter(
              (path) => path !== "" && !isAbsolute(path) && !path.split(/[\\/]/).includes(".."),
            )
            .slice(0, MAX_LISTED);
    fileCache.set(root, { at: deps.now(), list });
    if (fileCache.size > 16) fileCache.delete(fileCache.keys().next().value as string);
    return list;
  }

  return {
    async commands(paneKey) {
      try {
        const session = await sessionOf(paneKey);
        if (session === undefined) return { commands: [] };
        const builtIn = BUILT_IN_COMMANDS[session.vendor].map(
          (command): AgentCommandInfo => ({
            name: command.name,
            description: command.description,
            ...(command.hint === undefined ? {} : { hint: command.hint }),
            ...(command.aliases === undefined ? {} : { aliases: [...command.aliases] }),
            ...(command.choices === undefined ? {} : { choices: [...command.choices] }),
            source: "built-in",
          }),
        );
        return { commands: [...builtIn, ...(await custom(session))] };
      } catch {
        log("commands");
        return { commands: [] };
      }
    },

    async names(session) {
      try {
        return new Set(
          (await custom(session))
            .filter((command) => command.trigger === undefined)
            .map((command) => command.name),
        );
      } catch {
        log("names");
        return new Set();
      }
    },

    async files(paneKey, query) {
      try {
        if (typeof query !== "string") return { files: [] };
        const session = await sessionOf(paneKey);
        const cwd = session === undefined ? undefined : await rootOf(session);
        if (cwd === undefined) return { files: [] };
        const needle = query.slice(0, 100).toLowerCase();
        const ranked: { path: string; tier: number }[] = [];
        for (const path of await listing(cwd)) {
          const lower = path.toLowerCase();
          const base = lower.slice(lower.lastIndexOf("/") + 1);
          const tier = base.startsWith(needle)
            ? 0
            : base.includes(needle)
              ? 1
              : lower.includes(needle)
                ? 2
                : -1;
          if (tier !== -1) ranked.push({ path, tier });
        }
        ranked.sort(
          (a, b) => a.tier - b.tier || a.path.length - b.path.length || (a.path < b.path ? -1 : 1),
        );
        return {
          files: ranked.slice(0, MAX_HITS).map(({ path }) => ({ path, name: basename(path) })),
        };
      } catch {
        log("files");
        return { files: [] };
      }
    },

    async resolve(paneKey, path) {
      if (typeof path !== "string" || path === "" || path.length > 4096 || path.includes("\0")) {
        return { ok: false, reason: "invalid" };
      }
      try {
        const session = await sessionOf(paneKey);
        const cwd = session === undefined ? undefined : await rootOf(session);
        if (cwd === undefined) return { ok: false, reason: "gone" };
        const root = resolve(cwd);
        const candidate = resolve(root, path);
        // Lexical first: a path that leaves the root never reaches the disk.
        if (!isWithin(candidate, root)) return { ok: false, reason: "outside" };
        let realRoot: string;
        let real: string;
        try {
          realRoot = await deps.fs.realpath(root);
          real = await deps.fs.realpath(candidate);
        } catch {
          return { ok: false, reason: "missing" };
        }
        if (!isWithin(real, realRoot)) return { ok: false, reason: "outside" };
        if (!(await deps.fs.isFile(real))) return { ok: false, reason: "missing" };
        return { ok: true, path: real };
      } catch {
        log("resolve");
        return { ok: false, reason: "gone" };
      }
    },
  };
}
