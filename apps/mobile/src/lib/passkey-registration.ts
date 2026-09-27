// Adding a passkey from the browser (Task 13), pure: the rpc and the
// browser's `navigator.credentials.create` wrapper (passkey.web.ts) are
// injected. The laptop only allows it on an unlocked connection, and
// `auth:passkeyRegisterBegin` re-checks the owner password (a wrong one
// counts toward the lockout), so the screen always asks for it again.
// The password is passed straight through and never kept.
import { MAX_PASSKEY_LABEL_LENGTH } from "@jarvis/wire";
import type { AuthArgs, PasskeyRegisterOptions } from "@jarvis/wire";
import type { RpcClient, RpcResult } from "./rpc-client";

/** `create()`'s result, base64url, without the label. */
export type CreatedPasskey = Omit<AuthArgs["auth:passkeyRegisterFinish"], "label">;
/** Runs the browser's create sheet. "exists": this authenticator already
 *  holds one of the owner's passkeys (the exclude list matched). */
export type CreatePasskey = (
  options: PasskeyRegisterOptions,
) => Promise<CreatedPasskey | "cancelled" | "exists">;

export type RegisterOutcome =
  | "registered"
  | "wrong-password"
  | "cancelled"
  | "exists"
  | "unsupported"
  | "locked"
  | "rate-limited"
  | "offline"
  | "failed";

export type RegisterPasskeyInput = {
  rpc: Pick<RpcClient, "call">;
  password: string;
  label: string;
  create: CreatePasskey;
};

function beginFailure(result: RpcResult & { ok: false }): RegisterOutcome {
  const { error } = result;
  if (error.kind === "offline" || error.kind === "timeout") return "offline";
  if (error.kind === "unsupported") return "unsupported";
  if (error.kind !== "remote") return "failed";
  switch (error.code) {
    case "forbidden":
      return "wrong-password";
    case "rate-limited":
      return "rate-limited";
    case "locked":
      return "locked";
    case "unsupported":
      return "unsupported";
    default:
      return "failed";
  }
}

function parseRegisterOptions(value: unknown): PasskeyRegisterOptions | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const user = raw.user as Record<string, unknown> | undefined;
  if (typeof raw.challenge !== "string" || typeof raw.rpId !== "string") return undefined;
  if (typeof user !== "object" || user === null) return undefined;
  if (
    typeof user.id !== "string" ||
    typeof user.name !== "string" ||
    typeof user.displayName !== "string"
  ) {
    return undefined;
  }
  return value as PasskeyRegisterOptions;
}

/** The label the laptop lists the passkey under (it sanitizes again). */
export function passkeyLabel(text: string, fallback: string): string {
  const trimmed = text.trim().slice(0, MAX_PASSKEY_LABEL_LENGTH).trim();
  return trimmed === "" ? fallback : trimmed;
}

export async function registerPasskey(input: RegisterPasskeyInput): Promise<RegisterOutcome> {
  const begin = await input.rpc.call("auth:passkeyRegisterBegin", [{ password: input.password }]);
  if (!begin.ok) return beginFailure(begin);
  const options = parseRegisterOptions(begin.value);
  if (options === undefined) return "failed";
  let created: CreatedPasskey | "cancelled" | "exists";
  try {
    created = await input.create(options);
  } catch {
    return "failed";
  }
  if (created === "cancelled" || created === "exists") return created;
  const finish = await input.rpc.call("auth:passkeyRegisterFinish", [
    { ...created, label: input.label },
  ]);
  if (finish.ok) return "registered";
  const { error } = finish;
  if (error.kind === "offline" || error.kind === "timeout") return "offline";
  return "failed";
}
