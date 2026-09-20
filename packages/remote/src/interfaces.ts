// Which of this machine's addresses a phone could be told to reach, and what
// kind of network each is on — the rows of Settings' "Reachable on" picker.
//
// By address range, never by interface name. Tailscale is `utun4` on macOS,
// `tailscale0` on Linux and `Tailscale` on Windows, but its address is in
// 100.64.0.0/10 on all three; a rule keyed on names would be three rules,
// each wrong the day a vendor renames an adapter.
//
// Pure. main.ts reads os.networkInterfaces() and hands the map in, so every
// branch here is a table test with no network involved.

export type BindKind = "loopback" | "lan" | "mesh" | "other";

export type BindChoice = { address: string; iface: string; kind: BindKind };

/** os.networkInterfaces()'s shape, narrowed to the one field read here. */
export type InterfaceMap = Readonly<Record<string, readonly { address: string }[] | undefined>>;

const KIND_ORDER: readonly BindKind[] = ["loopback", "lan", "mesh", "other"];

export function bindChoices(interfaces: InterfaceMap): BindChoice[] {
  const seen = new Set<string>();
  const choices: BindChoice[] = [];
  for (const [iface, entries] of Object.entries(interfaces)) {
    for (const { address } of entries ?? []) {
      const kind = classify(address);
      if (kind === undefined || seen.has(address)) continue;
      seen.add(address);
      choices.push({ address, iface, kind });
    }
  }
  // 127.0.0.1 is the config's default. If the host's listing somehow lacks
  // it, the default would render as a hand-typed "Other…" address, which
  // reads as though someone changed it.
  if (!seen.has("127.0.0.1")) {
    choices.unshift({ address: "127.0.0.1", iface: "", kind: "loopback" });
  }
  // Array.prototype.sort is stable, so interface order survives within a rank.
  return choices.sort((a, b) => rank(a) - rank(b));
}

function rank(choice: BindChoice): number {
  // IPv4 first within a kind: it is the address a person reads and types.
  return KIND_ORDER.indexOf(choice.kind) * 2 + (choice.address.includes(":") ? 1 : 0);
}

/** undefined = not offered at all. */
function classify(address: string): BindKind | undefined {
  const v4 = octets(address);
  if (v4 !== undefined) {
    const [a = 0, b = 0] = v4;
    if (a === 127) return "loopback";
    // 0.0.0.0/8 ("this network") and 255.255.255.255 (limited broadcast) are
    // not addresses a listener can bind to reach anyone. 224.0.0.0/4 covers
    // both multicast (224-239) and the reserved 240-255 block, including the
    // broadcast address itself.
    if (a === 0 || a >= 224) return undefined;
    // Link-local: what an adapter gives itself when DHCP failed. Nothing
    // routes to it, so offering it is offering a dead end.
    if (a === 169 && b === 254) return undefined;
    // RFC 6598 shared space, which Tailscale and Headscale allocate from.
    if (a === 100 && b >= 64 && b <= 127) return "mesh";
    // RFC 1918. ZeroTier's customary 10.147.x.x lands here on purpose: it is
    // a convention inside 10/8, not a reserved range, and a real office LAN
    // can use it too. The interface name beside it tells them apart.
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "lan";
    return "other";
  }

  const v6 = hextets(address);
  if (v6 === undefined) return undefined;
  if (v6.every((group) => group === 0)) return undefined; // "::" is no interface's address
  if (v6.every((group, index) => group === (index === 7 ? 1 : 0))) return "loopback";
  const [first = 0, second = 0, third = 0] = v6;
  // ff00::/8, IPv6 multicast: the IPv6 analogue of 224.0.0.0/4, not an
  // address anyone binds a reachable listener to.
  if ((first & 0xff00) === 0xff00) return undefined;
  // fe80::/10. Every macOS interface carries one — lo0, awdl0, llw0, each
  // utun — and binding one needs an OS-specific zone id (%en0, %12) a phone
  // cannot usefully be handed. Listing them would bury the three that matter.
  if ((first & 0xffc0) === 0xfe80) return undefined;
  // Tailscale's fixed unique-local prefix, fd7a:115c:a1e0::/48.
  if (first === 0xfd7a && second === 0x115c && third === 0xa1e0) return "mesh";
  // fc00::/7, unique local: IPv6's RFC 1918.
  if ((first & 0xfe00) === 0xfc00) return "lan";
  return "other";
}

function octets(address: string): number[] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return undefined;
  const values = parts.map(Number);
  return values.every((value) => value <= 255) ? values : undefined;
}

/** The eight 16-bit groups of an IPv6 address, or undefined if it is not one. */
function hextets(address: string): number[] | undefined {
  // A zone ("%en0", "%12") names the interface, not the address.
  const bare = (address.split("%")[0] ?? "").toLowerCase();
  const halves = bare.split("::");
  if (halves.length > 2) return undefined;
  const groups = (half: string | undefined): string[] =>
    half === undefined || half === "" ? [] : half.split(":");
  const head = groups(halves[0]);
  const tail = groups(halves[1]);
  if (![...head, ...tail].every((group) => /^[0-9a-f]{1,4}$/.test(group))) return undefined;
  const compressed = halves.length === 2;
  const missing = 8 - head.length - tail.length;
  if (compressed ? missing < 1 : missing !== 0) return undefined;
  const zeros = Array<string>(compressed ? missing : 0).fill("0");
  return [...head, ...zeros, ...tail].map((group) => Number.parseInt(group, 16));
}
