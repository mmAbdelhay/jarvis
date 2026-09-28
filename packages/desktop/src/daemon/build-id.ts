// The build a control handshake compares (control/server.ts): the app and
// jarvisd must be the same build, or the daemon answers restart-required and
// the app restarts it, so an update takes effect.
//
// `pnpm build` writes dist/build-stamp.json (scripts/build-stamp.mjs): the
// package version, the git commit when there is one, and the build time.
// The time is what makes every rebuild a new build, committed or not. The
// app and the daemon ship in the same dist, so they read the same stamp.
//
// No electron here (core/no-electron.test.ts).
import { readFileSync } from "node:fs";

/** The control transport's cap on a build string. */
const MAX_BUILD_LENGTH = 256;

export type BuildStamp = { version: string; commit?: string; builtAt: string };

export function formatBuildId(stamp: BuildStamp): string {
  const id = `${stamp.version}+${stamp.commit ?? "nogit"}.${stamp.builtAt}`;
  return id.slice(0, MAX_BUILD_LENGTH);
}

function parseStamp(value: unknown): BuildStamp | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { version, commit, builtAt } = value as Record<string, unknown>;
  if (typeof version !== "string" || typeof builtAt !== "string") return undefined;
  if (commit !== undefined && typeof commit !== "string") return undefined;
  return { version, builtAt, ...(commit === undefined ? {} : { commit }) };
}

/** The build id from the stamp at `path`; "dev" when there is none (a run
 *  from sources that were never built with `pnpm build`). */
export function readBuildId(path: string, read: (path: string) => string = readText): string {
  try {
    const stamp = parseStamp(JSON.parse(read(path)));
    if (stamp !== undefined) return formatBuildId(stamp);
  } catch {
    // Missing or unreadable: the fallback below.
  }
  return "dev";
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}
