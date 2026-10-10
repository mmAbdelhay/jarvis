// Plan Y §1.2, §2.4, §5.7: run the CLI's own sign-in inside the sandbox.
// jarvisd never sees a password: it only picks the sign-in address out of the
// CLI's output (or the browser shim's file), checks it is https on the
// account's own host, pushes it (with Copilot's device code) and opens it in
// the user's session. The CLI stores its token in its own config dir. A login
// ends with signed-in (from the files, status.ts) or failed; it times out after
// 10 minutes; a second start (or account:logout) cancels the first (§5.11).
//
// No electron here (core/no-electron.test.ts).
import { posix } from "node:path";
import type { AccountId } from "@jarvis/core";
import {
  ACCOUNT_LABELS,
  type AccountPaths,
  type AccountPin,
  type AccountPins,
  type CliProcess,
  type CliSpawner,
  cliCommand,
  LOGIN_TIMEOUT_MS,
  loginInvocation,
  logoutInvocation,
  runOnce,
} from "@jarvis/platform/model";
import type { AccountStatePush, AccountStatus } from "@jarvis/wire";
import type { AccountFs } from "./account-fs.js";

export const LOGIN_URL_HOSTS: Readonly<Record<AccountId, readonly string[]>> = {
  claude: ["claude.ai", "claude.com", "console.anthropic.com", "platform.claude.com"],
  chatgpt: ["auth.openai.com"],
  gemini: ["accounts.google.com"],
  copilot: ["github.com"],
};
const OPEN_URL_POLL_MS = 500;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are what this strips.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
const URLS = /https?:\/\/[^\s"'<>`]+/g;

export function loginUrlFrom(account: AccountId, text: string): string | undefined {
  for (const match of text.replace(ANSI, "").matchAll(URLS)) {
    let url: URL;
    try {
      url = new URL(match[0].replace(/[).,;:]+$/, ""));
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") continue;
    if (LOGIN_URL_HOSTS[account].includes(url.hostname)) return url.toString();
  }
  return undefined;
}

export function deviceCodeFrom(account: AccountId, text: string): string | undefined {
  if (account !== "copilot") return undefined;
  return /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(text.replace(ANSI, ""))?.[1];
}

export type LoginTexts = {
  timedOut: string;
  notFinished(label: string): string;
  failed(label: string): string;
  badUrl(label: string): string;
};

export function createLoginManager(deps: {
  pins: AccountPins;
  paths(account: AccountId): AccountPaths;
  spawn: CliSpawner;
  /** Reads and deletes <tmp>/open-url (the browser shim's file); undefined when absent. */
  readOpenUrl(path: string): Promise<string | undefined>;
  openBrowser(url: string): Promise<void>;
  push(state: AccountStatePush): void;
  status(account: AccountId): Promise<AccountStatus>;
  texts: LoginTexts;
  log(line: string): void;
}) {
  type Session = { proc: CliProcess; done: boolean; stop(): void };
  const sessions = new Map<AccountId, Session>();

  async function cancel(account: AccountId): Promise<void> {
    const session = sessions.get(account);
    if (session === undefined) return;
    sessions.delete(account);
    session.done = true;
    session.stop();
    await session.proc.kill();
  }

  async function start(account: AccountId): Promise<null> {
    await cancel(account);
    const pin: AccountPin = deps.pins[account];
    const paths = deps.paths(account);
    const label = ACCOUNT_LABELS[account];
    const proc = await deps.spawn(loginInvocation(pin, paths));
    let announced = false;
    let url: string | undefined;
    let code: string | undefined;
    const timeout = setTimeout(() => {
      void proc.kill();
      finish({ account, phase: "failed", message: deps.texts.timedOut });
    }, LOGIN_TIMEOUT_MS);
    const poll = setInterval(() => {
      void deps.readOpenUrl(posix.join(paths.tmpDir, "open-url")).then((raw) => {
        if (raw === undefined || session.done) return;
        const checked = loginUrlFrom(account, raw);
        if (checked === undefined) {
          deps.log(`[accounts] ${account} asked to open an address outside its allowlist`);
          void proc.kill();
          finish({ account, phase: "failed", message: deps.texts.badUrl(label) });
          return;
        }
        url ??= checked;
        void announce();
      });
    }, OPEN_URL_POLL_MS);
    const session: Session = {
      proc,
      done: false,
      stop: () => {
        clearTimeout(timeout);
        clearInterval(poll);
      },
    };
    sessions.set(account, session);

    function finish(state: AccountStatePush): void {
      if (session.done) return;
      session.done = true;
      session.stop();
      if (sessions.get(account) === session) sessions.delete(account);
      deps.push(state);
    }
    async function announce(): Promise<void> {
      if (announced || session.done || url === undefined) return;
      if (account === "copilot" && code === undefined) return; // the page is useless without it
      announced = true;
      deps.push({
        account,
        phase: "awaiting-browser",
        url,
        ...(code === undefined ? {} : { code }),
      });
      await deps
        .openBrowser(url)
        .catch(() => deps.log(`[accounts] could not open the browser for ${account}`));
    }

    void (async () => {
      for await (const line of proc.lines) {
        if (session.done) break;
        code ??= deviceCodeFrom(account, line);
        url ??= loginUrlFrom(account, line);
        await announce();
      }
      const exitCode = await proc.exit;
      if (session.done) return;
      if (exitCode !== 0) {
        deps.log(`[accounts] ${account} sign-in exited ${exitCode ?? "on a signal"}`);
        finish({ account, phase: "failed", message: deps.texts.failed(label) });
        return;
      }
      const status = await deps.status(account);
      finish(
        status.signedIn
          ? { account, phase: "signed-in", identity: status.identity ?? label }
          : { account, phase: "failed", message: deps.texts.notFinished(label) },
      );
    })().catch(() => finish({ account, phase: "failed", message: deps.texts.failed(label) }));
    return null;
  }

  return { start, cancel, running: (account: AccountId) => sessions.has(account) };
}

/** Plan Y §2.4: the CLI's logout where it has one, then the config dir goes. */
export async function logoutAccount(deps: {
  pin: AccountPin;
  paths: AccountPaths;
  spawn: CliSpawner;
  fs: AccountFs;
  log(line: string): void;
}): Promise<void> {
  const inv = logoutInvocation(deps.pin, deps.paths);
  // The CLI's own logout needs the CLI; without it, deleting the files is all there is.
  if (inv !== null && (await deps.fs.exists(cliCommand(deps.pin, deps.paths).at(-1) as string))) {
    const result = await runOnce(inv, deps.spawn).catch(() => ({ exitCode: null, output: "" }));
    if (result.exitCode !== 0)
      deps.log(
        `[accounts] ${deps.pin.account} logout exited ${result.exitCode ?? "on a signal"}; removing its files anyway`,
      );
  }
  await deps.fs.removeTree(deps.paths.configDir);
  await deps.fs.removeTree(deps.paths.tmpDir);
}
