// Plan Y §5.12: account:status reads files only (no network, no CLI run):
// installed = the pinned version is in place with its entry point;
// signedIn = the CLI's credential file exists (Copilot: a logged-in user).
//
// No electron here (core/no-electron.test.ts).
import { posix } from "node:path";
import type { AccountId } from "@jarvis/core";
import { type AccountPaths, type AccountPin, cliCommand } from "@jarvis/platform/model";
import type { AccountStatus } from "@jarvis/wire";
import type { AccountFs } from "./account-fs.js";
import { claudeIdentity, codexIdentity, copilotIdentity, geminiIdentity } from "./identity.js";

export const CREDENTIAL_FILES: Readonly<Record<AccountId, string>> = {
  claude: ".credentials.json",
  chatgpt: "auth.json",
  gemini: ".gemini/oauth_creds.json",
  copilot: "config.json",
};
const IDENTITY: Readonly<Record<AccountId, { file: string; read(text: string): string | null }>> = {
  claude: { file: ".claude.json", read: claudeIdentity },
  chatgpt: { file: "auth.json", read: codexIdentity },
  gemini: { file: ".gemini/google_accounts.json", read: geminiIdentity },
  copilot: { file: "config.json", read: copilotIdentity },
};

async function text(fs: AccountFs, path: string): Promise<string | null> {
  try {
    return await fs.readText(path);
  } catch {
    return null;
  }
}

export async function readAccountStatus(
  pin: AccountPin,
  paths: AccountPaths,
  fs: AccountFs,
): Promise<AccountStatus> {
  const manifest = await text(
    fs,
    posix.join(paths.cliDir, "node_modules", pin.package, "package.json"),
  );
  let version: string | null = null;
  try {
    const value: unknown = manifest === null ? null : JSON.parse(manifest);
    const raw = (value as { version?: unknown } | null)?.version;
    version = typeof raw === "string" && /^[0-9][0-9A-Za-z.+-]{0,40}$/.test(raw) ? raw : null;
  } catch {
    version = null;
  }
  const installed =
    version === pin.version && (await fs.exists(cliCommand(pin, paths).at(-1) as string));
  const identitySource = IDENTITY[pin.account];
  const identityText = await text(fs, posix.join(paths.configDir, identitySource.file));
  const identity = identityText === null ? null : identitySource.read(identityText);
  const signedIn =
    pin.account === "copilot"
      ? identity !== null
      : await fs.exists(posix.join(paths.configDir, CREDENTIAL_FILES[pin.account]));
  return {
    account: pin.account,
    installed,
    version,
    signedIn,
    identity: signedIn ? identity : null,
  };
}
