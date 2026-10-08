// Where the Jarvis OS daemon finds things (contracts §1, §4). Pure.
//
// No electron here (core/no-electron.test.ts).
// posix paths throughout: this daemon runs on Linux only, and the tests that
// pin these strings run on every OS.
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { readBuildId } from "../build-id.js";

/** The bundle's stamp is {"build": string} (contracts §6 #6: the shell reads
 *  the same file and sends that string in its hello). From tsc's dist the
 *  stamp is the app's {version, commit?, builtAt}; readBuildId formats it. */
export function readOsBuildId(
  path: string,
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): string {
  try {
    const value: unknown = JSON.parse(read(path));
    if (typeof value === "object" && value !== null) {
      const build = (value as Record<string, unknown>)["build"];
      if (typeof build === "string") return build.length > 0 && build.length <= 256 ? build : "dev";
    }
  } catch {
    return "dev";
  }
  return readBuildId(path, read);
}

export const DEFAULT_MCP_DIR = "/usr/lib/jarvis/mcp";

export function mcpDirFrom(env: { JARVIS_MCP_DIR?: string | undefined }): string {
  return env.JARVIS_MCP_DIR !== undefined && env.JARVIS_MCP_DIR !== ""
    ? env.JARVIS_MCP_DIR
    : DEFAULT_MCP_DIR;
}

export function osConfigPath(home: string): string {
  return posix.join(home, ".config", "jarvis", "jarvis.yaml");
}

/** Beside the bundle (/usr/lib/jarvis/daemon/build-stamp.json), then tsc's
 *  layout (dist/src/daemon/os/ -> dist/build-stamp.json). */
export function buildStampCandidates(scriptDir: string): string[] {
  return [
    posix.join(scriptDir, "build-stamp.json"),
    posix.join(scriptDir, "..", "..", "..", "build-stamp.json"),
  ];
}

/** World-readable, written atomically by the installer backend and
 *  jarvis-model-fetch (M2 contracts §5). */
export const MODEL_STATE_PATH = "/var/lib/jarvis/model-state.json";

/** M2.5 contracts §3: one registration file per installed add-on server. */
export function mcpConfigDir(home: string): string {
  return posix.join(home, ".config", "jarvis", "mcp.d");
}

/** M2.5 contracts §7 #2: the signature-checked index, written only by jarvis-pkg. */
export function registryIndexPath(home: string): string {
  return posix.join(home, ".cache", "jarvis", "registry", "index.verified.json");
}

/** Design §3.9: the encrypted memory store. */
export function memoryDbPath(home: string): string {
  return posix.join(home, ".local", "share", "jarvis", "memory.sqlite");
}

/** Design §3.8: the embedding cache for tool search. */
export function toolIndexPath(home: string): string {
  return posix.join(home, ".cache", "jarvis", "tool-index.sqlite");
}

/** Rafiq M3 §3: the only program whose sys:setLocked is accepted. */
export const LOCK_CLIENT_PATH = "/usr/bin/jarvis-lock";

/** Per-login tmpfs; undefined without an absolute $XDG_RUNTIME_DIR (then the
 *  lock state is memory-only). */
export function lockStatePath(env: { XDG_RUNTIME_DIR?: string | undefined }): string | undefined {
  const dir = env.XDG_RUNTIME_DIR;
  if (dir === undefined || !posix.isAbsolute(dir)) return undefined;
  return posix.join(dir, "jarvis", "lock-state.json");
}

/** M2 contracts §4 + M4 §1: the model catalog; its role "backup" entry is the backup brain. */
export const MODEL_CATALOG_PATH = "/usr/share/jarvis/models/catalog.json";
