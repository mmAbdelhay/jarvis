// Calls a paired phone may make that change the laptop's own windows and
// sessions: close or rename a Workspace tab, resume a finished session.
// Each answers `{ ok: true }`-style outcomes whose failure `text` is either
// a MessageKey (the phone's own wording) or the laptop's already-localized
// text, shown verbatim — `noticeText` tells them apart.
import { MALFORMED_REPLY_NOTICE, parseGitViewResult } from "./workspace-results";
import { type Language, type MessageKey, STRINGS, t } from "./i18n";
import type { RpcClient, RpcError } from "./rpc-client";

export type ActionOutcome = { ok: true } | { ok: false; text: string };
export type ResumeOutcome = { ok: true; tabId: string } | { ok: false; text: string };

/** The laptop's own limit for a tab title. */
export const TAB_TITLE_MAX = 80;

/** C0, DEL and C1 control characters. */
export function hasControlChar(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

export type TitleProblem = "empty" | "tooLong" | "control";

// Bidi override and isolate characters: a title that draws as something
// other than what it says. The laptop refuses them too.
const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069]/;

export function validateTabTitle(title: string): TitleProblem | undefined {
  if (title.trim() === "") return "empty";
  if (title.length > TAB_TITLE_MAX) return "tooLong";
  if (hasControlChar(title) || BIDI_CONTROL.test(title)) return "control";
  return undefined;
}

const TITLE_KEYS: Record<TitleProblem, MessageKey> = {
  empty: "rename.empty",
  tooLong: "rename.tooLong",
  control: "rename.control",
};

export function titleProblemKey(problem: TitleProblem): MessageKey {
  return TITLE_KEYS[problem];
}

export function isMessageKey(value: string): value is MessageKey {
  return Object.hasOwn(STRINGS, value);
}

/** A failure text ready to show: a key is translated, anything else is the
 *  laptop's own words. */
export function noticeText(language: Language, text: string): string {
  return isMessageKey(text) ? t(language, text) : text;
}

export function rpcFailureText(error: RpcError): string {
  return error.kind === "remote" ? error.text : "common.loadFailed";
}

async function simple(
  client: Pick<RpcClient, "call">,
  channel: string,
  args: unknown[],
): Promise<ActionOutcome> {
  const result = await client.call(channel, args, { whenNotOpen: "reject" });
  return result.ok ? { ok: true } : { ok: false, text: rpcFailureText(result.error) };
}

export function closeLaptopTab(
  client: Pick<RpcClient, "call">,
  tabId: string,
): Promise<ActionOutcome> {
  return simple(client, "workspace:close", [tabId]);
}

export async function renameLaptopTab(
  client: Pick<RpcClient, "call">,
  tabId: string,
  title: string,
): Promise<ActionOutcome> {
  const problem = validateTabTitle(title);
  if (problem !== undefined) return { ok: false, text: titleProblemKey(problem) };
  return simple(client, "workspace:rename", [tabId, title]);
}

/** Resume is offered on a session that has ended. */
export function canResume(state: string | undefined): boolean {
  return state === "done" || state === "dead";
}

export function parseResumeReply(value: unknown): ResumeOutcome {
  if (typeof value === "object" && value !== null && "ok" in value) {
    const obj = value as Record<string, unknown>;
    if (obj["ok"] === true && typeof obj["tabId"] === "string" && obj["tabId"] !== "") {
      return { ok: true, tabId: obj["tabId"] };
    }
  }
  // `{ok:false,text,language}` and anything malformed share the strict
  // GitViewResult reading the rest of the app uses.
  const parsed = parseGitViewResult(value, () => undefined);
  if (!parsed.ok && parsed.text !== MALFORMED_REPLY_NOTICE) return { ok: false, text: parsed.text };
  return { ok: false, text: "common.loadFailed" };
}

export async function resumeSession(
  client: Pick<RpcClient, "call">,
  sessionId: string,
  project: string | null | undefined,
): Promise<ResumeOutcome> {
  const args: unknown[] =
    project === null || project === undefined ? [sessionId] : [sessionId, project];
  const result = await client.call("session:resume", args, {
    whenNotOpen: "reject",
    timeoutMs: 15_000,
  });
  if (!result.ok) return { ok: false, text: rpcFailureText(result.error) };
  return parseResumeReply(result.value);
}
