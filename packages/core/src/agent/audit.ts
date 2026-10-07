// Audit lines (spec §5, contracts §3.3 AuditEntry). The input recorded is
// what the model asked for with secret fields stripped; a secret the user
// typed on the card shows as "[hidden]" so the log says one was given.
import type { AuditEntry } from "./contract.js";
import { isRecord } from "./types.js";

export function auditInput(
  input: Record<string, unknown>,
  secretFields: readonly string[],
  provided: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!secretFields.includes(key)) out[key] = value;
  }
  for (const name of provided) out[name] = "[hidden]";
  return out;
}

const DECISIONS = new Set(["approved", "denied", "timeout"]);
const VIAS = new Set(["desktop", "doctor"]);
const RESULTS = new Set(["ok", "failed", "skipped"]);

/** One audit.jsonl line, field by field; undefined for anything malformed. */
export function parseAuditEntry(value: unknown): AuditEntry | undefined {
  if (!isRecord(value)) return undefined;
  const { ts, tool, title, input, decision, via, result, message } = value;
  if (typeof ts !== "number" || !Number.isFinite(ts)) return undefined;
  if (typeof tool !== "string" || typeof title !== "string") return undefined;
  if (typeof decision !== "string" || !DECISIONS.has(decision)) return undefined;
  if (typeof via !== "string" || !VIAS.has(via)) return undefined;
  if (typeof result !== "string" || !RESULTS.has(result)) return undefined;
  if (message !== undefined && typeof message !== "string") return undefined;
  return {
    ts,
    tool,
    title,
    input,
    decision: decision as AuditEntry["decision"],
    via: via as AuditEntry["via"],
    result: result as AuditEntry["result"],
    ...(message === undefined ? {} : { message }),
  };
}
