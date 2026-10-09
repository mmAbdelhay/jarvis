// ~/.local/state/jarvis/audit.jsonl (spec §5): one line per confirm/password
// item. Entries arrive already masked by RiskGate; this file only stores,
// rotates (one generation, audit.jsonl.1) and reads them back newest first.
import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { dirname, posix } from "node:path";
import { type AuditEntry, type AuditQuery, parseAuditEntry } from "@jarvis/core";

export const MAX_AUDIT_BYTES = 5 * 1024 * 1024;

export type AuditFs = {
  appendFile(path: string, text: string): Promise<void>;
  readFile(path: string): Promise<string>;
  size(path: string): Promise<number>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
};

export const nodeAuditFs: AuditFs = {
  appendFile: (path, text) => appendFile(path, text, { encoding: "utf8", mode: 0o600 }),
  readFile: (path) => readFile(path, "utf8"),
  size: async (path) => {
    try {
      return (await stat(path)).size;
    } catch {
      return 0;
    }
  },
  rename: (from, to) => rename(from, to),
  mkdir: async (path) => {
    await mkdir(path, { recursive: true, mode: 0o700 });
  },
};

export type AuditLog = {
  append(entry: AuditEntry): Promise<void>;
  list(query: AuditQuery): Promise<AuditEntry[]>;
};

export function auditLogPath(env: { XDG_STATE_HOME?: string | undefined }, home: string): string {
  // posix: the audit log is a Jarvis OS (Linux) path, and its test runs on every OS.
  const state =
    env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME !== ""
      ? env.XDG_STATE_HOME
      : posix.join(home, ".local", "state");
  return posix.join(state, "jarvis", "audit.jsonl");
}

export function createAuditLog(options: {
  path: string;
  fs: AuditFs;
  maxBytes?: number;
}): AuditLog {
  const { path, fs } = options;
  const maxBytes = options.maxBytes ?? MAX_AUDIT_BYTES;
  let chain: Promise<void> = Promise.resolve();

  async function readEntries(file: string): Promise<AuditEntry[]> {
    let text: string;
    try {
      text = await fs.readFile(file);
    } catch {
      return [];
    }
    const entries: AuditEntry[] = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = parseAuditEntry(JSON.parse(line));
        if (parsed !== undefined) entries.push(parsed);
      } catch {
        // A torn or hand-edited line: skipped, the rest still read.
      }
    }
    return entries;
  }

  return {
    append(entry) {
      const line = `${JSON.stringify(entry)}\n`;
      const run = chain.then(async () => {
        await fs.mkdir(dirname(path));
        const size = await fs.size(path);
        if (size > 0 && size + new TextEncoder().encode(line).length > maxBytes) {
          await fs.rename(path, `${path}.1`);
        }
        await fs.appendFile(path, line);
      });
      chain = run.catch(() => {});
      return run;
    },
    async list(query) {
      const all = [...(await readEntries(`${path}.1`)), ...(await readEntries(path))];
      const filtered =
        query.beforeTs === undefined ? all : all.filter((e) => e.ts < (query.beforeTs as number));
      return filtered
        .map((e, index) => ({ e, index }))
        .sort((a, b) => b.e.ts - a.e.ts || b.index - a.index)
        .slice(0, query.limit)
        .map(({ e }) => e);
    },
  };
}
