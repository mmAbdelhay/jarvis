import { encodeMessage, PROTOCOL_VERSION, type PeerInfo } from "@jarvis/wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  A_ID,
  B_ID,
  type MachinesHarness,
  machinesHarness,
  recordOf,
  refreshKeyOf,
  refreshTokenOf,
  settle,
} from "./fake-machines";
import type { FakeSocket } from "./fake-transport";
import { MACHINE_INDEX_KEY } from "./machine-index";
import { submitJoin, type SubmitJoinDeps } from "./pair-flow";
import { joinMachine } from "./pairing";
import { PairingAlreadyExistsError } from "./pairing-record";
import {
  addMachineLink,
  isMachineLink,
  machineLinkFailureKey,
  machineLinkUrl,
  MAX_MACHINE_LINKS,
  parseMachineLinks,
  readOwnPeer,
  removeMachineLink,
} from "./web-machines";

const NAME = "mac.tail1234.ts.net";
const OTHER = "mini.tail1234.ts.net";

function linksOf(count: number) {
  return Array.from({ length: count }, (_, i) => ({ name: `m${i}.tail1234.ts.net`, port: 7718 }));
}

describe("machineLinkUrl", () => {
  it("is always https to the name and port", () => {
    expect(machineLinkUrl({ name: NAME, port: 7718 })).toBe(`https://${NAME}:7718/`);
    expect(machineLinkUrl({ name: NAME, port: 9000 })).toBe(`https://${NAME}:9000/`);
  });

  it.each([
    ["a path", { name: `${NAME}/evil`, port: 7718 }],
    ["userinfo", { name: `user@${NAME}`, port: 7718 }],
    ["another port inside the name", { name: `${NAME}:1`, port: 7718 }],
    ["a name off the tailnet", { name: "evil.example.com", port: 7718 }],
    ["an IP", { name: "192.168.1.5", port: 7718 }],
    ["a port out of range", { name: NAME, port: 70000 }],
    ["a fractional port", { name: NAME, port: 77.5 }],
    ["no port", { name: NAME, port: 0 }],
  ])("refuses to build one from %s", (_label, link) => {
    expect(() => machineLinkUrl(link)).toThrow();
  });
});

describe("addMachineLink", () => {
  it("takes a full name at the default web port, 7718", () => {
    expect(addMachineLink([], NAME)).toEqual({ kind: "ok", links: [{ name: NAME, port: 7718 }] });
  });

  it("takes name:port, normalised, after the links already held", () => {
    const held = [{ name: OTHER, port: 7718 }];
    expect(addMachineLink(held, `  ${NAME.toUpperCase()}:9000 `)).toEqual({
      kind: "ok",
      links: [...held, { name: NAME, port: 9000 }],
    });
    expect(held).toHaveLength(1);
  });

  it("asks for the full name for a short one", () => {
    expect(addMachineLink([], "mac")).toEqual({ kind: "short-name" });
  });

  it.each(["192.168.1.5", "https://mac.tail1234.ts.net/", `${NAME}:0`, "evil.example.com", ""])(
    "refuses %j",
    (text) => {
      expect(addMachineLink([], text)).toEqual({ kind: "invalid" });
    },
  );

  it("says same for a link already held, at any letter case", () => {
    const held = [{ name: NAME, port: 7718 }];
    expect(addMachineLink(held, NAME.toUpperCase())).toEqual({ kind: "same" });
    expect(addMachineLink(held, `${NAME}:7718`)).toEqual({ kind: "same" });
  });

  it("the same name at another port is another link", () => {
    expect(addMachineLink([{ name: NAME, port: 7718 }], `${NAME}:9000`).kind).toBe("ok");
  });

  it("holds 16, and refuses a 17th", () => {
    expect(MAX_MACHINE_LINKS).toBe(16);
    expect(addMachineLink(linksOf(15), NAME).kind).toBe("ok");
    expect(addMachineLink(linksOf(16), NAME)).toEqual({ kind: "limit" });
  });

  it("each refusal has a message, but for the limit, whose field has gone", () => {
    expect(machineLinkFailureKey("short-name")).toBe("pair.joinShortName");
    expect(machineLinkFailureKey("invalid")).toBe("pair.joinInvalid");
    expect(machineLinkFailureKey("same")).toBe("pair.sameMachine");
    expect(machineLinkFailureKey("limit")).toBeUndefined();
  });
});

describe("removeMachineLink", () => {
  it("removes that name at that port alone", () => {
    const a = { name: NAME, port: 7718 };
    const b = { name: NAME, port: 9000 };
    const c = { name: OTHER, port: 7718 };
    expect(removeMachineLink([a, b, c], NAME, 7718)).toEqual([b, c]);
    expect(removeMachineLink([a, b, c], "gone.tail1234.ts.net", 7718)).toEqual([a, b, c]);
  });
});

