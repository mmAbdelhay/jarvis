import type { BindChoice } from "@jarvis/remote";

// Which of bindChoices()'s rows Settings' "Reachable on" picker shows as one
// of its two primary radios — Tailscale, Local Wi-Fi — and which fall back
// into the "Advanced…" disclosure (round 3). Pure, like bindChoices() itself:
// no DOM, so every branch here is a table test with no renderer involved.

// macOS (and Linux/Windows equivalents) hand out private-range addresses on
// interfaces that are never "the Wi-Fi/Ethernet a phone would join": a
// Thunderbolt bridge, an Internet-sharing vmnet, or a VPN/Tailscale tunnel.
// Matched by prefix, not by an exact name, so a second or third of any of
// them (bridge100, vmnet8, utun7) is skipped too — the same reasoning
// bindChoices()' own comment gives for classifying by address range rather
// than interface name.
const SKIPPED_LAN_PREFIXES = ["bridge", "vmnet", "utun"];

// Preferred over any other non-skipped interface, in this order: en0 is
// almost always Wi-Fi on a Mac, en1 the next most common (Ethernet dongle,
// or Wi-Fi on a machine whose built-in port is en1). Anything else still
// gets offered — just not preferred over these two.
const PREFERRED_LAN_INTERFACES = ["en0", "en1"];

export type PrimaryBindChoices = {
  /** The first `mesh` IPv4 choice, if this machine has one. */
  tailscale: BindChoice | undefined;
  /** The first `lan` IPv4 choice on a non-bridge interface, preferring
   *  en0/en1 over any other. */
  wifi: BindChoice | undefined;
  /** Every other choice, in bindChoices()' own order — what "Advanced…"
   *  lists. */
  rest: BindChoice[];
};

/** Same 100.64.0.0/10 range check as bindChoices()'s own "mesh"
 *  classification (packages/remote/src/interfaces.ts), restated here
 *  because that function classifies a *discovered interface*, not an
 *  arbitrary saved or typed address string — and the renderer may only ever
 *  `import type` from a workspace package (no-value-imports.test.ts), so a
 *  value import of the real classifier is not an option here. IPv4 only:
 *  Settings' own picker (primaryBindChoices above) never proposes an IPv6
 *  mesh address, so `remote.bindAddress` never holds one in practice. */
export function isMeshAddress(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return false;
  const [a, b] = parts.map(Number);
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
}

/** Splits `bindChoices()`'s output into the two rows Settings shows by
 *  default and everything else, which "Advanced…" holds. */
export function primaryBindChoices(choices: readonly BindChoice[]): PrimaryBindChoices {
  const tailscale = choices.find(
    (choice) => choice.kind === "mesh" && !choice.address.includes(":"),
  );

  const lanCandidates = choices.filter(
    (choice) =>
      choice.kind === "lan" &&
      !choice.address.includes(":") &&
      !SKIPPED_LAN_PREFIXES.some((prefix) => choice.iface.startsWith(prefix)),
  );
  const wifi =
    PREFERRED_LAN_INTERFACES.map((iface) =>
      lanCandidates.find((choice) => choice.iface === iface),
    ).find((choice): choice is BindChoice => choice !== undefined) ?? lanCandidates[0];

  const rest = choices.filter((choice) => choice !== tailscale && choice !== wifi);

  return { tailscale, wifi, rest };
}
