// Plan Y §2.3: what jarvisd reads from an account CLI's JSONL stdout. Each
// parser is pure and per-turn; the runner (runner.ts) feeds it lines and
// stops the process at the first tripwire. Never log a raw line: it can hold
// the user's conversation.
import { isRecord } from "@jarvis/core";

export type AccountErrorCode = "not-signed-in" | "rate-limit" | "unavailable" | "failed";
export type CliStreamEvent =
  | { kind: "progress" }
  | { kind: "text"; text: string }
  | { kind: "usage"; inputTokens: number; outputTokens: number }
  | { kind: "error"; code: AccountErrorCode; detail: string }
  | { kind: "tripwire"; reason: string };

export interface CliStreamParser {
  /** One stdout line, without its newline. */
  line(raw: string): CliStreamEvent[];
  /** The process ended (exitCode null: killed); stderrTail is its last 4 KiB. */
  end(exitCode: number | null, stderrTail: string): CliStreamEvent[];
}

export function parseJsonLine(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

export function classifyCliError(detail: string): AccountErrorCode {
  if (
    /not logged in|please run \/login|log ?in again|sign(ed)? ?in again|unauthori[sz]ed|\b401\b|authentication|invalid[_ ]grant|token (has )?expired|no authentication information|oauth/i.test(
      detail,
    )
  )
    return "not-signed-in";
  if (/\b429\b|rate.?limit|usage limit|quota|resource_exhausted|overloaded/i.test(detail))
    return "rate-limit";
  if (
    /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|fetch failed|getaddrinfo/i.test(
      detail,
    )
  )
    return "unavailable";
  return "failed";
}

/** The end of a stream that never reported its own outcome. */
export function endWithoutOutcome(
  account: string,
  exitCode: number | null,
  stderrTail: string,
): CliStreamEvent[] {
  const detail = stderrTail.trim() || `${account} exited with ${exitCode ?? "a signal"}`;
  return [{ kind: "error", code: classifyCliError(detail), detail }];
}
