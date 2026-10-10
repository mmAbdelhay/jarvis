// Plan Y §2.2: install an account CLI per user, on demand, with no root:
//   npm install --prefix ~/.local/share/jarvis/clis/<account> <pkg>@<pin>
//     --ignore-scripts (claude: then only its own install.cjs, offline)
// then the lockfile must carry exactly the pinned integrity (and the pinned
// linux-x64 platform package), and `npm audit signatures` must pass. Every
// step runs in the account sandbox (network for npm only). Any failure
// removes the half-installed tree.
//
// No electron here (core/no-electron.test.ts).
import { posix } from "node:path";
import {
  ACCOUNT_LABELS,
  type AccountPaths,
  type AccountPin,
  type CliInvocation,
  type CliSpawner,
  cliCommand,
  INSTALL_TIMEOUT_MS,
  NODE_BIN,
  NPM_CLI,
  runOnce,
  SHORT_TIMEOUT_MS,
} from "@jarvis/platform/model";
import type { AccountFs } from "./account-fs.js";

export const NPM_REGISTRY = "https://registry.npmjs.org/";
/** An empty, root-owned npmrc (package jarvis-accounts). npm refuses the same
 *  file as both user and global config ("double-loading config"), so only the
 *  global one is /dev/null; never a file in a dir the account CLIs can write. */
export const NPM_USERCONFIG = "/usr/lib/jarvis/accounts/npmrc";

export type InstallTexts = {
  downloading(label: string): string;
  checking(label: string): string;
  finishing(label: string): string;
  downloadFailed(label: string): string;
  integrityFailed(label: string): string;
  signaturesFailed(label: string): string;
  setupFailed(label: string): string;
};

export class AccountInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountInstallError";
  }
}

function npmEnv(paths: AccountPaths): Record<string, string> {
  return {
    PATH: "/usr/lib/jarvis/node/bin:/usr/bin:/bin",
    HOME: paths.tmpDir,
    TMPDIR: paths.tmpDir,
    LANG: "C.UTF-8",
    NO_COLOR: "1",
    npm_config_update_notifier: "false",
  };
}

function npmBase(pin: AccountPin, paths: AccountPaths, purpose: CliInvocation["purpose"]) {
  return {
    account: pin.account,
    purpose,
    env: npmEnv(paths),
    cwd: paths.tmpDir,
    network: true,
    files: [],
    stdin: "",
    tty: false,
    mergeStderr: true,
  };
}

const NPM_ISOLATION = [
  "--userconfig",
  NPM_USERCONFIG,
  "--globalconfig",
  "/dev/null",
  "--registry",
  NPM_REGISTRY,
];

export function installInvocation(pin: AccountPin, paths: AccountPaths): CliInvocation {
  return {
    ...npmBase(pin, paths, "install"),
    argv: [
      NODE_BIN,
      NPM_CLI,
      "install",
      "--prefix",
      paths.cliDir,
      `${pin.package}@${pin.version}`,
      "--save-exact",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--omit=dev",
      ...(pin.omitOptional ? ["--omit=optional"] : []),
      "--cache",
      posix.join(paths.tmpDir, "npm-cache"),
      ...NPM_ISOLATION,
    ],
    writable: [paths.cliDir, paths.tmpDir],
    readOnly: [],
    timeoutMs: INSTALL_TIMEOUT_MS,
  };
}

export function auditInvocation(pin: AccountPin, paths: AccountPaths): CliInvocation {
  return {
    ...npmBase(pin, paths, "audit"),
    argv: [NODE_BIN, NPM_CLI, "audit", "signatures", "--prefix", paths.cliDir, ...NPM_ISOLATION],
    writable: [paths.tmpDir],
    readOnly: [paths.cliDir],
    timeoutMs: SHORT_TIMEOUT_MS * 2,
  };
}

