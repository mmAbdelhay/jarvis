import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OS_CONTROL_PUSHES, OS_CONTROL_REQUESTS } from "@jarvis/wire";
import { describe, expect, it } from "vitest";
import { CONTROL_PROTOCOL_VERSION, encodeJsonFrame } from "../control/frames.js";

const JSON_PATH = fileURLToPath(new URL("../../../../wire/os-control.json", import.meta.url));

describe("packages/wire/os-control.json", () => {
  const file = JSON.parse(readFileSync(JSON_PATH, "utf8")) as {
    protocolVersion: number;
    frame: { headerBytes: number; kinds: { json: number; binary: number } };
    handshake: { serverLabel: string; clientLabel: string };
    requests: string[];
    pushes: string[];
  };

  it("lists the same channels as @jarvis/wire", () => {
    expect(file.requests).toEqual(Object.values(OS_CONTROL_REQUESTS));
    expect(file.pushes).toEqual(Object.values(OS_CONTROL_PUSHES));
  });

  it("describes the real frame header and protocol version", () => {
    expect(file.protocolVersion).toBe(CONTROL_PROTOCOL_VERSION);
    const frame = encodeJsonFrame({ t: "x" });
    expect(file.frame.headerBytes).toBe(5);
    expect(frame.readUInt32BE(0)).toBe(frame.length - file.frame.headerBytes);
    expect(frame[4]).toBe(file.frame.kinds.json);
    expect(file.handshake).toEqual({
      serverLabel: "jarvisd-server",
      clientLabel: "jarvisd-client",
    });
  });
});
