// jarvis.yaml's `remote:` section as the OS bridge reads it (design §3.3):
// the same keys the Jarvis app uses (enabled, bindAddress, port,
// idleDisableMinutes, tls), so one phone app works with both. Off by default,
// loopback by default (Tailscale or a LAN address is the user's choice).
// Written key by key so comments and other sections stay. It does not import
// ../../config.js (that would pull the desktop app into the OS bundle).
//
// No electron here (core/no-electron.test.ts).
import { isIP } from "node:net";
import type { BridgeConfig } from "@jarvis/remote";
import type { RemoteConfigureRequest } from "@jarvis/wire";
import { parse, parseDocument } from "yaml";
import type { ConfigIo } from "./provider-config.js";

export type OsRemoteConfig = {
  enabled: boolean;
  bindAddress: string;
  port: number;
  idleDisableMinutes: number;
  tls: { certPath?: string; keyPath?: string };
};

export const DEFAULT_OS_REMOTE: OsRemoteConfig = {
  enabled: false,
  bindAddress: "127.0.0.1",
  port: 7717,
  idleDisableMinutes: 0,
  tls: {},
};
const MAX_IDLE_MINUTES = 10_080;

const isMissing = (error: unknown) => (error as { code?: unknown } | null)?.code === "ENOENT";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseOsRemoteSection(raw: unknown): OsRemoteConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_OS_REMOTE, tls: {} };
  if (!isRecord(raw)) throw new Error("Config `remote` must be an object");
  const { enabled, bindAddress, port, idleDisableMinutes, tls } = raw;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new Error("Config `remote.enabled` must be true or false");
  }
  if (bindAddress !== undefined && (typeof bindAddress !== "string" || isIP(bindAddress) === 0)) {
    throw new Error("Config `remote.bindAddress` must be an IP address such as 127.0.0.1");
  }
  if (
    port !== undefined &&
    (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535)
  ) {
    throw new Error("Config `remote.port` must be a whole number from 1 to 65535");
  }
  if (
    idleDisableMinutes !== undefined &&
    (typeof idleDisableMinutes !== "number" ||
      !Number.isInteger(idleDisableMinutes) ||
      idleDisableMinutes < 0 ||
      idleDisableMinutes > MAX_IDLE_MINUTES)
  ) {
    throw new Error("Config `remote.idleDisableMinutes` must be 0 to 10080");
  }
  const paths: OsRemoteConfig["tls"] = {};
  if (tls !== undefined) {
    if (!isRecord(tls)) throw new Error("Config `remote.tls` must be an object");
    const { certPath, keyPath } = tls;
    for (const [key, value] of [
      ["certPath", certPath],
      ["keyPath", keyPath],
    ] as const) {
      if (value !== undefined && (typeof value !== "string" || value === "")) {
        throw new Error(`Config \`remote.tls.${key}\` must be a non-empty string`);
      }
    }
    if ((certPath === undefined) !== (keyPath === undefined)) {
      throw new Error("Config `remote.tls.certPath` and `remote.tls.keyPath` must be set together");
    }
    if (typeof certPath === "string" && typeof keyPath === "string") {
      paths.certPath = certPath;
      paths.keyPath = keyPath;
    }
  }
  return {
    enabled: enabled === true,
    bindAddress: typeof bindAddress === "string" ? bindAddress : DEFAULT_OS_REMOTE.bindAddress,
    port: typeof port === "number" ? port : DEFAULT_OS_REMOTE.port,
    idleDisableMinutes: typeof idleDisableMinutes === "number" ? idleDisableMinutes : 0,
    tls: paths,
  };
}

export async function readOsRemoteConfig(path: string, io: ConfigIo): Promise<OsRemoteConfig> {
  let text: string;
  try {
    text = await io.readFile(path);
  } catch (error) {
    if (isMissing(error)) return { ...DEFAULT_OS_REMOTE, tls: {} };
    throw error;
  }
  const root: unknown = parse(text);
  return parseOsRemoteSection(isRecord(root) ? root["remote"] : undefined);
}

export async function writeOsRemoteSection(
  path: string,
  patch: RemoteConfigureRequest,
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
  const existing: unknown = document.toJS()?.remote;
  if (existing !== undefined && existing !== null && !isRecord(existing)) {
    throw new Error("Config `remote` must be an object");
  }
  document.setIn(["remote", "enabled"], patch.enabled);
  if (patch.bindAddress !== undefined) document.setIn(["remote", "bindAddress"], patch.bindAddress);
  if (patch.port !== undefined) document.setIn(["remote", "port"], patch.port);
  await io.writeFile(path, document.toString());
}

export function toBridgeConfig(config: OsRemoteConfig): BridgeConfig {
  return {
    enabled: config.enabled,
    bindAddress: config.bindAddress,
    port: config.port,
    tls: { ...config.tls },
    // No sidecars (code-server, dbgate…) and no browser client on Rafiq.
    sidecarProxy: false,
    idleDisableMinutes: config.idleDisableMinutes,
    web: { enabled: false, port: config.port === 65_535 ? 65_534 : config.port + 1 },
  };
}
