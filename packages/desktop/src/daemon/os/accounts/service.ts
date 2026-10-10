// Plan Y §2.4: the account:* channels and the account providers, in one place.
// Every process goes through the injected (sandboxed) spawner; the sandbox is
// probed once and, if it did not apply, nothing account-related runs (fail
// closed). Install and sign-in answer null at once and report on account:state.
//
// No electron here (core/no-electron.test.ts).
import {
  ACCOUNT_IDS,
  ACCOUNT_TEXT,
  type AccountId,
  type Lang,
  type ModelProvider,
  newToolNonce,
} from "@jarvis/core";
import {
  ACCOUNT_LABELS,
  type AccountPaths,
  type AccountPins,
  type AccountProviderTexts,
  accountPaths,
  type CliSpawner,
  createAccountProvider,
} from "@jarvis/platform/model";
import type { AccountStatePush, AccountStatusResult } from "@jarvis/wire";
import { OsAgentError } from "../agent-service.js";
import type { AccountFs } from "./account-fs.js";
import { AccountInstallError, installAccount, uninstallAccount } from "./install.js";
import { createLoginManager, logoutAccount } from "./login.js";
import { readAccountStatus } from "./status.js";

export type AccountServiceDeps = {
  home: string;
  readPins(): Promise<AccountPins>;
  spawn: CliSpawner;
  /** Runs accountSandboxProbe for these paths; true when the sandbox applied. */
  sandboxWorks(paths: AccountPaths): Promise<boolean>;
  fs: AccountFs;
  readOpenUrl(path: string): Promise<string | undefined>;
  openBrowser(url: string): Promise<void>;
  push(state: AccountStatePush): void;
  language(): Lang;
  randomBytes(n: number): Uint8Array;
  log(line: string): void;
};

export type AccountService = {
  status(): Promise<AccountStatusResult>;
  install(account: AccountId): Promise<null>;
  login(account: AccountId): Promise<null>;
  logout(account: AccountId): Promise<null>;
  uninstall(account: AccountId): Promise<null>;
  provider(section: { account?: AccountId; model: string }): ModelProvider;
  shutdown(): Promise<void>;
};

