import { networkInterfaces } from "node:os";
import { describe, expect, it } from "vitest";
import { type BindChoice, bindChoices, type InterfaceMap } from "./interfaces.js";

const at = (address: string) => ({ address });

// Shapes as os.networkInterfaces() reports them on each OS, cut to the field
// bindChoices reads. Interface names differ across all three; the ranges do
// not, which is the whole reason classification is by address.
const MACOS: InterfaceMap = {
  lo0: [at("127.0.0.1"), at("::1"), at("fe80::1%lo0")],
  en0: [at("fe80::1c2b:3aff:fe4d:5e6f%en0"), at("192.168.100.69")],
  awdl0: [at("fe80::a0b1:c2ff:fed3:e4f5%awdl0")],
  utun0: [at("fe80::ce81:b1c:bd2c:69e%utun0")],
  utun4: [at("100.84.17.203"), at("fd7a:115c:a1e0::1234:5678"), at("fe80::1%utun4")],
  bridge100: [at("192.168.64.1")],
};

const LINUX: InterfaceMap = {
  lo: [at("127.0.0.1"), at("::1")],
  eth0: [at("10.0.0.5"), at("2001:db8::5"), at("fe80::5054:ff:fe12:3456%eth0")],
  docker0: [at("172.17.0.1")],
  tailscale0: [at("100.101.102.103"), at("fd7a:115c:a1e0:ab12:4843:cd96:6265:6667")],
  ztabcdef12: [at("10.147.17.4"), at("fd80:56c2:e21c:3d4b:c99:93aa:bbcc:ddee")],
};

const WINDOWS: InterfaceMap = {
  "Wi-Fi": [at("fe80::9c1d:2e3f:4a5b:6c7d%12"), at("192.168.1.20")],
  "vEthernet (WSL)": [at("fe80::1234:5678:9abc:def0%30"), at("172.29.96.1")],
  Tailscale: [at("fd7a:115c:a1e0::9a01:2b3c"), at("100.72.1.9"), at("fe80::abcd%7")],
  "Ethernet 2": [at("169.254.12.34")],
  "Loopback Pseudo-Interface 1": [at("::1"), at("127.0.0.1")],
};

