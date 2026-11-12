import { describe, expect, it } from "vitest";
import { DEFAULT_BRIDGE_PORT, DEFAULT_WEB_PORT, parseMachineAddress } from "./machine-address";

const NAME = "mac.tail1234.ts.net";

describe("parseMachineAddress", () => {
  it("names the default ports", () => {
    expect(DEFAULT_BRIDGE_PORT).toBe(7717);
    expect(DEFAULT_WEB_PORT).toBe(7718);
  });

  it("a full name takes the default port it is given", () => {
    expect(parseMachineAddress(NAME, 7717)).toEqual({ kind: "ok", name: NAME, port: 7717 });
    expect(parseMachineAddress(NAME, 7718)).toEqual({ kind: "ok", name: NAME, port: 7718 });
  });

  it("name:port takes that port", () => {
    expect(parseMachineAddress(`${NAME}:9000`, 7717)).toEqual({
      kind: "ok",
      name: NAME,
      port: 9000,
    });
  });

  it("the port's limits are in", () => {
    expect(parseMachineAddress(`${NAME}:1`, 7717)).toMatchObject({ kind: "ok", port: 1 });
    expect(parseMachineAddress(`${NAME}:65535`, 7717)).toMatchObject({ kind: "ok", port: 65535 });
  });

  it("uppercase is lowered and spaces around it trimmed", () => {
    expect(parseMachineAddress("  MAC.Tail1234.TS.NET:9000 \n", 7717)).toEqual({
      kind: "ok",
      name: NAME,
      port: 9000,
    });
  });

  it.each(["mac", "MAC", " mac ", "mac:7717", "my-mac"])("%j is a short name", (text) => {
    expect(parseMachineAddress(text, 7717)).toEqual({ kind: "short-name" });
  });

  it.each([
    ["a bare IPv4", "100.79.83.16"],
    ["an IPv4 with a port", "100.79.83.16:7717"],
    ["an IPv6", "::1"],
    ["a bracketed IPv6", "[fd7a::1]:7717"],
    ["port 0", `${NAME}:0`],
    ["port 70000", `${NAME}:70000`],
    ["a port that is no number", `${NAME}:abc`],
    ["a port with a leading zero", `${NAME}:07717`],
    ["an empty port", `${NAME}:`],
    ["two ports", `${NAME}:77:88`],
    ["a name that is not .ts.net", "mac.example.com"],
    ["one label before .ts.net", "tail1234.ts.net"],
    ["only .ts.net", "ts.net"],
    ["a trailing dot", `${NAME}.`],
    ["a space inside", "mac tail.ts.net"],
    ["a short name with a space", "my mac"],
    ["a short name with a bad port", "mac:70000"],
    ["a scheme", `wss://${NAME}`],
    ["a path", `${NAME}/pair`],
    ["nothing", ""],
    ["only spaces", "   "],
    ["only a port", ":7717"],
  ])("%s is invalid", (_label, text) => {
    expect(parseMachineAddress(text, 7717)).toEqual({ kind: "invalid" });
  });
});
