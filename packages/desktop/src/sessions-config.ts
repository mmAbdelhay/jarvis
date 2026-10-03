// The `sessions:` section's own parser, apart from config.ts because
// config.ts computes paths from the home directory when it loads: a remote
// settings:save (dispatch.ts) checks a phone's `sessions` with this rule and
// must not pull that in.
export type SessionsConfig = {
  importWindowDays: number;
  /** When a session gets a git worktree of its own — see
   *  OrchestratorOptions.worktrees. Absent is off. */
  worktrees?: "parallel" | "always";
};

/**
 * How far back the transcript backfill reaches, by file mtime.
 *
 * 30 days was 90 of the 125 transcripts on the machine this was designed
 * against, and 90 days was all of them — generous without being unbounded
 * on a machine with years of history.
 */
export const DEFAULT_IMPORT_WINDOW_DAYS = 30;

export function parseSessions(rawSessions: unknown): SessionsConfig {
  if (rawSessions === undefined) {
    return { importWindowDays: DEFAULT_IMPORT_WINDOW_DAYS };
  }
  if (typeof rawSessions !== "object" || rawSessions === null || Array.isArray(rawSessions)) {
    throw new Error("Config `sessions` must be an object");
  }
  const sessions = rawSessions as Record<string, unknown>;
  const window = sessions["importWindowDays"] ?? DEFAULT_IMPORT_WINDOW_DAYS;
  // Rejected rather than clamped: a window of zero or a string imports
  // nothing, and silently reads as a bug in the importer rather than in
  // the config line that caused it.
  if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) {
    throw new Error("Config `sessions.importWindowDays` must be a positive number");
  }
  // "off" is accepted and dropped, so the parsed config is the same as an
  // absent key — and Settings never writes a section that says only that.
  const worktrees = sessions["worktrees"];
  if (
    worktrees !== undefined &&
    worktrees !== "off" &&
    worktrees !== "parallel" &&
    worktrees !== "always"
  ) {
    throw new Error('Config `sessions.worktrees` must be "off", "parallel" or "always"');
  }
  return {
    importWindowDays: window,
    ...(worktrees === "parallel" || worktrees === "always" ? { worktrees } : {}),
  };
}
