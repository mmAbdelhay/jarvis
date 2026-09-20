import type { AuthenticatedDevice, ReliablePolicy, StreamPolicy } from "@jarvis/remote";
import { describe, expect, it } from "vitest";
import { PUSH_CHANNELS } from "./channels.js";
import { createDockerFollowers } from "./docker-followers.js";
import {
  REMOTE_PUSH_POLICY,
  remoteKeyAuthorizer,
  remotePushPolicies,
  type StreamOwners,
} from "./remote-push-policy.js";

const DESKTOP_ONLY = new Set([
  "setup:output",
  "voice:hotkeys",
  "workspace:devtoolsDockChosen",
  "workspace:devtoolsClosed",
  "remote:update",
]);

describe("REMOTE_PUSH_POLICY", () => {
  // [bite-proof: fail-closed push classification] Deleting one of
  // REMOTE_PUSH_POLICY's entries fails tsc first (the mapped type over
  // `keyof PushChannels` is total) — this test is the runtime half: every
  // channel main.ts can actually push has an entry here, one way or the
  // other.
  it("classifies every channel main.ts can push", () => {
    for (const channel of Object.values(PUSH_CHANNELS)) {
      expect(Object.hasOwn(REMOTE_PUSH_POLICY, channel)).toBe(true);
    }
  });

  it("remotePushPolicies() excludes every desktop-only channel", () => {
    const policies = remotePushPolicies();
    for (const channel of DESKTOP_ONLY) {
      expect(policies.has(channel)).toBe(false);
    }
  });

  it("remotePushPolicies() includes every non-desktop-only channel, unchanged", () => {
    const policies = remotePushPolicies();
    for (const [channel, policy] of Object.entries(REMOTE_PUSH_POLICY)) {
      if (DESKTOP_ONLY.has(channel)) continue;
      expect(policies.get(channel)).toBe(policy);
    }
    expect(policies.size).toBe(Object.keys(REMOTE_PUSH_POLICY).length - DESKTOP_ONLY.size);
  });

  it("classifies the four latest and six reliable channels, terminal:exit keyed", () => {
    expect(REMOTE_PUSH_POLICY["metrics:update"]).toEqual({ kind: "latest" });
    expect(REMOTE_PUSH_POLICY["sessions:update"]).toEqual({ kind: "latest" });
    expect(REMOTE_PUSH_POLICY["providers:update"]).toEqual({ kind: "latest" });
    expect(REMOTE_PUSH_POLICY["git:counts"]).toEqual({ kind: "latest" });

    expect(REMOTE_PUSH_POLICY["turn:new"]).toEqual({ kind: "reliable" });
    expect(REMOTE_PUSH_POLICY["voice:listening"]).toEqual({ kind: "reliable" });
    expect(REMOTE_PUSH_POLICY["voice:speaking"]).toEqual({ kind: "reliable" });
    expect(REMOTE_PUSH_POLICY["voice:notice"]).toEqual({ kind: "reliable" });
    expect(REMOTE_PUSH_POLICY["workspace:update"]).toEqual({ kind: "reliable" });

    const exitPolicy = REMOTE_PUSH_POLICY["terminal:exit"] as ReliablePolicy;
    expect(exitPolicy.kind).toBe("reliable");
    expect(exitPolicy.keyOf?.({ paneKey: "tab-1" })).toBe("tab-1");
  });

  describe("terminal:data codec", () => {
    const policy = REMOTE_PUSH_POLICY["terminal:data"] as StreamPolicy;

    it("keyOf reads a string paneKey only", () => {
      expect(policy.keyOf({ paneKey: "tab-1", chunk: "x", offset: 0 })).toBe("tab-1");
      expect(policy.keyOf(null)).toBeUndefined();
      expect(policy.keyOf({ paneKey: 7 })).toBeUndefined();
    });

    it("chunkOf returns the chunk, or '' for a malformed payload", () => {
      expect(policy.chunkOf({ paneKey: "tab-1", chunk: "x", offset: 0 })).toBe("x");
      expect(policy.chunkOf(null)).toBe("");
      expect(policy.chunkOf({ paneKey: "tab-1" })).toBe("");
    });

    it("offsetOf reads a numeric offset only", () => {
      expect(policy.offsetOf({ paneKey: "tab-1", chunk: "x", offset: 5 })).toBe(5);
      expect(policy.offsetOf({ paneKey: "tab-1" })).toBeUndefined();
    });

    it("withChunk builds exactly {paneKey, chunk, offset}, never a spread", () => {
      expect(
        policy.withChunk({ paneKey: "tab-1", chunk: "x", offset: 0, extra: 1 }, "yz", 5),
      ).toEqual({ paneKey: "tab-1", chunk: "yz", offset: 5 });
    });
  });

  describe("session:output codec", () => {
    const policy = REMOTE_PUSH_POLICY["session:output"] as StreamPolicy;

    it("keys by sessionId and rebuilds exactly {sessionId, chunk, offset}", () => {
      expect(policy.keyOf({ sessionId: "s1", chunk: "x", offset: 0 })).toBe("s1");
      expect(policy.keyOf({ sessionId: 7 })).toBeUndefined();
      expect(
        policy.withChunk({ sessionId: "s1", chunk: "x", offset: 0, extra: 1 }, "yz", 5),
      ).toEqual({ sessionId: "s1", chunk: "yz", offset: 5 });
    });
  });

  describe("docker:log codec", () => {
    const policy = REMOTE_PUSH_POLICY["docker:log"] as StreamPolicy;

    it("keys by tabId, has no offset, and withChunk has no offset key", () => {
      expect(policy.keyOf({ tabId: "remote-1", chunk: "x" })).toBe("remote-1");
      expect(policy.offsetOf({ tabId: "remote-1", chunk: "x" })).toBeUndefined();
      const withChunk = policy.withChunk({ tabId: "remote-1", chunk: "x" }, "yz", undefined);
      expect(withChunk).toEqual({ tabId: "remote-1", chunk: "yz" });
      expect(Object.hasOwn(withChunk as object, "offset")).toBe(false);
    });
  });
});