export function postinstallInvocation(pin: AccountPin, paths: AccountPaths): CliInvocation | null {
  if (pin.postinstall === null) return null;
  return {
    ...npmBase(pin, paths, "postinstall"),
    argv: [NODE_BIN, posix.join(paths.cliDir, "node_modules", pin.package, pin.postinstall)],
    network: false,
    writable: [paths.cliDir, paths.tmpDir],
    readOnly: [],
    timeoutMs: SHORT_TIMEOUT_MS,
  };
}

function entryProblems(
  packages: Record<string, unknown>,
  name: string,
  version: string,
  integrity: string,
): string[] {
  const entry = packages[`node_modules/${name}`];
  if (typeof entry !== "object" || entry === null) return [`${name}: missing from the lockfile`];
  const record = entry as Record<string, unknown>;
  if (record["version"] !== version) return [`${name}: version differs from accounts.json`];
  if (record["integrity"] !== integrity) return [`${name}: integrity differs from accounts.json`];
  return [];
}

export function verifyLockfile(pin: AccountPin, lockText: string): string[] {
  let lock: unknown;
  try {
    lock = JSON.parse(lockText);
  } catch {
    return ["package-lock.json does not parse"];
  }
  const packages = (lock as { packages?: unknown } | null)?.packages;
  if (typeof packages !== "object" || packages === null)
    return ["package-lock.json has no packages"];
  const table = packages as Record<string, unknown>;
  const problems = entryProblems(table, pin.package, pin.version, pin.integrity);
  if (pin.platformPackage !== null) {
    problems.push(
      ...entryProblems(
        table,
        pin.platformPackage.name,
        pin.platformPackage.version,
        pin.platformPackage.integrity,
      ),
    );
  }
  return problems;
}

export async function installAccount(deps: {
  pin: AccountPin;
  paths: AccountPaths;
  spawn: CliSpawner;
  fs: AccountFs;
  progress(message: string): void;
  texts: InstallTexts;
  log(line: string): void;
}): Promise<void> {
  const { pin, paths, fs, texts } = deps;
  const label = ACCOUNT_LABELS[pin.account];
  const fail = async (message: string, detail: string): Promise<never> => {
    deps.log(`[accounts] ${pin.account} install failed: ${detail}`);
    await fs.removeTree(paths.cliDir).catch(() => {});
    throw new AccountInstallError(message);
  };
  await fs.removeTree(paths.cliDir);
  await fs.makeDir(paths.cliDir);
  await fs.makeDir(paths.tmpDir);

  deps.progress(texts.downloading(label));
  const install = await runOnce(installInvocation(pin, paths), deps.spawn);
  if (install.exitCode !== 0)
    await fail(texts.downloadFailed(label), `npm install exited ${install.exitCode}`);
  let lockText = "";
  try {
    lockText = await fs.readText(posix.join(paths.cliDir, "package-lock.json"));
  } catch {
    await fail(texts.integrityFailed(label), "no package-lock.json");
  }
  const problems = verifyLockfile(pin, lockText);
  if (problems.length > 0) await fail(texts.integrityFailed(label), problems.join("; "));

  deps.progress(texts.checking(label));
  const audit = await runOnce(auditInvocation(pin, paths), deps.spawn);
  if (audit.exitCode !== 0)
    await fail(texts.signaturesFailed(label), `npm audit signatures exited ${audit.exitCode}`);

  const postinstall = postinstallInvocation(pin, paths);
  if (postinstall !== null) {
    deps.progress(texts.finishing(label));
    const result = await runOnce(postinstall, deps.spawn);
    if (result.exitCode !== 0)
      await fail(texts.setupFailed(label), `postinstall exited ${result.exitCode}`);
  }
  const entry = cliCommand(pin, paths).at(-1) as string;
  if (!(await fs.exists(entry))) await fail(texts.setupFailed(label), `${entry} is missing`);
}

export async function uninstallAccount(fs: AccountFs, paths: AccountPaths): Promise<void> {
  await fs.removeTree(paths.cliDir);
}