describe("bindChoices", () => {
  it.each<[string, InterfaceMap, BindChoice[]]>([
    [
      "macOS",
      MACOS,
      [
        { address: "127.0.0.1", iface: "lo0", kind: "loopback" },
        { address: "::1", iface: "lo0", kind: "loopback" },
        { address: "192.168.100.69", iface: "en0", kind: "lan" },
        { address: "192.168.64.1", iface: "bridge100", kind: "lan" },
        { address: "100.84.17.203", iface: "utun4", kind: "mesh" },
        { address: "fd7a:115c:a1e0::1234:5678", iface: "utun4", kind: "mesh" },
      ],
    ],
    [
      "Linux",
      LINUX,
      [
        { address: "127.0.0.1", iface: "lo", kind: "loopback" },
        { address: "::1", iface: "lo", kind: "loopback" },
        { address: "10.0.0.5", iface: "eth0", kind: "lan" },
        { address: "172.17.0.1", iface: "docker0", kind: "lan" },
        { address: "10.147.17.4", iface: "ztabcdef12", kind: "lan" },
        { address: "fd80:56c2:e21c:3d4b:c99:93aa:bbcc:ddee", iface: "ztabcdef12", kind: "lan" },
        { address: "100.101.102.103", iface: "tailscale0", kind: "mesh" },
        { address: "fd7a:115c:a1e0:ab12:4843:cd96:6265:6667", iface: "tailscale0", kind: "mesh" },
        { address: "2001:db8::5", iface: "eth0", kind: "other" },
      ],
    ],
    [
      "Windows",
      WINDOWS,
      [
        { address: "127.0.0.1", iface: "Loopback Pseudo-Interface 1", kind: "loopback" },
        { address: "::1", iface: "Loopback Pseudo-Interface 1", kind: "loopback" },
        { address: "192.168.1.20", iface: "Wi-Fi", kind: "lan" },
        { address: "172.29.96.1", iface: "vEthernet (WSL)", kind: "lan" },
        { address: "100.72.1.9", iface: "Tailscale", kind: "mesh" },
        { address: "fd7a:115c:a1e0::9a01:2b3c", iface: "Tailscale", kind: "mesh" },
      ],
    ],
  ])("classifies a %s interface map by address range", (_os, map, expected) => {
    expect(bindChoices(map)).toEqual(expected);
  });

  // One address per row, found by its interface so the always-present
  // loopback entry does not get in the way. `undefined` means excluded.
  it.each<[string, BindChoice["kind"] | undefined]>([
    ["127.4.5.6", "loopback"],
    ["172.15.255.255", "other"],
    ["100.64.0.0", "mesh"],
    ["FD7A:115C:A1E0::1", "mesh"],
    ["::ffff:192.168.1.5", undefined],
    ["100.64.0.1", "mesh"],
    ["100.127.255.254", "mesh"],
    ["100.63.255.255", "other"],
    ["100.128.0.1", "other"],
    ["10.147.17.4", "lan"],
    ["172.16.0.1", "lan"],
    ["172.31.255.254", "lan"],
    ["172.32.0.1", "other"],
    ["192.168.0.1", "lan"],
    ["8.8.8.8", "other"],
    ["169.254.1.1", undefined],
    ["fe80::1%en0", undefined],
    ["febf::1", undefined],
    ["fec0::1", "other"],
    ["fc00::1", "lan"],
    ["fd12:3456::1", "lan"],
    ["fd7a:115c:a1e0::1", "mesh"],
    ["fd7a:115c:a1e1::1", "lan"],
    ["2001:db8::1", "other"],
    ["::", undefined],
    // Nobody can bind a reachable listener to these by choice: 0.0.0.0/8,
    // the limited broadcast address, and the multicast ranges either
    // protocol reserves for it.
    ["0.0.0.0", undefined],
    ["0.1.2.3", undefined],
    ["255.255.255.255", undefined],
    ["224.0.0.1", undefined],
    ["239.255.255.255", undefined],
    ["240.0.0.1", undefined],
    ["ff00::1", undefined],
    ["ff02::1", undefined],
    ["ffff::1", undefined],
    ["not-an-address", undefined],
  ])("%s is %s", (address, kind) => {
    const found = bindChoices({ x: [{ address }] }).find((choice) => choice.iface === "x");
    expect(found?.kind).toBe(kind);
  });

  it("always offers 127.0.0.1, so the config default is a choice and never 'Other…'", () => {
    expect(bindChoices({})).toEqual([{ address: "127.0.0.1", iface: "", kind: "loopback" }]);
    expect(bindChoices({ en0: [at("192.168.1.20")] })).toEqual([
      { address: "127.0.0.1", iface: "", kind: "loopback" },
      { address: "192.168.1.20", iface: "en0", kind: "lan" },
    ]);
  });

  it("lists an address once, under the first interface that has it", () => {
    expect(bindChoices({ lo0: [at("127.0.0.1")], lo1: [at("127.0.0.1")] })).toEqual([
      { address: "127.0.0.1", iface: "lo0", kind: "loopback" },
    ]);
  });

  it("skips an interface with no address list", () => {
    expect(bindChoices({ en5: undefined, lo: [at("127.0.0.1")] })).toEqual([
      { address: "127.0.0.1", iface: "lo", kind: "loopback" },
    ]);
  });

  // A type check as much as a behaviour check: the real host's map must be
  // accepted as-is, which is what main.ts hands the dispatch table.
  it("accepts os.networkInterfaces() directly", () => {
    expect(bindChoices(networkInterfaces())[0]?.kind).toBe("loopback");
  });
});
