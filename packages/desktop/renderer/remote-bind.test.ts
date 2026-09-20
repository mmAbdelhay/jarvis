import { describe, expect, it } from "vitest";
import type { BindChoice } from "@jarvis/remote";
import { primaryBindChoices } from "./remote-bind.js";

function choice(address: string, iface: string, kind: BindChoice["kind"]): BindChoice {
  return { address, iface, kind };
}

describe("primaryBindChoices", () => {
  it("picks the first mesh IPv4 address as tailscale", () => {
    const choices = [
      choice("127.0.0.1", "lo0", "loopback"),
      choice("100.84.17.203", "utun4", "mesh"),
      choice("100.84.17.204", "utun5", "mesh"),
    ];
    expect(primaryBindChoices(choices).tailscale).toEqual(choices[1]);
  });

  it("never picks a mesh IPv6 address as tailscale", () => {
    const choices = [choice("fd7a:115c:a1e0::1", "utun4", "mesh")];
    expect(primaryBindChoices(choices).tailscale).toBeUndefined();
  });

  it("is undefined when this machine has no mesh address", () => {
    const choices = [choice("127.0.0.1", "lo0", "loopback"), choice("192.168.1.5", "en0", "lan")];
    expect(primaryBindChoices(choices).tailscale).toBeUndefined();
  });

  it("prefers en0 over any other lan interface for wifi", () => {
    const choices = [choice("192.168.1.9", "en2", "lan"), choice("192.168.1.5", "en0", "lan")];
    expect(primaryBindChoices(choices).wifi).toEqual(choices[1]);
  });

  it("prefers en1 over a non-preferred interface when en0 is absent", () => {
    const choices = [choice("10.0.0.9", "en3", "lan"), choice("10.0.0.5", "en1", "lan")];
    expect(primaryBindChoices(choices).wifi).toEqual(choices[1]);
  });

  it("falls back to the first non-skipped lan interface when neither en0 nor en1 exists", () => {
    const choices = [choice("10.0.0.9", "en3", "lan"), choice("10.0.0.5", "en4", "lan")];
    expect(primaryBindChoices(choices).wifi).toEqual(choices[0]);
  });

  it("skips bridge*, vmnet* and utun* interfaces entirely for wifi", () => {
    const choices = [
      choice("192.168.64.1", "bridge0", "lan"),
      choice("192.168.65.1", "vmnet8", "lan"),
      choice("192.168.66.1", "utun9", "lan"),
    ];
    expect(primaryBindChoices(choices).wifi).toBeUndefined();
  });

  it("never picks a lan IPv6 address for wifi", () => {
    const choices = [choice("fc00::1", "en0", "lan")];
    expect(primaryBindChoices(choices).wifi).toBeUndefined();
  });

  it("is undefined when this machine has no eligible lan address", () => {
    const choices = [choice("127.0.0.1", "lo0", "loopback")];
    expect(primaryBindChoices(choices).wifi).toBeUndefined();
  });

  it("puts everything else in rest, in the input's own order", () => {
    const choices = [
      choice("127.0.0.1", "lo0", "loopback"),
      choice("192.168.1.5", "en0", "lan"),
      choice("100.84.17.203", "utun4", "mesh"),
      choice("192.168.64.1", "bridge0", "lan"),
      choice("8.8.8.8", "eth0", "other"),
    ];
    const { tailscale, wifi, rest } = primaryBindChoices(choices);
    expect(tailscale).toEqual(choices[2]);
    expect(wifi).toEqual(choices[1]);
    expect(rest).toEqual([choices[0], choices[3], choices[4]]);
  });

  it("returns every choice in rest when neither primary is available", () => {
    const choices = [choice("127.0.0.1", "lo0", "loopback"), choice("8.8.8.8", "eth0", "other")];
    expect(primaryBindChoices(choices).rest).toEqual(choices);
  });
});