const DEVICE: AuthenticatedDevice = { id: "d1", name: "Phone" };
const OTHER_DEVICE: AuthenticatedDevice = { id: "d2", name: "Other phone" };

function owners(overrides: Partial<StreamOwners> = {}): StreamOwners {
  return {
    hasPane: () => false,
    hasSession: () => false,
    followerOwner: () => undefined,
    ...overrides,
  };
}

// M7 (Task 1, ruling 9): the largest server frame is a snapshot res or a
// capped push — a margin check, not an exact-size one, against the phone's
// iOS `maximumMessageSize` (apps/mobile's PINNED_SOCKET_MAX_MESSAGE_BYTES,
// Task 3), raised to 16 MiB for exactly this reason.
const PINNED_SOCKET_MAX_MESSAGE_BYTES = 16_777_216;

describe("frame size stays under the phone's 16 MiB cap", () => {
  // 262 144 chars of ESC: JSON-escapes to "" (6 bytes) each, so the
  // encoded chunk alone is about 1.5 MiB — the worst case an ESC-heavy TUI
  // repaint produces (ruling 9's "about 1.6 MiB").
  const chunk = "".repeat(262_144);

  it('a "session:output" psh frame, built through the real StreamPolicy, is under the cap', () => {
    const policy = REMOTE_PUSH_POLICY["session:output"] as StreamPolicy;
    const payload = policy.withChunk({ sessionId: "s1" }, chunk, 0);
    const frame = { t: "psh", ch: "session:output", p: payload, seq: 1, dropped: 1 };
    expect(Buffer.byteLength(JSON.stringify(frame), "utf8")).toBeLessThan(
      PINNED_SOCKET_MAX_MESSAGE_BYTES,
    );
  });

  it("a session:snapshot res payload is under the cap", () => {
    const res = { text: chunk, end: 262_144 };
    expect(Buffer.byteLength(JSON.stringify(res), "utf8")).toBeLessThan(
      PINNED_SOCKET_MAX_MESSAGE_BYTES,
    );
  });
});

