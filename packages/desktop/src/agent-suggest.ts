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
import { builtInCommands } from "./agent-controls.js";
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
  now(): number;
  log(token: string): void;
};

export type AgentCommandInfo = {
  name: string;
  description?: string;
  source: "built-in" | "project" | "account" | "skill";
};
export type AgentFileHit = { path: string; name: string };
export type AgentOpenFileResult =
  | { ok: true }
  | { ok: false; reason: "gone" | "invalid" | "outside" | "missing" | "failed" };
export type AgentResolveResult =
  | { ok: true; path: string }
  | { ok: false; reason: "gone" | "invalid" | "outside" | "missing" };

const MAX_COMMANDS = 200;
const MAX_ENTRIES = 200;
const HEAD_BYTES = 4096;
const FILE_TTL_MS = 10_000;
const MAX_LISTED = 50_000;
const MAX_SHALLOW = 2_000;
const MAX_HITS = 30;
const NAME = /^[A-Za-z][A-Za-z0-9:_-]{0,60}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
const CONTROL = /[\x00-\x1f\x7f]/g;

function describe(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  let body = lines;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    const front = end === -1 ? lines.slice(1) : lines.slice(1, end);
    for (const line of front) {
      const match = /^description:\s*(.+)$/.exec(line.trim());
      if (match?.[1] !== undefined) return tidy(match[1]);
    }
    body = end === -1 ? [] : lines.slice(end + 1);
  }
  for (const line of body) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed === "---") continue;
    return tidy(trimmed);
  }
  return undefined;
}

function tidy(text: string): string | undefined {
  const cleaned = text
    .replaceAll(CONTROL, " ")
    .replace(/^["']|["']$/g, "")
    .trim();
  return cleaned === "" ? undefined : cleaned.slice(0, 120);
}

/** The agent account's config directory, from `<config>/projects/<cwd>/<id>.jsonl`. */
function configDirOf(session: PaneAgentSession): string | undefined {
  const path = session.transcriptPath;
  if (path === undefined) return undefined;
  const projects = dirname(dirname(path));
  return basename(projects) === "projects" ? dirname(projects) : undefined;
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

  /** `.md` files of a commands directory, one folder deep, as `folder:name`. */
  async function commandFiles(
    dir: string,
    realBase: string,
    source: "project" | "account",
  ): Promise<AgentCommandInfo[]> {
    const out: AgentCommandInfo[] = [];
    const walk = async (path: string, prefix: string, depth: number): Promise<void> => {
      let real: string;
      let entries: Awaited<ReturnType<AgentSuggestDeps["fs"]["readdir"]>>;
      try {
        real = await deps.fs.realpath(path);
        if (!isWithin(real, realBase)) return;
        entries = (await deps.fs.readdir(path)).slice(0, MAX_ENTRIES);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isSymlink) continue;
        if (entry.isDirectory && depth < 1) {
          await walk(join(path, entry.name), `${prefix}${entry.name}:`, depth + 1);
        } else if (entry.isFile && entry.name.endsWith(".md")) {
          const name = `${prefix}${entry.name.slice(0, -3)}`;
          if (!NAME.test(name)) continue;
          let text = "";
          try {
            text = await deps.fs.readHead(join(path, entry.name), HEAD_BYTES);
          } catch {
            // A file with no readable head still has a name.
          }
          const description = describe(text);
          out.push({ name, ...(description === undefined ? {} : { description }), source });
        }
      }
    };
    await walk(dir, "", 0);
    return out;
  }

  async function skillDirs(dir: string, realBase: string): Promise<AgentCommandInfo[]> {
    const out: AgentCommandInfo[] = [];
    let entries: Awaited<ReturnType<AgentSuggestDeps["fs"]["readdir"]>>;
    try {
      if (!isWithin(await deps.fs.realpath(dir), realBase)) return out;
      entries = (await deps.fs.readdir(dir)).slice(0, MAX_ENTRIES);
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (entry.isSymlink || !entry.isDirectory || !NAME.test(entry.name)) continue;
      const file = join(dir, entry.name, "SKILL.md");
      try {
        if (!isWithin(await deps.fs.realpath(file), realBase)) continue;
        const description = describe(await deps.fs.readHead(file, HEAD_BYTES));
        out.push({
          name: entry.name,
          ...(description === undefined ? {} : { description }),
          source: "skill",
        });
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

  async function custom(session: PaneAgentSession): Promise<AgentCommandInfo[]> {
    if (session.vendor !== "anthropic") return [];
    const cwd = await rootOf(session);
    const key = `${cwd ?? ""}\0${session.transcriptPath ?? ""}`;
    const cached = customCache.get(key);
    if (cached !== undefined && deps.now() - cached.at < FILE_TTL_MS) return cached.commands;
    const roots: { dir: string; source: "project" | "account" }[] = [];
    if (cwd !== undefined) roots.push({ dir: join(cwd, ".claude"), source: "project" });
    const config = configDirOf(session);
    if (config !== undefined) roots.push({ dir: config, source: "account" });
    const found: AgentCommandInfo[] = [];
    for (const { dir, source } of roots) {
      let realBase: string;
      try {
        realBase = await deps.fs.realpath(dir);
      } catch {
        continue;
      }
      found.push(...(await commandFiles(join(dir, "commands"), realBase, source)));
      found.push(...(await skillDirs(join(dir, "skills"), realBase)));
    }
    const seen = new Set<string>();
    const unique = found
      .filter((c) => !seen.has(c.name) && seen.add(c.name))
      .slice(0, MAX_COMMANDS);
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
        const builtIn = builtInCommands(session.vendor).map(
          (name): AgentCommandInfo => ({ name, source: "built-in" }),
        );
        return { commands: [...builtIn, ...(await custom(session))] };
      } catch {
        log("commands");
        return { commands: [] };
      }
    },

    async names(session) {
      try {
        return new Set((await custom(session)).map((command) => command.name));
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
