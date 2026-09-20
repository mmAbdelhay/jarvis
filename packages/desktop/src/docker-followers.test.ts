import { describe, expect, it, vi } from "vitest";
import {
  createDockerFollowers,
  DESKTOP_OWNER,
  MAX_REMOTE_FOLLOWERS_PER_DEVICE,
} from "./docker-followers.js";

describe("docker followers", () => {
  it("keeps one follower per tab, closing the previous one when the same owner re-follows", () => {
    const closes: string[] = [];
    const follow = vi.fn((container: string) => ({ close: () => closes.push(container) }));
    const followers = createDockerFollowers({ follow, send: vi.fn() });
    expect(followers.follow("t1", "web", DESKTOP_OWNER)).toBe("following");
    expect(followers.follow("t1", "db", DESKTOP_OWNER)).toBe("following");
    expect(closes).toEqual(["web"]);
    expect(followers.unfollow("t1", DESKTOP_OWNER)).toBe(true);
    expect(closes).toEqual(["web", "db"]);
    expect(followers.unfollow("t1", DESKTOP_OWNER)).toBe(false); // no-op, nothing left
    expect(closes).toHaveLength(2);
  });

  it("forwards chunks tagged with the tab, and closeAll drops everything", () => {
    const send = vi.fn();
    let onChunk: (chunk: string) => void = () => undefined;
    const followers = createDockerFollowers({
      follow: (_c, cb) => {
        onChunk = cb;
        return { close: vi.fn() };
      },
      send,
    });
    followers.follow("t1", "web", DESKTOP_OWNER);
    onChunk("line");
    expect(send).toHaveBeenCalledWith("t1", "line");
    followers.closeAll();
    followers.closeAll();
  });

  // [bite-proof: drop the owner check in follow() — the laptop's follower
  // is replaced by a device that does not own it]
  it("a different owner cannot replace another owner's follower for the same tab", () => {
    const closes: string[] = [];
    const follow = vi.fn((container: string) => ({ close: () => closes.push(container) }));
    const followers = createDockerFollowers({ follow, send: vi.fn() });
    expect(followers.follow("tab-1", "web", DESKTOP_OWNER)).toBe("following");
    expect(followers.follow("tab-1", "db", "d1")).toBe("owned-elsewhere");
    expect(closes).toEqual([]); // the desktop's follower was never closed
    expect(followers.ownerOf("tab-1")).toBe(DESKTOP_OWNER);
    expect(follow).toHaveBeenCalledTimes(1); // no second process spawned
  });

  it("caps remote followers per device, independent of another device's cap", () => {
    const follow = vi.fn(() => ({ close: vi.fn() }));
    const followers = createDockerFollowers({ follow, send: vi.fn() });
    for (const letter of ["a", "b", "c", "d"]) {
      expect(followers.follow(`remote-${letter}`, "web", "d1")).toBe("following");
    }
    expect(followers.follow("remote-e", "web", "d1")).toBe("limit");
    expect(follow).toHaveBeenCalledTimes(MAX_REMOTE_FOLLOWERS_PER_DEVICE); // nothing spawned for the 5th
    expect(followers.ownerOf("remote-e")).toBeUndefined();

    // Re-following one's own tab replaces it and does not eat into the cap.
    expect(followers.follow("remote-a", "db", "d1")).toBe("following");
    expect(follow).toHaveBeenCalledTimes(MAX_REMOTE_FOLLOWERS_PER_DEVICE + 1);

    // A second device has its own, independent cap.
    for (const letter of ["w", "x", "y", "z"]) {
      expect(followers.follow(`remote-${letter}`, "web", "d2")).toBe("following");
    }
  });

  it("unfollow closes and forgets only for the matching owner; unfollowOwnedBy reaps every follower of a device", () => {
    const followers = createDockerFollowers({ follow: () => ({ close: vi.fn() }), send: vi.fn() });
    for (const letter of ["a", "b", "c", "d"]) {
      followers.follow(`remote-${letter}`, "web", "d1");
    }
    expect(followers.unfollow("remote-a", "d2")).toBe(false);
    expect(followers.ownerOf("remote-a")).toBe("d1");

    expect(followers.unfollowOwnedBy("d1")).toBe(4);
    for (const letter of ["a", "b", "c", "d"]) {
      expect(followers.ownerOf(`remote-${letter}`)).toBeUndefined();
    }
  });
});
