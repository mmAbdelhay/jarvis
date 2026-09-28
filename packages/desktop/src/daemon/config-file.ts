// `daemon.enabled` in jarvis.yaml: read by the app before it builds any core
// (it decides in-process or jarvisd), written by Settings' "Keep Jarvis
// running in the background" toggle — and by nothing else: settings:save
// keeps whatever the file says (settings-io.ts).
//
// The write edits the one key in the user's own document, so comments and
// the rest of a hand-edited file are left as they were, and it refuses to
// write a file parseConfig would then refuse.
//
// No electron here (core/no-electron.test.ts).
import { parse, parseDocument } from "yaml";
import { parseConfig, parseDaemon } from "../config.js";

export type ConfigFileIo = {
  readFile(path: string): Promise<string>;
  /** Replaces the file whole (writeAtomically). */
  writeFile(path: string, text: string): Promise<void>;
};

/**
 * Whether the file turns the background service on. Anything unreadable —
 * no file yet (a first run), a file that does not parse — is off: the app
 * then runs the core itself, which reports a broken config the usual way.
 */
export async function readDaemonEnabled(path: string, io: ConfigFileIo): Promise<boolean> {
  try {
    const root: unknown = parse(await io.readFile(path));
    if (typeof root !== "object" || root === null) return false;
    return parseDaemon((root as Record<string, unknown>)["daemon"]).enabled;
  } catch {
    return false;
  }
}

/**
 * Sets `daemon.enabled`. Off removes the section, so a file that never had
 * one is left without one. Throws when the file cannot be read, or when the
 * result would not load (the edit is refused, the file untouched).
 */
export async function writeDaemonEnabled(
  path: string,
  enabled: boolean,
  io: ConfigFileIo,
): Promise<void> {
  const document = parseDocument(await io.readFile(path));
  if (document.errors.length > 0) {
    throw new Error(`jarvis.yaml does not parse: ${document.errors[0]?.message ?? "unknown"}`);
  }
  if (enabled) document.setIn(["daemon", "enabled"], true);
  else document.deleteIn(["daemon"]);
  // The same check a Settings save makes: never write a file Jarvis would
  // then refuse to start with.
  parseConfig(document.toJS());
  await io.writeFile(path, document.toString());
}