describe("remoteKeyAuthorizer", () => {
  it("terminal:data and terminal:exit require the pane to exist", () => {
    const authorize = remoteKeyAuthorizer(owners({ hasPane: (k) => k === "tab-1" }));
    expect(authorize("terminal:data", "tab-1", DEVICE)).toBe(true);
    expect(authorize("terminal:data", "tab-2", DEVICE)).toBe(false);
    expect(authorize("terminal:exit", "tab-1", DEVICE)).toBe(true);
    expect(authorize("terminal:exit", "tab-2", DEVICE)).toBe(false);
  });

  it("session:output requires the session to exist", () => {
    const authorize = remoteKeyAuthorizer(owners({ hasSession: (id) => id === "s1" }));
    expect(authorize("session:output", "s1", DEVICE)).toBe(true);
    expect(authorize("session:output", "s2", DEVICE)).toBe(false);
  });

  // [bite-proof: return true for docker:log without the owner check]
  // Hard-coding docker:log's branch to `return true` (dropping the
  // `=== device.id` comparison) fails the "other device"/"desktop" cases
  // below without touching the "owner equal" one.
  it("docker:log requires the requesting device to be the follower's own owner", () => {
    const authorize = remoteKeyAuthorizer(
      owners({ followerOwner: (tabId) => (tabId === "remote-1" ? "d1" : undefined) }),
    );
    expect(authorize("docker:log", "remote-1", DEVICE)).toBe(true);
    expect(authorize("docker:log", "remote-1", OTHER_DEVICE)).toBe(false);
    expect(authorize("docker:log", "remote-2", DEVICE)).toBe(false);
  });

  it("a desktop-owned follower never authorises any remote device", () => {
    const authorize = remoteKeyAuthorizer(owners({ followerOwner: () => "desktop" }));
    expect(authorize("docker:log", "remote-1", DEVICE)).toBe(false);
  });

  it("refuses any other channel, including the unkeyed latest/reliable ones", () => {
    const authorize = remoteKeyAuthorizer(
      owners({ hasPane: () => true, hasSession: () => true, followerOwner: () => "d1" }),
    );
    expect(authorize("metrics:update", "anything", DEVICE)).toBe(false);
    expect(authorize("workspace:update", "anything", DEVICE)).toBe(false);
    expect(authorize("nope:nope", "anything", DEVICE)).toBe(false);
  });

  // Fix round 1 (Important 1) covering test: the end-to-end ownership
  // transition at the authoriser level, over a *real* DockerFollowers —
  // d1 unfollows a tab id, d2 follows the same (now free) tab id, and the
  // authoriser must track that transition exactly, not just at the moment
  // a subscription was first accepted (connection.test.ts covers the
  // delivery-time re-check that makes this matter).
  it("tracks a real DockerFollowers across an unfollow/re-follow by a different device", () => {
    const followers = createDockerFollowers({
      follow: () => ({ close: () => undefined }),
      send: () => undefined,
    });
    const authorize = remoteKeyAuthorizer(
      owners({ followerOwner: (tabId) => followers.ownerOf(tabId) }),
    );

    followers.follow("remote-1", "web", DEVICE.id);
    expect(authorize("docker:log", "remote-1", DEVICE)).toBe(true);

    followers.unfollow("remote-1", DEVICE.id);
    followers.follow("remote-1", "web", OTHER_DEVICE.id);

    expect(authorize("docker:log", "remote-1", DEVICE)).toBe(false);
    expect(authorize("docker:log", "remote-1", OTHER_DEVICE)).toBe(true);
  });
});
