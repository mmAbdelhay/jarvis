// Pasted or dropped data that has no path on disk, for the Chat composer:
// written to a private directory of Jarvis's own (0700 directories, 0600
// files), under a name generated here — never one taken from the caller —
// and answered as a path the agent can be told about. Only images, PDFs and
// plain text up to 25 MB; the bytes must look like what the extension says.
// Files older than 7 days are pruned on the way in. Nothing outside the
// base directory is ever written or removed, and nothing is logged but tokens.

import { createHash } from "node:crypto";
import { join } from "node:path";
import type { PaneAgentSession } from "./pane-agent-session.js";

export const AGENT_ATTACH_MAX_BYTES = 25 * 1024 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PRUNE = 500;

export type AgentAttachDeps = {
  /** Jarvis's own private directory for these files. */
  baseDir: string;
  sessions: {
    live(paneKey: unknown): boolean;
    session(paneKey: string): Promise<PaneAgentSession | undefined>;
  };
  fs: {
    /** mkdir -p with the mode applied to every directory it creates. */
    mkdir(path: string, mode: number): Promise<void>;
    /** Creates the file exclusively; rejects when it exists. */
    writeFile(path: string, bytes: Buffer, mode: number): Promise<void>;
    list(path: string): Promise<{ name: string; isDirectory: boolean; mtimeMs: number }[]>;
    remove(path: string): Promise<void>;
  };
  now(): number;
  /** Six lowercase hex characters. */
  random(): string;
  log(token: string): void;
};

export type AgentAttachResult =
  | { ok: true; path: string; name: string; kind: "image" | "file"; ref: string }
  | { ok: false; reason: "gone" | "invalid" | "toolarge" | "failed" };

type Kind = "image" | "file";

const MAGIC: Record<string, (head: Buffer) => boolean> = {
  png: (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  jpg: (b) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  jpeg: (b) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  gif: (b) => b.subarray(0, 4).toString("latin1") === "GIF8",
  webp: (b) =>
    b.subarray(0, 4).toString("latin1") === "RIFF" &&
    b.subarray(8, 12).toString("latin1") === "WEBP",
  heic: (b) => b.subarray(4, 8).toString("latin1") === "ftyp",
  pdf: (b) => b.subarray(0, 4).toString("latin1") === "%PDF",
};
const TEXT = new Set(["txt", "md", "json", "csv", "log"]);
const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic"]);

function kindOf(extension: string, bytes: Buffer): Kind | undefined {
  const magic = MAGIC[extension];
  if (magic !== undefined)
    return magic(bytes) ? (IMAGES.has(extension) ? "image" : "file") : undefined;
  if (TEXT.has(extension)) return bytes.subarray(0, 8192).includes(0) ? undefined : "file";
  return undefined;
}

function stamp(now: number): string {
  const date = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function createAgentAttach(deps: AgentAttachDeps): {
  attach(paneKey: unknown, file: unknown): Promise<AgentAttachResult>;
} {
  function log(token: string): void {
    try {
      deps.log(`agent-attach: ${token}`);
    } catch {
      // Diagnostics cannot break an attachment.
    }
  }

  async function prune(): Promise<void> {
    let seen = 0;
    const cutoff = deps.now() - MAX_AGE_MS;
    try {
      for (const dir of await deps.fs.list(deps.baseDir)) {
        if (!dir.isDirectory || dir.name.includes("/") || dir.name.includes("\\")) continue;
        const path = join(deps.baseDir, dir.name);
        for (const file of await deps.fs.list(path)) {
          if (++seen > MAX_PRUNE) return;
          if (file.isDirectory || file.mtimeMs >= cutoff) continue;
          if (file.name.includes("/") || file.name.includes("\\") || file.name === "..") continue;
          await deps.fs.remove(join(path, file.name));
        }
      }
    } catch {
      log("prune");
    }
  }

  return {
    async attach(paneKey, file) {
      try {
        if (typeof file !== "object" || file === null) return { ok: false, reason: "invalid" };
        const { name, bytes } = file as { name?: unknown; bytes?: unknown };
        if (typeof name !== "string" || name.length > 255 || name.includes("\0")) {
          return { ok: false, reason: "invalid" };
        }
        const data =
          bytes instanceof ArrayBuffer
            ? Buffer.from(bytes)
            : ArrayBuffer.isView(bytes)
              ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
              : undefined;
        if (data === undefined || data.length === 0) return { ok: false, reason: "invalid" };
        if (data.length > AGENT_ATTACH_MAX_BYTES) return { ok: false, reason: "toolarge" };
        const extension = /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1]?.toLowerCase();
        const kind = extension === undefined ? undefined : kindOf(extension, data);
        if (extension === undefined || kind === undefined) return { ok: false, reason: "invalid" };

        if (typeof paneKey !== "string" || !deps.sessions.live(paneKey))
          return { ok: false, reason: "gone" };
        if ((await deps.sessions.session(paneKey)) === undefined)
          return { ok: false, reason: "gone" };

        const folder = join(
          deps.baseDir,
          createHash("sha1").update(paneKey).digest("hex").slice(0, 12),
        );
        await deps.fs.mkdir(deps.baseDir, 0o700);
        await deps.fs.mkdir(folder, 0o700);
        const generated = `${stamp(deps.now())}-${deps.random()}.${extension}`;
        const path = join(folder, generated);
        await deps.fs.writeFile(path, data, 0o600);
        await prune();
        // A path the agent reads as one token: quoted when it has spaces or
        // quote characters, plain otherwise (an image's path is plain text).
        const ref = /[\s"'`$]/.test(path) ? `"${path.replaceAll('"', "")}"` : path;
        return { ok: true, path, name: generated, kind, ref };
      } catch {
        log("write");
        return { ok: false, reason: "failed" };
      }
    },
  };
}
