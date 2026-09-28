// The per-user run dir that holds the control secret, the published pipe name
// (Windows), the pid lock and the Unix socket — and the file writes into it.
import type { ControlDeps } from "./deps.js";
import { errorCode } from "./deps.js";

/**
 * Unix: the dir must be a real directory (not a symlink), owned by this uid,
 * mode 0700 — its mode is what keeps other users off the socket and the
 * secret. Created 0700 if missing; an existing dir that fails any check is
 * refused rather than repaired, since something other than jarvis made it so.
 * Windows: created if missing; the user profile's ACL does the same job.
 */
export async function ensureRunDirectory(
  platform: NodeJS.Platform,
  runDirectory: string,
  deps: Pick<ControlDeps, "fs" | "process">,
): Promise<void> {
  if (platform === "win32") {
    await deps.fs.mkdir(runDirectory, { recursive: true, mode: 0o700 });
    return;
  }
  let created = false;
  try {
    await deps.fs.lstat(runDirectory);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    await deps.fs.mkdir(runDirectory, { recursive: true, mode: 0o700 });
    created = true;
  }
  const stat = await deps.fs.lstat(runDirectory);
  if (stat.isSymbolicLink()) {
    throw new Error(`The Jarvis run directory ${runDirectory} is a symlink; refusing to use it`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`The Jarvis run directory ${runDirectory} is not a directory`);
  }
  const uid = deps.process.uid();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`The Jarvis run directory ${runDirectory} is owned by another user`);
  }
  // A umask can only take bits away from mkdir's 0700, never add them.
  if (created && (stat.mode & 0o777) !== 0o700) await deps.fs.chmod(runDirectory, 0o700);
  else if ((stat.mode & 0o777) !== 0o700) {
    throw new Error(
      `The Jarvis run directory ${runDirectory} must have mode 0700 (it has ${(stat.mode & 0o777).toString(8)})`,
    );
  }
}

export function tempName(
  path: string,
  deps: Pick<ControlDeps, "randomBytes">,
  suffix: string,
): string {
  return `${path}.${Buffer.from(deps.randomBytes(8)).toString("hex")}.${suffix}`;
}

/**
 * Replaces `path` atomically with a 0600 file holding `content`: written to a
 * fresh temp name with `wx` (so never through anything planted there), then
 * renamed over the target. A reader sees the old file or the new one, never
 * a missing or half-written one; rename replaces a symlink, never follows it.
 */
export async function writePrivateFile(
  path: string,
  content: string,
  deps: Pick<ControlDeps, "fs" | "randomBytes">,
): Promise<void> {
  const temp = tempName(path, deps, "tmp");
  await deps.fs.writeFile(temp, content, { mode: 0o600, flag: "wx" });
  try {
    await deps.fs.rename(temp, path);
  } catch (error) {
    await deps.fs.unlink(temp).catch(() => {});
    throw error;
  }
}

/**
 * Creates `path` holding `content` only if it does not exist — atomically
 * with its content (a hard link of a finished temp file), so no other starter
 * ever reads an empty lock. False if it already exists.
 */
export async function createExclusiveFile(
  path: string,
  content: string,
  deps: Pick<ControlDeps, "fs" | "randomBytes">,
): Promise<boolean> {
  const temp = tempName(path, deps, "tmp");
  await deps.fs.writeFile(temp, content, { mode: 0o600, flag: "wx" });
  try {
    await deps.fs.link(temp, path);
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  } finally {
    await deps.fs.unlink(temp).catch(() => {});
  }
}
