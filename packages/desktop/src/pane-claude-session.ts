// Which Claude Code session runs in a Terminal pane: the pid file Claude
// keeps at `<configDir>/sessions/<pid>.json` names the session, the
// transcripts directory holds its `<sessionId>.jsonl`. Shared by the tab
// namer (session-tab-name.ts) and the phone's chat view of a pane.

import { basename, join } from "node:path";
import type { AgentConfig } from "@jarvis/core";
import {
  claudeSessionPaths,
  parseClaudePidRecord,
  type ClaudePidRecord,
  type ExternalAgentProcess,
} from "@jarvis/platform";
import type { SessionTabNameDeps } from "./session-tab-name.js";

export type PaneClaudeSession = {
  paneKey: string;
  pid: number;
  sessionId: string;
  /** The pid file's name for the session, once it has one. */
  name?: string;
  /** Absent until Claude has written the transcript. */
  transcriptPath?: string;
  cwd: string | null;
  transcriptsDir: string;
};

export type PaneClaudeLookupDeps = Pick<
  SessionTabNameDeps,
  "agents" | "home" | "readFile" | "listTranscripts"
>;

export type PaneClaudeLookup = {
  /** Undefined unless the process is Claude Code, in a pane, with a pid file. */
  forProcess(process: ExternalAgentProcess): Promise<PaneClaudeSession | undefined>;
  /** Drops the cached transcript paths of these sessions. */
  forget(sessionIds: ReadonlySet<string>): void;
};

/** Claude's sessions and transcripts directories for the process's agent;
 *  null for any agent that is not Claude Code. */
export function claudePathsFor(
  agents: readonly AgentConfig[],
  home: string,
  process: ExternalAgentProcess,
): { sessionsDir: string; transcriptsDir: string } | null {
  const agent = agents.find((candidate) => candidate.id === process.agentId);
  if (agent?.vendor !== "anthropic") return null;
  return claudeSessionPaths(agents, home, process.agentId);
}

/** The process's pid record; rejects when its pid file is missing. */
export async function readClaudePidRecord(
  readFile: PaneClaudeLookupDeps["readFile"],
  sessionsDir: string,
  pid: number,
): Promise<ClaudePidRecord | null> {
  return parseClaudePidRecord(await readFile(join(sessionsDir, `${pid}.json`)), pid);
}

/** Session id → its transcript path, listed once and cached once found. */
export function createTranscriptPaths(listTranscripts: PaneClaudeLookupDeps["listTranscripts"]) {
  const paths = new Map<string, string>();
  return {
    async find(transcriptsDir: string, sessionId: string): Promise<string | undefined> {
      const cached = paths.get(sessionId);
      if (cached !== undefined) return cached;
      const files = await listTranscripts(transcriptsDir);
      const path = files.find((file) => basename(file.path) === `${sessionId}.jsonl`)?.path;
      if (path !== undefined) paths.set(sessionId, path);
      return path;
    },
    forget(sessionIds: ReadonlySet<string>): void {
      for (const sessionId of sessionIds) paths.delete(sessionId);
    },
    /** Keeps only these sessions' paths, so the cache cannot grow. */
    retain(sessionIds: ReadonlySet<string>): void {
      for (const sessionId of paths.keys()) if (!sessionIds.has(sessionId)) paths.delete(sessionId);
    },
  };
}

export function createPaneClaudeLookup(deps: PaneClaudeLookupDeps): PaneClaudeLookup {
  const transcriptPaths = createTranscriptPaths(deps.listTranscripts);
  return {
    async forProcess(process) {
      const paneKey = process.terminalPaneKey;
      if (paneKey === undefined) return undefined;
      const paths = claudePathsFor(deps.agents(), deps.home, process);
      if (paths === null) return undefined;
      let record: ClaudePidRecord | null;
      try {
        record = await readClaudePidRecord(deps.readFile, paths.sessionsDir, process.pid);
      } catch {
        return undefined; // No pid file: not (or no longer) a Claude session.
      }
      if (record === null) return undefined;
      const transcriptPath = await transcriptPaths.find(paths.transcriptsDir, record.sessionId);
      return {
        paneKey,
        pid: process.pid,
        sessionId: record.sessionId,
        ...(record.name === undefined ? {} : { name: record.name }),
        ...(transcriptPath === undefined ? {} : { transcriptPath }),
        cwd: process.cwd,
        transcriptsDir: paths.transcriptsDir,
      };
    },
    forget: (sessionIds) => transcriptPaths.forget(sessionIds),
  };
}
