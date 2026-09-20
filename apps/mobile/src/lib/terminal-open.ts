// The one "create a new terminal tab on the laptop" call — shared by the
// Dashboard's per-project Terminal tile and the Workspace screen's own
// "New terminal" button (workspace-store.ts's own comment, ruling (c),
// says that store never calls a tab-mutating channel, so this lives here
// instead of there).
//
// `terminal:open`'s own reply is a `GitViewResult<string>` (the new tab's
// id) nested inside the wire-level `RpcResult` — parsed the same strict
// way every other envelope on this boundary is (workspace-results.ts's
// `parseGitViewResult`): a reply that is not already `{ok:true,value}` or
// `{ok:false,text,language}` is a parse failure, never a bare value handed
// straight through.
//
// A freshly opened tab's main shell is keyed by the tab id itself
// (packages/desktop/src/ipc.ts's `open()`: `deps.shells.start(tabId, cwd)`)
// — so the route this outcome's `tabId` opens is `/terminal/[paneKey]`
// with `paneKey` and `tabId` both set to that same id.
import { MALFORMED_REPLY_NOTICE, parseGitViewResult } from "./workspace-results";
import type { RpcClient } from "./rpc-client";

/** ≤ 10 s (spec): a laptop with no terminal to spawn should not leave the
 *  phone's busy state hanging past the default request timeout ever would. */
export const TERMINAL_OPEN_TIMEOUT_MS = 10_000;

export type TerminalOpenOutcome = { ok: true; tabId: string } | { ok: false; text: string };

function isString(value: unknown): value is string {
  return typeof value === "string";
}

export async function openTerminal(
  client: RpcClient,
  project: string,
): Promise<TerminalOpenOutcome> {
  const result = await client.call("terminal:open", [project], {
    whenNotOpen: "reject",
    timeoutMs: TERMINAL_OPEN_TIMEOUT_MS,
  });
  if (!result.ok) {
    // "remote" carries the desktop's own real, already-localized text
    // (unknownProject, say) — shown verbatim. Every other RpcError kind
    // (offline/timeout/busy/cancelled/unsupported) carries none, so the
    // shared "couldn't load" message key stands in, the same fallback
    // history-screen.ts/changes-screen.ts already use.
    return {
      ok: false,
      text: result.error.kind === "remote" ? result.error.text : "common.loadFailed",
    };
  }
  const parsed = parseGitViewResult(result.value, (value) => (isString(value) ? value : undefined));
  if (!parsed.ok) {
    return {
      ok: false,
      text: parsed.text === MALFORMED_REPLY_NOTICE ? "common.loadFailed" : parsed.text,
    };
  }
  return { ok: true, tabId: parsed.value };
}
