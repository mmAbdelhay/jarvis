// updates.list's structuredContent (M2 contracts §2) -> the sys:snapshot
// `updates` summary. Pure; field by field; checkedAt is RFC 3339 from the
// tool and epoch ms on the socket (M1 contracts §6 #23).
import type { UpdatesSummary } from "./contract.js";
import { isRecord } from "./types.js";

export function parseUpdatesList(data: unknown, now: number): UpdatesSummary | undefined {
  if (!isRecord(data) || !Array.isArray(data["items"])) return undefined;
  const seen = new Set<string>();
  let security = 0;
  for (const item of data["items"]) {
    if (!isRecord(item) || typeof item["id"] !== "string" || item["id"] === "") continue;
    const source = item["source"];
    if (source !== "apt" && source !== "flatpak") continue;
    const key = `${source}\u0000${item["id"]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (item["security"] === true) security++;
  }
  const parsed = typeof data["checkedAt"] === "string" ? Date.parse(data["checkedAt"]) : Number.NaN;
  return { count: seen.size, security, checkedAt: Number.isFinite(parsed) ? parsed : now };
}
