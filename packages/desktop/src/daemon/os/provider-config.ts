// jarvis.yaml's `provider:` section (spec §4): kind, base URL, model — never
// the key, which lives in the keyring. Read and written by the Jarvis OS
// daemon only. The write edits that one key in the user's own document, so
// comments and every other section stay as they were (like config-file.ts's
// daemon.enabled). It does not import ../../config.js: that would pull all of
// @jarvis/platform into the OS bundle, and parseConfig ignores this section
// anyway, so editing it cannot make a desktop config unloadable.
//
// No electron here (core/no-electron.test.ts).
import {
  ACCOUNT_BASE_URLS,
  ACCOUNT_IDS,
  type AccountId,
  isAccountId,
  PROVIDER_KINDS,
  type ProviderKind,
} from "@jarvis/core";
import { parseBaseUrl } from "@jarvis/wire";
import { parse, parseDocument } from "yaml";

export type ProviderSection = {
  kind: ProviderKind;
  account?: AccountId;
  baseUrl: string;
  model: string;
  auth: "api-key" | "subscription";
  /** false when probe found the model cannot call tools (spec §4, §10). */
  supportsTools: boolean;
};

export type ConfigIo = {
  readFile(path: string): Promise<string>;
  /** Replaces the file whole (atomically, in the daemon). */
  writeFile(path: string, text: string): Promise<void>;
};

const isMissing = (error: unknown) => (error as { code?: unknown }).code === "ENOENT";

export function parseProviderSection(raw: unknown): ProviderSection | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Config `provider` must be an object");
  const section = raw as Record<string, unknown>;
  const { kind, model, auth, tools } = section;
  if (typeof kind !== "string" || !(PROVIDER_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Config \`provider.kind\` must be one of ${PROVIDER_KINDS.join(", ")}`);
  }
  const account = section["account"];
  if (kind === "account") {
    if (!isAccountId(account)) {
      throw new Error(`Config \`provider.account\` must be one of ${ACCOUNT_IDS.join(", ")}`);
    }
    if (typeof model !== "string" || model.length === 0 || model.length > 200) {
      throw new Error("Config `provider.model` must be a non-empty string");
    }
    if (tools !== undefined && typeof tools !== "boolean")
      throw new Error("Config `provider.tools` must be true or false");
    return {
      kind: "account",
      account,
      baseUrl: ACCOUNT_BASE_URLS[account],
      model,
      auth: "api-key",
      supportsTools: tools !== false,
    };
  }
  if (account !== undefined) throw new Error("Config `provider.account` is only for kind account");

  const baseUrl = parseBaseUrl(section["baseUrl"]);
  if (baseUrl === undefined)
    throw new Error("Config `provider.baseUrl` must be an http(s) URL without credentials");
  if (typeof model !== "string" || model.length === 0 || model.length > 200) {
    throw new Error("Config `provider.model` must be a non-empty string");
  }
  if (
    auth !== undefined &&
    auth !== "api-key" &&
    !(auth === "subscription" && kind === "anthropic")
  ) {
    throw new Error("Config `provider.auth` must be api-key, or subscription for anthropic");
  }
  if (tools !== undefined && typeof tools !== "boolean")
    throw new Error("Config `provider.tools` must be true or false");
  return {
    kind: kind as ProviderKind,
    baseUrl,
    model,
    auth: auth === "subscription" ? "subscription" : "api-key",
    supportsTools: tools !== false,
  };
}

export async function readProviderSection(
  path: string,
  io: ConfigIo,
): Promise<ProviderSection | null> {
  let text: string;
  try {
    text = await io.readFile(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  const root: unknown = parse(text);
  if (typeof root !== "object" || root === null) return null;
  return parseProviderSection((root as Record<string, unknown>)["provider"]);
}

export async function writeProviderSection(
  path: string,
  section: ProviderSection,
  io: ConfigIo,
): Promise<void> {
  let text = "";
  try {
    text = await io.readFile(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const document = parseDocument(text);
  if (document.errors.length > 0) {
    throw new Error(`jarvis.yaml does not parse: ${document.errors[0]?.message ?? "unknown"}`);
  }
  const value: Record<string, unknown> = {
    kind: section.kind,
    baseUrl: section.baseUrl,
    model: section.model,
  };
  if (section.kind === "account" && section.account !== undefined)
    value["account"] = section.account;

  if (!section.supportsTools) value["tools"] = false;
  if (section.auth === "subscription") value["auth"] = "subscription";
  document.setIn(["provider"], document.createNode(value));
  await io.writeFile(path, document.toString());
}
