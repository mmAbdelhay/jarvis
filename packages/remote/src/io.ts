// Everything the bridge touches outside its own pure logic — the clock, a
// CSPRNG, the filesystem, sockets — arrives through these types rather than
// through `node:fs`/`node:crypto`/a real `ws` socket directly. That is what
// lets every other module in this package be tested without a real clock,
// a real disk or a real network: a caller hands in `fakeClock()`/`memoryFs()`
// (the doubles) in tests and the real thing (node-io.ts, M4+) in production.

export type RandomBytes = (size: number) => Buffer;
export type Clock = () => number;

// Node's `setTimeout` returns a `Timeout` object; a fake clock can return a
// plain number. `unknown` is the only type both satisfy, so callers only get
// to pass a handle back to `clearTimeout` — never to inspect it.
export type Timers = {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type RemoteFs = {
  readFile(path: string): Promise<string>;
  /** Exclusive create (POSIX `wx`): rejects if `path` already exists. */
  writeFile(path: string, data: string, mode: number): Promise<void>;
  appendFile(path: string, data: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Recursive, matching `fs.mkdir(path, { recursive: true, mode })`. */
  mkdir(path: string, mode: number): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  stat(path: string): Promise<{ mode: number }>;
  unlink(path: string): Promise<void>;
};

export type SocketLike = {
  send(text: string): void;
  close(code: number, reason: string): void;
  terminate(): void;
  readonly bufferedAmount: number;
};

export type SessionHandlers = {
  onText(text: string): void;
  /** A binary WebSocket frame's payload — a blob chunk on `/rpc`; ignored on `/pair` (M4 behaviour, M8 rule 9). */
  onBinary(data: Uint8Array): void;
  onClose(code: number): void;
};

/** True only for Node's "no such file or directory" — never any other failure. */
export function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}

/** A message safe to log: an Error's own message, or a last-resort String() of anything else. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Writes `data` where nothing ever observes a partial or torn file: create a
 * sibling temp file exclusively, chmod it to the exact mode (creation mode is
 * subject to umask; this isn't), then rename it over `path`. A rename is
 * atomic on the same filesystem, so a reader sees either the old contents or
 * the new ones, never a partial write — and a failure before the rename
 * leaves `path` exactly as it was.
 *
 * A failure in the chmod/rename step still removes the temp file — best
 * effort, its own failure ignored — so a rename that throws (a full disk, a
 * permissions error) never leaves a stray `.tmp` sibling behind for someone
 * to find later.
 */
export async function writeFileAtomic(
  fs: RemoteFs,
  path: string,
  data: string,
  mode: number,
  random: RandomBytes,
): Promise<void> {
  const tmpPath = `${path}.${random(6).toString("hex")}.tmp`;
  await fs.writeFile(tmpPath, data, mode);
  try {
    await fs.chmod(tmpPath, mode);
    await fs.rename(tmpPath, path);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Creates `dir` at 0700 if it does not exist. When `enforceModes` is true
 * (POSIX only — Windows has no group/other bits to tighten), also chmods it
 * back to 0700 if a pre-existing directory had picked up a looser mode.
 */
export async function ensurePrivateDir(
  fs: RemoteFs,
  dir: string,
  enforceModes: boolean,
): Promise<void> {
  await fs.mkdir(dir, 0o700);
  if (!enforceModes) return;
  const { mode } = await fs.stat(dir);
  if (mode & 0o077) await fs.chmod(dir, 0o700);
}

/** Chmods `path` to 0600 if it has any group/other bit set. A no-op when `enforceModes` is false. */
export async function tightenFileMode(
  fs: RemoteFs,
  path: string,
  enforceModes: boolean,
): Promise<void> {
  if (!enforceModes) return;
  const { mode } = await fs.stat(path);
  if (mode & 0o077) await fs.chmod(path, 0o600);
}