describe("parseMachineLinks", () => {
  it("anything but an array holds nothing", () => {
    for (const value of [undefined, null, "x", 3, {}]) {
      expect(parseMachineLinks(value)).toEqual([]);
    }
  });

  it("drops each invalid entry alone, and anything else an entry carries", () => {
    const good = { name: NAME, port: 7718 };
    expect(
      parseMachineLinks([
        null,
        "x",
        { name: NAME },
        { name: 3, port: 7718 },
        { name: "evil.example.com", port: 7718 },
        { name: `${NAME}/evil`, port: 7718 },
        { name: NAME.toUpperCase(), port: 7718 },
        { ...good, token: "secret" },
      ]),
    ).toEqual([good]);
  });

  it("keeps the first of a duplicate, and at most 16", () => {
    const first = { name: NAME, port: 7718 };
    expect(parseMachineLinks([first, { ...first }])).toEqual([first]);
    expect(parseMachineLinks(linksOf(20))).toEqual(linksOf(16));
  });

  it("isMachineLink agrees with what the URL will build from", () => {
    expect(isMachineLink({ name: NAME, port: 7718 })).toBe(true);
    expect(isMachineLink({ name: "evil.example.com", port: 7718 })).toBe(false);
  });
});

describe("readOwnPeer", () => {
  const PEER: PeerInfo = { name: NAME, label: "mac", v: 2, bridgePort: 7717, webPort: 7718 };
  const LOCATION = { hostname: NAME };

  afterEach(() => {
    vi.useRealTimers();
  });

  function answering(body: string, status = 200): typeof fetch {
    return vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;
  }

  it("answers the peer from its own origin's path", async () => {
    const fetcher = answering(JSON.stringify(PEER));
    expect(await readOwnPeer(fetcher, LOCATION, 2000)).toEqual(PEER);
    expect(vi.mocked(fetcher).mock.calls[0]?.[0]).toBe("/jarvis-peer.json");
  });

  it("is undefined on a 404", async () => {
    expect(await readOwnPeer(answering(JSON.stringify(PEER), 404), LOCATION, 2000)).toBeUndefined();
  });

  it("is undefined on bad JSON", async () => {
    expect(await readOwnPeer(answering("<html>"), LOCATION, 2000)).toBeUndefined();
  });

  it("is undefined when the fetch itself fails", async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError("blocked by CSP");
    }) as unknown as typeof fetch;
    expect(await readOwnPeer(fetcher, LOCATION, 2000)).toBeUndefined();
  });

  it("is undefined for a name differing from the hostname", async () => {
    expect(
      await readOwnPeer(answering(JSON.stringify(PEER)), { hostname: OTHER }, 2000),
    ).toBeUndefined();
  });

  it.each([
    ["no bridge port", { ...PEER, bridgePort: undefined }],
    ["a bridge port out of range", { ...PEER, bridgePort: 70000 }],
    ["a text bridge port", { ...PEER, bridgePort: "7717" }],
    ["no name", { ...PEER, name: undefined }],
    ["no label", { ...PEER, label: undefined }],
    ["no web port", { ...PEER, webPort: undefined }],
    ["no version", { ...PEER, v: undefined }],
    ["an array", [PEER]],
    ["null", null],
  ])("is undefined for an answer with %s", async (_label, body) => {
    expect(await readOwnPeer(answering(JSON.stringify(body)), LOCATION, 2000)).toBeUndefined();
  });

  it("is undefined for a name a join would refuse, which offers no form to fail", async () => {
    const name = "jarvis.test";
    const peer = { ...PEER, name };
    expect(
      await readOwnPeer(answering(JSON.stringify(peer)), { hostname: name }, 2000),
    ).toBeUndefined();
  });

  it("is undefined at the time limit, and aborts the fetch", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn((_url: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;

    const reading = readOwnPeer(fetcher, LOCATION, 2000);
    let answered = false;
    void reading.then(() => {
      answered = true;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(await reading).toBeUndefined();
    expect(signal?.aborted).toBe(true);
  });

  it("the time limit covers a body that never arrives", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(
      async () => ({ ok: true, json: () => new Promise(() => {}) }) as unknown as Response,
    ) as unknown as typeof fetch;

    const reading = readOwnPeer(fetcher, LOCATION, 2000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await reading).toBeUndefined();
  });
});

