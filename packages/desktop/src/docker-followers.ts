// One `docker logs -f` per open Docker tab, never per container: the tab
// shows one log at a time, and a follower per row would be a process per
// container for output nobody is looking at. Lifted out of main.ts so the
// dispatch table (docker:follow / docker:unfollow / workspace:close) and
// releaseChildren (quit) share one map.
//
// M5: a tab is now owned — by the desktop window itself, or by the device
// id of the phone that opened it (dispatch.ts computes which). Ownership is
// what keeps a phone's docker:log subscription (remoteKeyAuthorizer,
// remote-push-policy.ts) scoped to followers *that device* opened, and it
// is what stops one device from silently replacing another's follower for
// the same tab id — see `follow`'s owner check below, and its bite-proof in
// docker-followers.test.ts.

/** The desktop window's own owner id. Never a real device id — device ids
 *  come from remote-access.ts's device store, which never mints "desktop"
 *  — so `followerOwner(tabId) === device.id` (remoteKeyAuthorizer) can
 *  never be tricked into matching the desktop's own follower. */
export const DESKTOP_OWNER = "desktop";

/** A device's own Docker followers are capped so a phone cannot make the
 *  desktop spawn `docker logs -f` processes without bound (Global
 *  Constraints' Bounds list). The desktop window itself is not capped —
 *  only remote (non-desktop) owners are. */
export const MAX_REMOTE_FOLLOWERS_PER_DEVICE = 4;

/** A phone's own tab ids for a Docker follower, exactly as Global
 *  Constraints' Bounds list spells the grammar. Checked only for a remote
 *  origin (dispatch.ts) — the desktop's own tab ids follow a different,
 *  already-trusted scheme. */
export const REMOTE_FOLLOW_TAB_PATTERN = /^remote-[A-Za-z0-9_-]{1,32}$/;

export type FollowResult = "following" | "owned-elsewhere" | "limit";

export type DockerFollowers = {
  follow(tabId: string, container: string, owner: string): FollowResult;
  unfollow(tabId: string, owner: string): boolean;
  ownerOf(tabId: string): string | undefined;
  unfollowOwnedBy(owner: string): number;
  closeAll(): void;
};

export function createDockerFollowers(deps: {
  follow(container: string, onChunk: (chunk: string) => void): { close(): void };
  send(tabId: string, chunk: string): void;
}): DockerFollowers {
  const followers = new Map<string, { close(): void; owner: string }>();

  const closeTab = (tabId: string): void => {
    followers.get(tabId)?.close();
    followers.delete(tabId);
  };

  const remoteFollowerCount = (owner: string, excludingTabId: string): number => {
    let count = 0;
    for (const [tabId, follower] of followers) {
      if (follower.owner === owner && tabId !== excludingTabId) count++;
    }
    return count;
  };

  return {
    follow(tabId, container, owner) {
      const existing = followers.get(tabId);
      // A tab already owned by someone else is never silently taken over —
      // neither the phone's own container swap nor another device's first
      // follow may close a follower it does not own.
      if (existing !== undefined && existing.owner !== owner) return "owned-elsewhere";
      if (
        owner !== DESKTOP_OWNER &&
        remoteFollowerCount(owner, tabId) >= MAX_REMOTE_FOLLOWERS_PER_DEVICE
      ) {
        return "limit";
      }
      closeTab(tabId);
      followers.set(tabId, {
        ...deps.follow(container, (chunk) => deps.send(tabId, chunk)),
        owner,
      });
      return "following";
    },
    unfollow(tabId, owner) {
      const existing = followers.get(tabId);
      if (existing === undefined || existing.owner !== owner) return false;
      closeTab(tabId);
      return true;
    },
    ownerOf(tabId) {
      return followers.get(tabId)?.owner;
    },
    unfollowOwnedBy(owner) {
      let count = 0;
      for (const tabId of [...followers.keys()]) {
        if (followers.get(tabId)?.owner === owner) {
          closeTab(tabId);
          count++;
        }
      }
      return count;
    },
    closeAll() {
      for (const follower of followers.values()) follower.close();
      followers.clear();
    },
  };
}
