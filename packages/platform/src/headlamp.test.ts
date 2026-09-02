import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  clusterUrlSegment,
  defaultHeadlampBinary,
  frontendDirFor,
  skippedContexts,
} from "./headlamp.js";

describe("clusterUrlSegment", () => {
  it("replaces slashes with double hyphens and leaves colons alone", () => {
    expect(clusterUrlSegment("arn:aws:eks:eu-west-1:123456789012:cluster/app_dev")).toBe(
      "arn:aws:eks:eu-west-1:123456789012:cluster--app_dev",
    );
  });

  it("leaves a context with no slash untouched", () => {
    expect(clusterUrlSegment("kind-kind")).toBe("kind-kind");
  });

  it("replaces every slash, not only the first", () => {
    expect(clusterUrlSegment("a/b/c")).toBe("a--b--c");
  });
});

describe("skippedContexts", () => {
  it("returns the contexts not kept", () => {
    expect(skippedContexts(["a", "b", "c", "d"], ["b", "d"])).toEqual(["a", "c"]);
  });

  it("returns nothing when every context is kept", () => {
    expect(skippedContexts(["a", "b"], ["a", "b"])).toEqual([]);
  });

  it("ignores a kept context the kubeconfig does not have", () => {
    expect(skippedContexts(["a"], ["a", "gone"])).toEqual([]);
  });

  // The flag silently ignores a name containing "/", so a raw EKS ARN here
  // would filter nothing and every project would list every cluster. The
  // comparison is still made on the raw names — that is the only form the
  // kubeconfig and `clusters:` share.
  it("rewrites a slash-bearing context to the form the flag matches", () => {
    expect(
      skippedContexts(
        ["arn:aws:eks:eu-west-1:1:cluster/Cast_AI", "arn:aws:eks:eu-west-1:2:cluster/app_dev"],
        ["arn:aws:eks:eu-west-1:2:cluster/app_dev"],
      ),
    ).toEqual(["arn:aws:eks:eu-west-1:1:cluster--Cast_AI"]);
  });

  it("keeps a context with no slash unchanged", () => {
    expect(skippedContexts(["kind-kind", "other"], ["other"])).toEqual(["kind-kind"]);
  });
});

describe("frontendDirFor", () => {
  it("is the sibling of the binary", () => {
    expect(frontendDirFor("/Applications/Headlamp.app/Contents/Resources/headlamp-server")).toBe(
      "/Applications/Headlamp.app/Contents/Resources/frontend",
    );
  });
});

describe("defaultHeadlampBinary", () => {
  it("is the app bundle on macOS", () => {
    expect(defaultHeadlampBinary("darwin", {})).toBe(
      "/Applications/Headlamp.app/Contents/Resources/headlamp-server",
    );
  });

  it("is /opt on Linux", () => {
    expect(defaultHeadlampBinary("linux", {})).toBe("/opt/Headlamp/resources/headlamp-server");
  });

  it("follows LOCALAPPDATA on Windows", () => {
    expect(defaultHeadlampBinary("win32", { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" })).toBe(
      join("C:\\Users\\a\\AppData\\Local", "Programs", "Headlamp", "resources", "headlamp-server.exe"),
    );
  });
});
