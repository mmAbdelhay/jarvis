// jarvis.yaml `os.computerUse` (Rafiq v1.1 contracts §2):
//   enabled: {<providerId>: boolean}   cloudConsent: {<providerId>: RFC3339}
// Read leniently: a malformed entry is dropped, so computer use stays OFF for
// it (fail closed) and the providers still load. Consent belongs to a
// provider's endpoint: agent-service drops it when the endpoint changes.
//
// No electron here (core/no-electron.test.ts).
import { PROVIDER_ID_PATTERN, RESERVED_PROVIDER_IDS } from "@jarvis/wire";
import { isMap, parseDocument } from "yaml";
import type { ConfigIo } from "./provider-config.js";

export type ComputerUseSettings = {
  enabled: Record<string, boolean>;
  cloudConsent: Record<string, string>;
};

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isProviderId = (id: string) => PROVIDER_ID_PATTERN.test(id) && !RESERVED_PROVIDER_IDS.has(id);

export function emptyComputerUse(): ComputerUseSettings {
  return { enabled: {}, cloudConsent: {} };
}

export function isEmptyComputerUse(settings: ComputerUseSettings): boolean {
  return (
    Object.keys(settings.enabled).length === 0 && Object.keys(settings.cloudConsent).length === 0
  );
}

export function parseComputerUse(raw: unknown): ComputerUseSettings {
  const out = emptyComputerUse();
  if (!isObject(raw)) return out;
  const enabled = raw["enabled"];
  if (isObject(enabled)) {
    for (const [id, value] of Object.entries(enabled)) {
      if (isProviderId(id) && typeof value === "boolean") out.enabled[id] = value;
    }
  }
  const consent = raw["cloudConsent"];
  if (isObject(consent)) {
    for (const [id, value] of Object.entries(consent)) {
      const text = value instanceof Date ? value.toISOString() : value;
      if (
        isProviderId(id) &&
        typeof text === "string" &&
        RFC3339.test(text) &&
        Number.isFinite(Date.parse(text))
      ) {
        out.cloudConsent[id] = text;
      }
    }
  }
  return out;
}

export function pruneComputerUse(
  settings: ComputerUseSettings,
  keep: (providerId: string) => boolean,
): ComputerUseSettings {
  return {
    enabled: Object.fromEntries(Object.entries(settings.enabled).filter(([id]) => keep(id))),
    cloudConsent: Object.fromEntries(
      Object.entries(settings.cloudConsent).filter(([id]) => keep(id)),
    ),
  };
}

export function computerUseNode(settings: ComputerUseSettings): Record<string, unknown> {
  return { enabled: { ...settings.enabled }, cloudConsent: { ...settings.cloudConsent } };
}

export async function writeComputerUse(
  path: string,
  settings: ComputerUseSettings,
  io: ConfigIo,
): Promise<void> {
  let text = "";
  try {
    text = await io.readFile(path);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") throw error;
  }
  const document = parseDocument(text);
  if (document.errors.length > 0) {
    throw new Error(`jarvis.yaml does not parse: ${document.errors[0]?.message ?? "unknown"}`);
  }
  if (!isMap(document.get("os", true))) document.set("os", document.createNode({}));
  document.setIn(["os", "computerUse"], document.createNode(computerUseNode(settings)));
  await io.writeFile(path, document.toString());
}
