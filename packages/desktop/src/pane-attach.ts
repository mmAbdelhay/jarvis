import { join } from "node:path";
import type { ExternalAgentProcess } from "@jarvis/platform";
import { isFileId, type AttachUploadResult, type TerminalPaneInfo } from "@jarvis/wire";
import type { UploadStore } from "./file-upload.js";
import { MESSAGES } from "./messages.js";

export const ATTACH_EXTENSIONS: Record<string, string> = {
  "image/jpg": "jpg",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "application/json": "json",
  "text/csv": "csv",
  "text/x-log": "log",
  "application/zip": "zip",
};

/** Metadata supplies only an allowlisted extension, never any part of a
 *  directory or basename. NUL-bearing names are ignored wholesale. */
export function attachFileName(
  now: number,
  hex6: string,
  contentType: string,
  originalName: string,
): string {
  const suffix = originalName.includes("\0")
    ? undefined
    : /\.([a-z]+)$/i.exec(originalName)?.[1]?.toLowerCase();
  const extension = Object.hasOwn(ATTACH_EXTENSIONS, contentType)
    ? ATTACH_EXTENSIONS[contentType]
    : suffix !== undefined && [...Object.values(ATTACH_EXTENSIONS), "jpeg"].includes(suffix)
      ? suffix
      : "bin";
  const date = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${day}-${time}-${hex6}.${extension}`;
}

type PaneAttachCwdDeps = {
  panes(): readonly TerminalPaneInfo[];
  /** A fresh process scan. */
  scanAgents(): Promise<readonly ExternalAgentProcess[]>;
  agents(): readonly { id: string; vendor?: string }[];
  paneStartDir(paneKey: string): string | undefined;
};

/**
 * Where an attachment for a pane goes: the Claude process's own cwd in that
 * pane, else the directory the pane's tab was opened in — and nowhere at
 * all for a pane that is gone or exited, whose start directory is only a
 * memory of a shell that no longer runs.
 */
export function createPaneAttachCwd(
  deps: PaneAttachCwdDeps,
): (paneKey: string) => Promise<string | undefined> {
  return async (paneKey) => {
    try {
      if (!deps.panes().some((pane) => pane.paneKey === paneKey && !pane.exited)) {
        return undefined;
      }
    } catch {
      return undefined;
    }
    try {
      const agents = deps.agents();
      const claude = (await deps.scanAgents()).find(
        (candidate) =>
          candidate.terminalPaneKey === paneKey &&
          candidate.foreground !== false &&
          candidate.cwd !== null &&
          agents.find((agent) => agent.id === candidate.agentId)?.vendor === "anthropic",
      );
      if (claude?.cwd) return claude.cwd;
    } catch {
      // No scan: the pane's own directory is still a safe answer.
    }
    return deps.paneStartDir(paneKey);
  };
}

type PaneAttachDeps = {
  uploads: Pick<UploadStore, "resolve" | "release">;
  /** Claude process cwd, falling back to the tab's project directory. */
  cwdFor(paneKey: string): Promise<string | undefined>;
  fs: {
    mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
    writeFile(
      path: string,
      bytes: string | Uint8Array,
      options: { flag: "wx"; mode: number },
    ): Promise<unknown>;
    realpath(path: string): Promise<string>;
    lstat(path: string): Promise<{ isSymbolicLink(): boolean }>;
    chmod(path: string, mode: number): Promise<unknown>;
    rm(path: string, options: { force: true }): Promise<unknown>;
  };
  /** The app's language, for the generic errors the phone shows. */
  language: "ar" | "en";
  now(): number;
  /** Byte count: randomHex(3) returns six lowercase hex characters. */
  randomHex(n: number): string;
  log(token: string): void;
};

export function createPaneAttach(deps: PaneAttachDeps): {
  attach(deviceId: string, paneKey: unknown, fileId: unknown): Promise<AttachUploadResult>;
} {
  function failure(
    token: string,
    error = MESSAGES.fileUploadFailed(deps.language),
  ): AttachUploadResult {
    try {
      deps.log(`pane-attach: ${token}`);
    } catch {
      // Diagnostics cannot break attachment or reveal dependency errors.
    }
    return { ok: false, error };
  }

  /** What sits at `path`, without following a symlink there. */
  async function entryKind(path: string): Promise<"missing" | "symlink" | "present"> {
    try {
      return (await deps.fs.lstat(path)).isSymbolicLink() ? "symlink" : "present";
    } catch (error) {
      if (errorCode(error) === "ENOENT") return "missing";
      throw error;
    }
  }

  return {
    async attach(deviceId, paneKey, fileId) {
      if (typeof paneKey !== "string" || paneKey.length === 0 || !isFileId(fileId)) {
        return failure("invalid");
      }
      try {
        const upload = await deps.uploads.resolve(deviceId, fileId);
        if (upload === undefined)
          return failure("notfound", MESSAGES.fileUploadNotFound(deps.language));
        const cwd = await deps.cwdFor(paneKey);
        if (cwd === undefined || cwd.length === 0) return failure("cwd");
        const parent = join(cwd, ".jarvis");
        const directory = join(parent, "uploads");
        // mkdir -p follows a symlink it finds on the way, so one at .jarvis
        // would have it create directories wherever that points. Refuse
        // before creating anything.
        const parentKind = await entryKind(parent);
        if (
          parentKind === "symlink" ||
          (parentKind === "present" && (await entryKind(directory)) === "symlink")
        ) {
          return failure("directory");
        }
        await deps.fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const [cwdReal, directoryReal, stat] = await Promise.all([
          deps.fs.realpath(cwd),
          deps.fs.realpath(directory),
          deps.fs.lstat(directory),
        ]);
        // Check before even writing .gitignore: a redirected parent or a
        // symlink at uploads must never receive any attachment bytes.
        if (stat.isSymbolicLink() || directoryReal !== join(cwdReal, ".jarvis", "uploads")) {
          return failure("directory");
        }
        // mkdir's mode is masked by the umask and never touches a directory
        // that already existed: set it outright, now that it is known ours.
        await deps.fs.chmod(directory, 0o700);
        try {
          await deps.fs.writeFile(join(directory, ".gitignore"), "*\n", {
            flag: "wx",
            mode: 0o600,
          });
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
        }
        const hex = deps.randomHex(3);
        if (!/^[a-f0-9]{6}$/.test(hex)) return failure("random");
        const name = attachFileName(deps.now(), hex, upload.contentType, upload.name);
        // Exclusive creation refuses existing files and symlinks. Keep the
        // staged copy on every failed write so the phone can retry.
        const path = join(directory, name);
        try {
          await deps.fs.writeFile(path, upload.bytes, { flag: "wx", mode: 0o600 });
        } catch (error) {
          // A write that failed part-way leaves a truncated file behind;
          // EEXIST means the file was never ours to remove.
          if (errorCode(error) !== "EEXIST") {
            await deps.fs.rm(path, { force: true }).catch(() => undefined);
          }
          throw error;
        }
        await deps.uploads.release(deviceId, fileId);
        return { ok: true, path: `.jarvis/uploads/${name}` };
      } catch {
        return failure("failed");
      }
    },
  };
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}
