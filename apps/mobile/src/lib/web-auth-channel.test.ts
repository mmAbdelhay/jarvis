import { describe, expect, it } from "vitest";
import type { AuthBroadcast } from "./auth-session";
import {
  AUTH_CHANNEL_NAME,
  AUTH_SIGNAL_KEY,
  createWebAuthChannel,
  parseAuthBroadcast,
  type BroadcastChannelLike,
  type StorageEventLike,
} from "./web-auth-channel";

function broadcastDouble() {
  const names: string[] = [];
  const posted: unknown[] = [];
  const listeners = new Set<(event: { data: unknown }) => void>();
  const create = (name: string): BroadcastChannelLike => {
    names.push(name);
    return {
      postMessage: (message) => posted.push(message),
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    };
  };
  const deliver = (data: unknown) => {
    for (const listener of [...listeners]) listener({ data });
  };
  return { create, names, posted, deliver, listeners };
}

describe("parseAuthBroadcast", () => {
  it.each([
    [{ t: "storage-off" }, { t: "storage-off" }],
    [{ t: "logout" }, { t: "logout" }],
    [{ t: "logout", token: "x" }, { t: "logout" }],
    [{ t: "other" }, undefined],
    ["logout", undefined],
    [null, undefined],
  ])("parses %j as %j", (value, expected) => {
    expect(parseAuthBroadcast(value)).toEqual(expected);
  });
});

describe("createWebAuthChannel: BroadcastChannel", () => {
  it("posts only the kind on the jarvis-auth channel", () => {
    const bc = broadcastDouble();
    const channel = createWebAuthChannel({ createBroadcastChannel: bc.create });
    channel?.post({ t: "storage-off" });
    expect(bc.names).toEqual([AUTH_CHANNEL_NAME]);
    expect(bc.posted).toEqual([{ t: "storage-off" }]);
  });

  it("hands valid messages to the subscriber, drops the rest, and unsubscribes", () => {
    const bc = broadcastDouble();
    const channel = createWebAuthChannel({ createBroadcastChannel: bc.create });
    const got: AuthBroadcast[] = [];
    const unsubscribe = channel?.subscribe((message) => got.push(message));
    bc.deliver({ t: "logout" });
    bc.deliver({ t: "unknown" });
    bc.deliver("storage-off");
    unsubscribe?.();
    bc.deliver({ t: "storage-off" });
    expect(got).toEqual([{ t: "logout" }]);
    expect(bc.listeners.size).toBe(0);
  });
});

describe("createWebAuthChannel: storage-event fallback", () => {
  function storageDouble() {
    const values = new Map<string, string>();
    const listeners = new Set<(event: StorageEventLike) => void>();
    return {
      values,
      listeners,
      storage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          values.set(key, value);
        },
      },
      onStorage: (listener: (event: StorageEventLike) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      fire: (event: StorageEventLike) => {
        for (const listener of [...listeners]) listener(event);
      },
    };
  }

  it("writes a counter plus the kind, changing the value on every post", () => {
    const s = storageDouble();
    const channel = createWebAuthChannel({ storage: s.storage, onStorage: s.onStorage });
    channel?.post({ t: "logout" });
    expect(s.values.get(AUTH_SIGNAL_KEY)).toBe("1 logout");
    channel?.post({ t: "logout" });
    expect(s.values.get(AUTH_SIGNAL_KEY)).toBe("2 logout");
  });

  it("delivers the key's new kind, ignoring other keys, removals and junk", () => {
    const s = storageDouble();
    const channel = createWebAuthChannel({ storage: s.storage, onStorage: s.onStorage });
    const got: AuthBroadcast[] = [];
    const unsubscribe = channel?.subscribe((message) => got.push(message));
    s.fire({ key: AUTH_SIGNAL_KEY, newValue: "3 storage-off" });
    s.fire({ key: "other", newValue: "4 logout" });
    s.fire({ key: AUTH_SIGNAL_KEY, newValue: null });
    s.fire({ key: AUTH_SIGNAL_KEY, newValue: "5 steal" });
    unsubscribe?.();
    s.fire({ key: AUTH_SIGNAL_KEY, newValue: "6 logout" });
    expect(got).toEqual([{ t: "storage-off" }]);
  });

  it("a storage write that throws is swallowed", () => {
    const channel = createWebAuthChannel({
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota");
        },
      },
      onStorage: () => () => {},
    });
    expect(() => channel?.post({ t: "logout" })).not.toThrow();
  });

  it("with neither mechanism there is no channel", () => {
    expect(createWebAuthChannel({})).toBeUndefined();
  });
});
