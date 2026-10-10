// `jarvis account` (Plan Y §2.4: the terminal client speaks the same channels).
// The CLI never sees a password either: it prints the sign-in address and
// code that jarvisd pushes and waits for signed-in or failed.
import { isAccountId, type AccountId, type AccountStatePush, type AccountStatus } from "@jarvis/wire";
import type { ControlClient } from "../../desktop/src/daemon/control/client.js";
import { terminalLine } from "./sanitize.js";
import type { Terminal } from "./terminal.js";

const LABELS: Record<AccountId, string> = { claude: "Claude", chatgpt: "ChatGPT", gemini: "Google", copilot: "GitHub Copilot" };
const WAIT_MS = 15 * 60_000;

function describe(status: AccountStatus): string {
  if (status.signedIn) return `signed in as ${terminalLine(status.identity ?? LABELS[status.account], 120)}`;
  return status.installed ? "set up, not signed in" : "not set up";
}

function waitFor(client: ControlClient, account: AccountId, done: ReadonlySet<string>, onState: (s: AccountStatePush) => void, invoke: () => Promise<unknown>): Promise<AccountStatePush> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let off = () => {};
    let offClose = () => {};
    const finish = (state?: AccountStatePush, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      offClose();
      if (state !== undefined) resolve(state);
      else reject(error);
    };
    const timer = setTimeout(() => finish(undefined, new Error("Timed out waiting for Jarvis.")), WAIT_MS);
    off = client.onPush((channel, payload) => {
      if (channel !== "account:state" || typeof payload !== "object" || payload === null) return;
      const state = parseState(payload);
      if (state === undefined || state.account !== account) return;
      onState(state);
      if (done.has(state.phase)) finish(state);
    });
    offClose = client.onClose(() => finish(undefined, new Error("Connection to Jarvis closed.")));
    void invoke().catch((error: unknown) => finish(undefined, error));
  });
}

function parseState(payload: object): AccountStatePush | undefined {
  const raw = payload as Record<string, unknown>;
  if (!isAccountId(raw.account)) return undefined;
  const phase = raw.phase;
  if (phase !== "installing" && phase !== "installed" && phase !== "failed" && phase !== "awaiting-browser" && phase !== "signed-in") return undefined;
  const state: AccountStatePush = { account: raw.account, phase };
  for (const key of ["message", "url", "code", "identity"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "string") return undefined;
    if (typeof raw[key] === "string") state[key] = raw[key];
  }
  return state;
}

export async function accountCommand(
  client: ControlClient,
  term: Terminal,
  action: "status" | "install" | "login" | "logout" | "remove",
  account?: AccountId,
): Promise<number> {
  if (action === "status" || account === undefined) {
    const result: unknown = await client.invoke("account:status", []);
    if (typeof result !== "object" || result === null || !("accounts" in result) || !Array.isArray(result.accounts)) {
      throw new Error("Jarvis returned an invalid account status.");
    }
    for (const raw of result.accounts as unknown[]) {
      if (typeof raw !== "object" || raw === null) continue;
      const value = raw as Record<string, unknown>;
      if (!isAccountId(value.account) || typeof value.installed !== "boolean" || typeof value.signedIn !== "boolean" ||
          (value.version !== null && typeof value.version !== "string") ||
          (value.identity !== null && typeof value.identity !== "string")) continue;
      const status: AccountStatus = { account: value.account, installed: value.installed, signedIn: value.signedIn, version: value.version, identity: value.identity };
      term.write(`${LABELS[status.account].padEnd(16)}${describe(status)}\n`);
    }
    return 0;
  }
  const show = (state: AccountStatePush) => {
    if (state.phase === "installing" && state.message !== undefined) term.write(`${terminalLine(state.message, 200)}\n`);
    if (state.phase === "awaiting-browser" && state.url !== undefined) {
      const code = state.code === undefined ? "" : ` and enter the code ${terminalLine(state.code, 20)}`;
      term.write(`Open ${terminalLine(state.url, 2000)} in your browser${code}.\n`);
    }
  };
  if (action === "logout" || action === "remove") {
    await client.invoke(action === "logout" ? "account:logout" : "account:uninstall", [{ account }]);
    term.write(action === "logout" ? `Signed out of ${LABELS[account]}.\n` : `Removed ${LABELS[account]}.\n`);
    return 0;
  }
  const finalPhases = new Set(action === "install" ? ["installed", "failed"] : ["signed-in", "failed"]);
  const end = await waitFor(client, account, finalPhases, show, () =>
    client.invoke(action === "install" ? "account:install" : "account:login", [{ account }]),
  );
  if (end.phase === "failed") {
    term.write(`${terminalLine(end.message ?? "It didn't work.", 300)}\n`);
    return 1;
  }
  term.write(end.phase === "signed-in" ? `Signed in as ${terminalLine(end.identity ?? LABELS[account], 120)}.\n` : `${terminalLine(end.message ?? "Done.", 200)}\n`);
  return 0;
}