export function createAccountService(deps: AccountServiceDeps): AccountService {
  const text = () => ACCOUNT_TEXT[deps.language()];
  const paths = (account: AccountId) => accountPaths(deps.home, account);
  let pinsPromise: Promise<AccountPins> | undefined;
  async function pins(): Promise<AccountPins> {
    pinsPromise ??= deps.readPins();
    try {
      return await pinsPromise;
    } catch {
      pinsPromise = undefined;
      throw new OsAgentError("unsupported", text().pinsMissing);
    }
  }
  let sandbox: Promise<boolean> | undefined;
  async function sandboxOk(account: AccountId): Promise<boolean> {
    if (sandbox === undefined) {
      sandbox = (async () => {
        const p = paths(account);
        for (const dir of [p.configDir, p.cliDir, p.tmpDir]) await deps.fs.makeDir(dir);
        return deps.sandboxWorks(p);
      })().catch(() => false);
    }
    const ok = await sandbox;
    if (!ok) deps.log("[accounts] the account sandbox did not apply; account providers stay off");
    return ok;
  }
  const statusOf = async (account: AccountId) =>
    readAccountStatus((await pins())[account], paths(account), deps.fs);
  let logins: ReturnType<typeof createLoginManager> | undefined;
  async function loginManager() {
    logins ??= createLoginManager({
      pins: await pins(),
      paths,
      spawn: deps.spawn,
      readOpenUrl: deps.readOpenUrl,
      openBrowser: deps.openBrowser,
      push: deps.push,
      status: statusOf,
      texts: {
        get timedOut() {
          return text().timedOut;
        },
        notFinished: (label) => text().notFinished(label),
        failed: (label) => text().loginFailed(label),
        badUrl: (label) => text().badUrl(label),
      },
      log: deps.log,
    });
    return logins;
  }
  const installing = new Set<AccountId>();
  const providerTexts: AccountProviderTexts = {
    notInstalled: (label) => text().notInstalled(label),
    signIn: (label) => text().signIn(label),
    rateLimited: (label) => text().rateLimited(label),
    unreachable: (label) => text().unreachable(label),
    failed: (label, detail) => text().failed(label, detail),
    tripwire: (label) => text().tripwire(label),
    sandboxOff: () => text().sandboxOff(),
  };

  async function logout(account: AccountId): Promise<null> {
    await (await loginManager()).cancel(account);
    if (!(await sandboxOk(account))) {
      deps.push({ account, phase: "failed", message: text().sandboxOff() });
      return null;
    }
    await logoutAccount({
      pin: (await pins())[account],
      paths: paths(account),
      spawn: deps.spawn,
      fs: deps.fs,
      log: deps.log,
    });
    return null;
  }

  return {
    async status() {
      const all = await pins();
      return {
        accounts: await Promise.all(
          ACCOUNT_IDS.map((id) => readAccountStatus(all[id], paths(id), deps.fs)),
        ),
      };
    },
    async install(account) {
      const label = ACCOUNT_LABELS[account];
      if (installing.has(account)) throw new OsAgentError("bad-request", text().busy(label));
      installing.add(account);
      let pin: AccountPins[AccountId];
      try {
        pin = (await pins())[account];
        if (!(await sandboxOk(account))) {
          installing.delete(account);
          deps.push({ account, phase: "failed", message: text().sandboxOff() });
          return null;
        }
      } catch (error) {
        installing.delete(account);
        throw error;
      }
      void installAccount({
        pin,
        paths: paths(account),
        spawn: deps.spawn,
        fs: deps.fs,
        progress: (message) => deps.push({ account, phase: "installing", message }),
        texts: {
          downloading: (l) => text().downloading(l),
          checking: (l) => text().checking(l),
          finishing: (l) => text().finishing(l),
          downloadFailed: (l) => text().downloadFailed(l),
          integrityFailed: (l) => text().integrityFailed(l),
          signaturesFailed: (l) => text().signaturesFailed(l),
          setupFailed: (l) => text().setupFailed(l),
        },
        log: deps.log,
      })
        .then(
          () => deps.push({ account, phase: "installed", message: text().installed(label) }),
          (error: unknown) =>
            deps.push({
              account,
              phase: "failed",
              message:
                error instanceof AccountInstallError ? error.message : text().setupFailed(label),
            }),
        )
        .finally(() => installing.delete(account));
      return null;
    },
    async login(account) {
      const label = ACCOUNT_LABELS[account];
      if (!(await sandboxOk(account))) {
        deps.push({ account, phase: "failed", message: text().sandboxOff() });
        return null;
      }
      if (!(await statusOf(account)).installed) {
        deps.push({ account, phase: "failed", message: text().installFirst(label) });
        return null;
      }
      return (await loginManager()).start(account);
    },
    logout,
    async uninstall(account) {
      await logout(account);
      await uninstallAccount(deps.fs, paths(account));
      return null;
    },
    provider(section) {
      const account = section.account;
      let inner: ModelProvider | undefined;
      async function current(): Promise<ModelProvider> {
        if (account === undefined) throw new OsAgentError("bad-request", text().accountsOff);
        inner ??= createAccountProvider({
          pin: (await pins())[account],
          model: section.model,
          paths: paths(account),
          spawn: deps.spawn,
          nonce: () => newToolNonce(deps.randomBytes),
          texts: providerTexts,
          readiness: async () => {
            if (!(await sandboxOk(account))) return "no-sandbox";
            const status = await statusOf(account);
            if (!status.installed) return "not-installed";
            return status.signedIn ? "ready" : "signed-out";
          },
        });
        return inner;
      }
      return {
        async *chat(request) {
          yield* (await current()).chat(request);
        },
        probe: async () => (await current()).probe(),
        listModels: async (signal) => (await current()).listModels(signal),
        reachable: async (signal) => (await current()).reachable(signal),
      };
    },
    async shutdown() {
      if (logins === undefined) return;
      for (const id of ACCOUNT_IDS) await logins.cancel(id);
    },
  };
}