describe("a browser join", () => {
  const BRIDGE_PORT = 7717;
  const JOIN_DEVICE_ID = "e".repeat(32);
  const TOKENS = {
    accessToken: "a".repeat(64),
    refreshToken: "b".repeat(64),
    accessExpiresAt: 900_000_000,
  };

  function joinDeps(h: MachinesHarness): SubmitJoinDeps {
    return {
      isHeld: (id) => h.store.has(id),
      atLimit: () => false,
      waiting: () => {},
      join: (address, password) =>
        joinMachine(
          { transport: h.transport, clock: h.clock, client: "jarvis/1", platform: "web" },
          address,
          password,
          "A browser",
        ),
      stillWanted: () => true,
      addAndSwitch: h.sessions.addAndSwitch,
      add: h.sessions.add,
    };
  }

  async function joined(h: MachinesHarness) {
    const running = submitJoin(joinDeps(h), `${NAME}:${BRIDGE_PORT}`, "owner password");
    await settle();
    const socket = h.transport.sockets[h.transport.sockets.length - 1] as FakeSocket;
    socket.emit({ kind: "open" });
    socket.emit({
      kind: "message",
      text: encodeMessage({
        t: "joined",
        v: PROTOCOL_VERSION,
        deviceId: JOIN_DEVICE_ID,
        token: "T".repeat(43),
        tokens: TOKENS,
      }),
    });
    const step = await running;
    await settle();
    return step;
  }

  /** The browser's device-owner gate with "Keep me signed in" off. */
  function browser(keepSignedIn: boolean) {
    const h = machinesHarness({ ids: [], singleSlot: true });
    h.device.passcode = keepSignedIn;
    return h;
  }

  it("writes the legacy keys and no per-machine key", async () => {
    const h = browser(false);
    await h.start();

    expect(await joined(h)).toMatchObject({ kind: "success", id: `${NAME}_${BRIDGE_PORT}` });

    expect([...h.secure.values.keys()].sort()).toEqual(
      ["jarvis.pairing", "jarvis.token", MACHINE_INDEX_KEY].sort(),
    );
    expect(JSON.parse(h.secure.values.get("jarvis.pairing") as string)).toMatchObject({
      name: NAME,
      port: BRIDGE_PORT,
    });
    expect(h.store.refreshKey(`${NAME}_${BRIDGE_PORT}`)).toBe("jarvis.refresh");
    expect(h.sessions.current().id).toBe(`${NAME}_${BRIDGE_PORT}`);
  });

  it("with Keep me signed in off, the refresh token stays in memory only", async () => {
    const h = browser(false);
    await h.start();

    await joined(h);

    expect([...h.refresh.values.keys()]).toEqual([]);
    expect(h.sessions.current().authSession.get().lockedLocally).toBe(false);
    expect(h.prefs.text ?? "").not.toContain(TOKENS.refreshToken);
  });

  it("with Keep me signed in on, the refresh token goes under the legacy key", async () => {
    const h = browser(true);
    await h.start();

    await joined(h);

    expect([...h.refresh.values]).toEqual([["jarvis.refresh", TOKENS.refreshToken]]);
  });

  it("a second machine is refused with PairingAlreadyExistsError, changing nothing", async () => {
    const h = machinesHarness({ ids: [A_ID], singleSlot: true });
    await h.start();
    const secure = [...h.secure.values];
    const refresh = [...h.refresh.values];

    await expect(
      h.sessions.addAndSwitch(recordOf(B_ID), { deviceId: "b".repeat(32), token: "B".repeat(43) }),
    ).rejects.toBeInstanceOf(PairingAlreadyExistsError);

    expect([...h.secure.values]).toEqual(secure);
    expect([...h.refresh.values]).toEqual(refresh);
    expect(h.sessions.current().id).toBe(A_ID);
  });

  it("an existing web pairing opens with no key changed", async () => {
    const h = machinesHarness({ ids: [A_ID], singleSlot: true });
    const secure = [...h.secure.values];
    const refresh = [...h.refresh.values];

    await h.store.open();

    expect([...h.secure.values]).toEqual(secure);
    expect([...h.refresh.values]).toEqual(refresh);
    expect(h.store.activeId()).toBe(A_ID);
    expect(h.store.refreshKey(A_ID)).toBe(refreshKeyOf(A_ID));
    expect(h.refresh.values.get("jarvis.refresh")).toBe(refreshTokenOf(A_ID));
  });

  it("an existing web pairing from before the index keeps its keys, and gains only the index", async () => {
    const h = machinesHarness({ ids: [A_ID], singleSlot: true });
    h.secure.values.delete(MACHINE_INDEX_KEY);
    const secure = [...h.secure.values];
    const refresh = [...h.refresh.values];

    await h.store.open();

    expect([...h.secure.values].filter(([key]) => key !== MACHINE_INDEX_KEY)).toEqual(secure);
    expect([...h.refresh.values]).toEqual(refresh);
    expect(h.store.activeId()).toBe(A_ID);
    expect([...h.secure.values.keys()].some((key) => key.startsWith("jarvis.m."))).toBe(false);
  });
});
