// Reads /var/lib/jarvis/model-state.json for sys:snapshot.model.download
// (M2 contracts §5). Called every snapshot (10 s), so it never throws and
// logs a problem once, not on every read: a missing file is normal (cloud
// installs, M1 systems) and silent; a corrupt or unreadable one is logged
// when it first appears and again only after a good read in between.
//
// No electron here (core/no-electron.test.ts).
import { type ModelState, parseModelState } from "@jarvis/core";

export function createModelStateReader(deps: {
  path: string;
  readFile(path: string): Promise<string>;
  log(line: string): void;
}): () => Promise<ModelState | null> {
  let lastProblem: string | undefined;
  const report = (problem: string | undefined) => {
    if (problem !== undefined && problem !== lastProblem) {
      try {
        deps.log(`[model-state] ${problem}`);
      } catch {
        // Logging must not interrupt snapshots.
      }
    }
    lastProblem = problem;
  };
  return async () => {
    let text: string;
    try {
      text = await deps.readFile(deps.path);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code === "ENOENT" || code === "ENOTDIR") {
        report(undefined);
        return null;
      }
      report(`${deps.path} cannot be read (${typeof code === "string" ? code : "error"})`);
      return null;
    }
    const state = parseModelState(text);
    report(state === undefined ? `${deps.path} is not a valid model state; ignored` : undefined);
    return state ?? null;
  };
}
