import { describe, expect, it } from "vitest";
import { appStateFollowAction } from "./docker-screen";

describe("appStateFollowAction (fix round 1, Minor 4)", () => {
  it("background always closes, regardless of what was being followed or its phase", () => {
    expect(appStateFollowAction("background", "web", "following")).toEqual({ kind: "close" });
    expect(appStateFollowAction("background", undefined, "idle")).toEqual({ kind: "close" });
  });

  it("active re-attaches the remembered container when the follower is idle", () => {
    expect(appStateFollowAction("active", "web", "idle")).toEqual({
      kind: "reattach",
      container: "web",
    });
  });

  it("active with nothing remembered is a no-op", () => {
    expect(appStateFollowAction("active", undefined, "idle")).toEqual({ kind: "none" });
  });

  it(
    'iOS\'s transient "inactive" never closes the follower ' +
      '[bite-proof: fix round 1, Minor 4 — treat "inactive" the same as "background" and this fails]',
    () => {
      expect(appStateFollowAction("inactive", "web", "following")).toEqual({ kind: "none" });
    },
  );

  it("unknown/extension are also left alone", () => {
    expect(appStateFollowAction("unknown", "web", "following")).toEqual({ kind: "none" });
    expect(appStateFollowAction("extension", "web", "following")).toEqual({ kind: "none" });
  });

  describe("M12 Task 8 rule 8: active × phase — reattach only when idle", () => {
    it(
      "a live follower (following/waiting/failed) is never re-attached on " +
        "active — only a genuinely idle one " +
        "[bite-proof: ignore phase; a live follower is re-attached]",
      () => {
        expect(appStateFollowAction("active", "web", "following")).toEqual({ kind: "none" });
        expect(appStateFollowAction("active", "web", "waiting")).toEqual({ kind: "none" });
        expect(appStateFollowAction("active", "web", "failed")).toEqual({ kind: "none" });
      },
    );

    it("an idle follower with a remembered container still re-attaches", () => {
      expect(appStateFollowAction("active", "web", "idle")).toEqual({
        kind: "reattach",
        container: "web",
      });
    });
  });
});
