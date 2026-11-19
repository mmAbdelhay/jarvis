import { describe, expect, it } from "vitest";
import {
  MACHINE_INDEX_KEY,
  MAX_INDEX_BYTES,
  MAX_MACHINES,
  type MachineIndex,
  machineIdOf,
  machineKeys,
  parseMachineIndex,
} from "./machine-index";

const SECURE_STORE_KEY = /^[\w.-]+$/;

describe("the constants", () => {
  it("are the plan's values", () => {
    expect(MACHINE_INDEX_KEY).toBe("jarvis.machines");
    expect(MAX_MACHINES).toBe(16);
    expect(MAX_INDEX_BYTES).toBe(2000);
  });
});

describe("machineIdOf", () => {
  it("uses the lowercased name over the host", () => {
    expect(machineIdOf({ name: "Mac.Tail.ts.net", host: "100.1.2.3", port: 7717 })).toBe(
      "mac.tail.ts.net_7717",
    );
  });

  it("uses the host when there is no name", () => {
    expect(machineIdOf({ host: "192.168.1.5", port: 4317 })).toBe("192.168.1.5_4317");
  });

  it("replaces each colon of an IPv6 host", () => {
    expect(machineIdOf({ host: "fd7a:115c::1", port: 4317 })).toBe("fd7a_115c__1_4317");
  });

  it("stays a legal SecureStore key for a name, an IPv4 and an IPv6 host", () => {
    for (const endpoint of [
      { name: "mac.tail.ts.net", host: "0.0.0.0", port: 7717 },
      { host: "192.168.1.5", port: 4317 },
      { host: "fd7a:115c::1", port: 4317 },
    ]) {
      expect(machineIdOf(endpoint)).toMatch(SECURE_STORE_KEY);
    }
  });

  it("stays a legal key for a link-local IPv6 host with a zone", () => {
    // `canonicalAddress` keeps a zone, so a stored record can hold one, and
    // a `%` would throw in SecureStore and be dropped by parseMachineIndex.
    const id = machineIdOf({ host: "fe80::1%en0", port: 4317 });
    expect(id).toMatch(SECURE_STORE_KEY);
    expect(parseMachineIndex(JSON.stringify({ v: 1, ids: [id] }))?.ids).toEqual([id]);
  });

  it("differs by port", () => {
    for (const endpoint of [
      { name: "mac.tail.ts.net", host: "0.0.0.0" },
      { host: "192.168.1.5" },
      { host: "fd7a:115c::1" },
    ]) {
      expect(machineIdOf({ ...endpoint, port: 1 })).not.toBe(machineIdOf({ ...endpoint, port: 2 }));
    }
  });
});

describe("machineKeys", () => {
  const INDEX: MachineIndex = { v: 1, ids: ["a_1", "b_2"], legacy: "a_1" };

  it("answers the legacy keys for index.legacy", () => {
    expect(machineKeys("a_1", INDEX)).toEqual({
      record: "jarvis.pairing",
      token: "jarvis.token",
      refresh: "jarvis.refresh",
    });
  });

  it("answers per-machine keys for any other id", () => {
    expect(machineKeys("b_2", INDEX)).toEqual({
      record: "jarvis.m.b_2.pairing",
      token: "jarvis.m.b_2.token",
      refresh: "jarvis.m.b_2.refresh",
    });
  });

  it("answers per-machine keys for every id when the index has no legacy", () => {
    expect(machineKeys("a_1", { v: 1, ids: ["a_1"] }).record).toBe("jarvis.m.a_1.pairing");
  });
});

describe("parseMachineIndex", () => {
  it("reads a full index", () => {
    const index: MachineIndex = { v: 1, ids: ["a_1", "b_2"], active: "b_2", legacy: "a_1" };
    expect(parseMachineIndex(JSON.stringify(index))).toEqual(index);
  });

  it("answers undefined for bad JSON, a non-object, or a v other than 1", () => {
    for (const text of ["{nope", "null", "3", '"x"', "[]", "{}", '{"v":2,"ids":["a_1"]}']) {
      expect(parseMachineIndex(text)).toBeUndefined();
    }
  });

  it("drops an id that fails the pattern, keeping the others", () => {
    const text = JSON.stringify({
      v: 1,
      ids: ["a_1", "BAD", "x y", "", 7, "z".repeat(261), "b_2"],
    });
    expect(parseMachineIndex(text)?.ids).toEqual(["a_1", "b_2"]);
  });

  it("drops active or legacy not in ids", () => {
    const text = JSON.stringify({ v: 1, ids: ["a_1"], active: "gone_1", legacy: "gone_2" });
    const index = parseMachineIndex(text);
    expect(index).toEqual({ v: 1, ids: ["a_1"] });
    expect(index).not.toHaveProperty("active");
    expect(index).not.toHaveProperty("legacy");
  });

  it("drops active or legacy whose id was itself dropped", () => {
    const text = JSON.stringify({ v: 1, ids: ["BAD"], active: "BAD", legacy: "BAD" });
    expect(parseMachineIndex(text)).toEqual({ v: 1, ids: [] });
  });

  it("does not repeat an id", () => {
    expect(parseMachineIndex(JSON.stringify({ v: 1, ids: ["a_1", "a_1"] }))?.ids).toEqual(["a_1"]);
  });

  it("carries no field it does not know", () => {
    expect(parseMachineIndex(JSON.stringify({ v: 1, ids: [], token: "secret" }))).toEqual({
      v: 1,
      ids: [],
    });
  });

  it("reads a missing or non-array ids as empty", () => {
    expect(parseMachineIndex('{"v":1}')).toEqual({ v: 1, ids: [] });
    expect(parseMachineIndex('{"v":1,"ids":"a_1"}')).toEqual({ v: 1, ids: [] });
  });
});
