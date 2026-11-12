// The browser's other machines: links to their own addresses, kept in prefs. The
// browser holds no other machine's credentials and dials no other origin, and
// each address here has been through `parseMachineAddress`, as a stored one
// reaches `window.location.assign`.

import type { PeerInfo } from "@jarvis/wire";
import type { MessageKey } from "./i18n";
import { DEFAULT_BRIDGE_PORT, DEFAULT_WEB_PORT, parseMachineAddress } from "./machine-address";

export type MachineLink = { name: string; port: number };

export type AddMachineLink =
  | { kind: "ok"; links: MachineLink[] }
  | { kind: "short-name" | "invalid" | "same" | "limit" };

export const MAX_MACHINE_LINKS = 16;
export const OWN_PEER_TIMEOUT_MS = 2000;

const PEER_PATH = "/jarvis-peer.json";

function isExactAddress(name: string, port: number, defaultPort: number): boolean {
  const address = parseMachineAddress(`${name}:${port}`, defaultPort);
  return address.kind === "ok" && address.name === name && address.port === port;
}

export function isMachineLink(value: unknown): value is MachineLink {
  if (typeof value !== "object" || value === null) return false;
  const { name, port } = value as Record<string, unknown>;
  if (typeof name !== "string" || typeof port !== "number") return false;
  return isExactAddress(name, port, DEFAULT_WEB_PORT);
}

function sameLink(a: MachineLink, b: MachineLink): boolean {
  return a.name === b.name && a.port === b.port;
}

/** One bad entry is dropped alone. Only the two fields survive. */
export function parseMachineLinks(value: unknown): MachineLink[] {
  if (!Array.isArray(value)) return [];
  const kept: MachineLink[] = [];
  for (const entry of value) {
    if (kept.length === MAX_MACHINE_LINKS) break;
    if (!isMachineLink(entry)) continue;
    const link = { name: entry.name, port: entry.port };
    if (!kept.some((other) => sameLink(other, link))) kept.push(link);
  }
  return kept;
}

/** Throws rather than build a URL from anything else. */
export function machineLinkUrl(link: MachineLink): string {
  if (!isMachineLink(link)) throw new Error("machines: not a valid machine link");
  return `https://${link.name}:${link.port}/`;
}

export function addMachineLink(links: readonly MachineLink[], text: string): AddMachineLink {
  const address = parseMachineAddress(text, DEFAULT_WEB_PORT);
  if (address.kind !== "ok") return { kind: address.kind };
  const link = { name: address.name, port: address.port };
  if (links.some((other) => sameLink(other, link))) return { kind: "same" };
  if (links.length >= MAX_MACHINE_LINKS) return { kind: "limit" };
  return { kind: "ok", links: [...links, link] };
}

export function removeMachineLink(
  links: readonly MachineLink[],
  name: string,
  port: number,
): MachineLink[] {
  return links.filter((link) => !sameLink(link, { name, port }));
}

/** Nothing for the limit: the field is gone once the list is full. */
export function machineLinkFailureKey(
  kind: Exclude<AddMachineLink["kind"], "ok">,
): MessageKey | undefined {
  switch (kind) {
    case "short-name":
      return "pair.joinShortName";
    case "invalid":
      return "pair.joinInvalid";
    case "same":
      return "pair.sameMachine";
    case "limit":
      return undefined;
  }
}

function peerFrom(value: unknown): PeerInfo | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { name, label, v, bridgePort, webPort } = value as Record<string, unknown>;
  if (
    typeof name !== "string" ||
    typeof label !== "string" ||
    typeof v !== "number" ||
    typeof bridgePort !== "number" ||
    typeof webPort !== "number" ||
    // A name a join would refuse has no use for its form.
    !isExactAddress(name, bridgePort, DEFAULT_BRIDGE_PORT)
  ) {
    return undefined;
  }
  return { name, label, v, bridgePort, webPort };
}

async function fetchPeer(
  fetcher: typeof fetch,
  hostname: string,
  signal: AbortSignal,
): Promise<PeerInfo | undefined> {
  try {
    const response = await fetcher(PEER_PATH, { signal });
    if (!response.ok) return undefined;
    const peer = peerFrom(await response.json());
    return peer?.name === hostname ? peer : undefined;
  } catch {
    return undefined;
  }
}

/** This origin's own description of itself, for its join form. `undefined` is
 *  every other answer, the limit included: the screen then stays as it was. */
export async function readOwnPeer(
  fetcher: typeof fetch,
  location: { hostname: string },
  timeoutMs: number,
): Promise<PeerInfo | undefined> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A race, as an abort reaches neither a fetcher that ignores it nor every body.
  const limit = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(undefined);
    }, timeoutMs);
  });
  try {
    return await Promise.race([fetchPeer(fetcher, location.hostname, controller.signal), limit]);
  } finally {
    clearTimeout(timer);
  }
}
