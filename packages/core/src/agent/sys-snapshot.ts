// The sys:snapshot push (contracts §6 #8): what the shell's status line and
// its "offer the Network doctor?" decision read. Built from jarvis-diag's
// sys.health + net.status (+ svc.list_failed for unit names), and from the
// configured model. Pure.
import type { ProviderKind, SysSnapshot } from "./contract.js";
import type { NetStatus } from "./doctor.js";
import { isRecord } from "./types.js";

export type SysHealth = {
  memTotalBytes: number;
  memUsedBytes: number;
  disks: { mount: string; sizeBytes: number; usedBytes: number }[];
  failedUnits: number;
};

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

export function parseSysHealth(data: unknown): SysHealth | undefined {
  if (!isRecord(data)) return undefined;
  const memTotalBytes = count(data["memTotalBytes"]);
  const memUsedBytes = count(data["memUsedBytes"]);
  const failedUnits = count(data["failedUnits"]);
  if (memTotalBytes === undefined || memUsedBytes === undefined || failedUnits === undefined)
    return undefined;
  const disks = (Array.isArray(data["disks"]) ? data["disks"] : []).flatMap((disk) => {
    if (!isRecord(disk) || typeof disk["mount"] !== "string") return [];
    const sizeBytes = count(disk["sizeBytes"]);
    const usedBytes = count(disk["usedBytes"]);
    return sizeBytes === undefined || usedBytes === undefined
      ? []
      : [{ mount: disk["mount"], sizeBytes, usedBytes }];
  });
  return { memTotalBytes, memUsedBytes, disks, failedUnits };
}

export function parseFailedUnitNames(data: unknown): string[] {
  const units = isRecord(data) && Array.isArray(data["units"]) ? data["units"] : [];
  return units.flatMap((unit) =>
    isRecord(unit) && typeof unit["unit"] === "string" ? [unit["unit"]] : [],
  );
}

const PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./];

/** Whether a provider at this base URL keeps logs on the user's own
 *  machines (spec §4: "a local or LAN provider"). */
export function isLocalBaseUrl(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".local")) return true;
  if (host.includes(":"))
    return host === "::1" || host.startsWith("fe80:") || /^f[cd][0-9a-f]{0,2}:/.test(host);
  return PRIVATE_V4.some((pattern) => pattern.test(host));
}

export function buildSysSnapshot(parts: {
  health?: SysHealth;
  net?: NetStatus;
  failedUnits: string[];
  model: { kind: ProviderKind; model: string; baseUrl: string; supportsTools: boolean } | null;
}): SysSnapshot {
  const root = parts.health?.disks.find((disk) => disk.mount === "/");
  const wifi = parts.net?.devices.find(
    (device) => device.type === "wifi" && device.state === "connected",
  );
  return {
    online: parts.net?.connectivity === "full",
    network: {
      connectivity: parts.net?.connectivity ?? "unknown",
      wifiSsid: wifi === undefined || wifi.connection === "" ? null : wifi.connection,
    },
    memTotalBytes: parts.health?.memTotalBytes ?? 0,
    memUsedBytes: parts.health?.memUsedBytes ?? 0,
    disk: { mount: "/", sizeBytes: root?.sizeBytes ?? 0, usedBytes: root?.usedBytes ?? 0 },
    failedUnits: parts.failedUnits,
    model:
      parts.model === null
        ? null
        : {
            kind: parts.model.kind,
            model: parts.model.model,
            local: isLocalBaseUrl(parts.model.baseUrl),
            supportsTools: parts.model.supportsTools,
          },
  };
}
