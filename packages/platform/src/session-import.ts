import { join, resolve, sep } from "node:path";
import type { AgentConfig } from "@jarvis/core";

/**
 * Imports the sessions Jarvis did not start.
 *
 * Every Claude Code session — however it was launched — writes a JSONL
 * transcript to `<configDir>/projects/<escaped-cwd>/<session-id>.jsonl`,
 * carrying every column the `sessions` table has. Jarvis records only the
 * sessions it spawned itself, which on the machine this was designed
 * against is 6 rows against 125 transcripts: the history feature describes
 * about 5% of the work it claims to be a history of.
 *
 * Nothing here has to *produce* that record. It already exists on disk, and
 * this file reads it.
 *
 * Shaped like headlamp.ts: pure helpers first, each pinned by its own test,
 * then a manager whose every piece of I/O arrives through an injected deps
 * object — so the importer is tested against a fake filesystem rather than
 * temp directories and real fs watches.
 */

/**
 * True when `child` is `parent` or lives under it.
 *
 * A separator-aware comparison rather than a bare `startsWith` on the raw
 * strings: `"/a/bc".startsWith("/a/b")` is true and they are unrelated
 * directories. Both the project match and the brain exclusion below depend
 * on getting this right, so it is one function with its own test.
 */
export function isWithin(child: string, parent: string): boolean {
  const a = resolve(child);
  const b = resolve(parent);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

/**
 * Every directory holding transcripts Jarvis knows how to read, with the
 * agent each belongs to.
 *
 * Anthropic-only in v1, and the boundary is here rather than inside the
 * parser: Copilot keeps its sessions in a different format under
 * `~/.copilot/session-state`, and building one importer to serve both
 * formats — with exactly one of them actually written — would be an
 * abstraction designed against a sample size of one. When a second vendor
 * is genuinely wanted, the shape of what varies will be known.
 *
 * An agent with no `configDir` contributes nothing: there is no directory
 * to look in.
 */
export function transcriptDirs(
  agents: readonly AgentConfig[],
): { agentId: string; dir: string }[] {
  return agents.flatMap((agent) =>
    agent.vendor === "anthropic" && agent.configDir !== undefined
      ? [{ agentId: agent.id, dir: join(agent.configDir, "projects") }]
      : [],
  );
}

/**
 * The configured project a session's cwd belongs to, by longest path
 * prefix — or null when it belongs to none.
 *
 * Prefix rather than equality, on principle rather than on current
 * evidence, and the distinction is worth stating plainly: measured against
 * the 125 non-brain transcripts on the machine this was designed for,
 * prefix matching resolves exactly the same 30 sessions equality does. It
 * rescues nothing today. It is still right — a session started in
 * `acme/app` belongs to `acme` by any reasonable reading, and the
 * day one is started there equality would file it under nothing — and it
 * costs one comparison. Anyone tempted to simplify it back to equality
 * should know it was a deliberate choice made with the numbers in hand.
 *
 * Longest wins, so a cwd inside a nested configured project resolves to the
 * more specific one.
 *
 * Null is the dominant outcome — 95 of those 125 — and is a normal result,
 * not an error: most work happens in directories the user never declared,
 * and such a row still has projectPath, summary and resume.
 */
export function resolveProject(
  cwd: string,
  projects: Readonly<Record<string, string>>,
): string | null {
  let best: { name: string; length: number } | null = null;
  for (const [name, path] of Object.entries(projects)) {
    if (!isWithin(cwd, path)) continue;
    const length = resolve(path).length;
    if (best === null || length > best.length) best = { name, length };
  }
  return best === null ? null : best.name;
}
