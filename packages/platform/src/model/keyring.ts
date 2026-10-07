// Provider API keys live in the system keyring (spec §4): Secret Service via
// gnome-keyring, unlocked at autologin, reached through `secret-tool`
// (libsecret-tools). The key travels on stdin, never argv, and no error
// message ever contains it. jarvis.yaml holds only kind, base URL and model.
import { spawn } from "node:child_process";

export interface SecretStore {
  get(account: string): Promise<string | undefined>;
  set(account: string, secret: string): Promise<void>;
  remove(account: string): Promise<void>;
}

export type KeyringExec = (
  args: readonly string[],
  stdin?: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export class KeyringUnavailableError extends Error {
  constructor() {
    super("The system keyring is not available (secret-tool is missing)");
    this.name = "KeyringUnavailableError";
  }
}

const SERVICE = "jarvis";
const LABEL = "Jarvis model provider key";

export function providerAccount(kind: string, baseUrl: string): string {
  return `${kind} ${baseUrl}`;
}

function hideSecret(message: string, secret?: string): string {
  return secret ? message.split(secret).join("[hidden]") : message;
}

async function run(exec: KeyringExec, args: readonly string[], stdin?: string) {
  try {
    return await exec(args, stdin);
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")
      throw new KeyringUnavailableError();
    throw new Error(
      `The system keyring failed: ${hideSecret(error instanceof Error ? error.message : String(error), stdin)}`,
    );
  }
}

export function createSecretToolStore(exec: KeyringExec): SecretStore {
  return {
    async get(account) {
      const result = await run(exec, ["lookup", "service", SERVICE, "account", account]);
      // Exit 1 with no output is "no such item".
      if (result.code !== 0 || result.stdout === "") return undefined;
      return result.stdout;
    },
    async set(account, secret) {
      const result = await run(
        exec,
        ["store", `--label=${LABEL}`, "service", SERVICE, "account", account],
        secret,
      );
      if (result.code !== 0) {
        throw new Error(
          `The system keyring refused the key: ${hideSecret(result.stderr, secret).trim().slice(0, 200)}`,
        );
      }
    },
    async remove(account) {
      const result = await run(exec, ["clear", "service", SERVICE, "account", account]);
      if (result.code !== 0 && result.stderr.trim() !== "") {
        throw new Error(
          `The system keyring could not remove the key: ${result.stderr.trim().slice(0, 200)}`,
        );
      }
    },
  };
}

export function nodeSecretToolExec(env: NodeJS.ProcessEnv): KeyringExec {
  return (args, stdin) =>
    new Promise((resolve, reject) => {
      const child = spawn("secret-tool", [...args], { env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      child.stdin.on("error", () => {
        // An early exit closes stdin; "close" above reports the outcome.
      });
      child.stdin.end(stdin ?? "");
    });
}

export function createMemorySecretStore(initial: Record<string, string> = {}): SecretStore {
  const values = new Map(Object.entries(initial));
  return {
    async get(account) {
      return values.get(account);
    },
    async set(account, secret) {
      values.set(account, secret);
    },
    async remove(account) {
      values.delete(account);
    },
  };
}
