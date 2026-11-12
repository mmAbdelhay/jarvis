// What a person types to add a machine by name. This is the one place that text
// is normalised: the machine id a same-machine check compares comes from its
// answer, never from the text itself.

import { HOSTNAME_PATTERN } from "@jarvis/wire";

export const DEFAULT_BRIDGE_PORT = 7717;
export const DEFAULT_WEB_PORT = 7718;

export type MachineAddress =
  | { kind: "ok"; name: string; port: number }
  | { kind: "short-name" }
  | { kind: "invalid" };

const TAILNET_SUFFIX = ".ts.net";
// Two labels before the suffix: the machine and its tailnet.
const MIN_TAILNET_LABELS = 4;
const SHORT_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PORT_PATTERN = /^[1-9][0-9]{0,4}$/;
const MAX_PORT = 65535;

export function parseMachineAddress(text: string, defaultPort: number): MachineAddress {
  const trimmed = text.trim().toLowerCase();
  let name = trimmed;
  let port = defaultPort;
  const colon = trimmed.lastIndexOf(":");
  if (colon !== -1) {
    const portText = trimmed.slice(colon + 1);
    port = Number(portText);
    if (!PORT_PATTERN.test(portText) || port > MAX_PORT) return { kind: "invalid" };
    name = trimmed.slice(0, colon);
  }
  if (SHORT_NAME_PATTERN.test(name)) return { kind: "short-name" };
  if (!HOSTNAME_PATTERN.test(name) || !name.endsWith(TAILNET_SUFFIX)) return { kind: "invalid" };
  if (name.split(".").length < MIN_TAILNET_LABELS) return { kind: "invalid" };
  return { kind: "ok", name, port };
}
