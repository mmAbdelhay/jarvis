import { describe, expect, it } from "vitest";
import { INVOKE_CHANNELS } from "./channels.js";
import { auditPolicyFor, CHANNEL_POLICY, isRemoteAllowed, REMOTE_EFFECT } from "./remote-policy.js";

describe("remote policy", () => {
  it("classifies every invoke channel, and nothing else", () => {
    expect(new Set(Object.keys(CHANNEL_POLICY))).toEqual(new Set(Object.values(INVOKE_CHANNELS)));
  });

  it("is fail-closed: an unknown channel is never remote", () => {
    expect(isRemoteAllowed("nope:nope")).toBe(false);
    expect(isRemoteAllowed("")).toBe(false);
    // Prototype names must not leak through an object lookup.
    expect(isRemoteAllowed("constructor")).toBe(false);
    expect(isRemoteAllowed("__proto__")).toBe(false);
  });

  // The spec's denied list ("Capability policy, fail-closed" + finding 3).
  it.each([
    "workspace:open",
    "workspace:close",
    "workspace:rename",
    "workspace:move",
    "workspace:activate",
    "workspace:navigate",
    "workspace:back",
    "workspace:forward",
    "workspace:reload",
    "workspace:bounds",
    "workspace:devtools",
    "workspace:devtoolsBounds",
    "workspace:devtoolsDock",
    "workspace:devtoolsDockMenu",
    "workspace:visible",
    "workspace:hideAll",
    "workspace:pip",
    "settings:restart",
    "setup:install",
    "dialog:pickFiles",
    "dialog:readJson",
    "voice:target",
    "voice:start",
    "voice:stop",
    "voice:preview",
    // M4 final review D1/D2: no phone Settings UI or API pane exists yet,
    // and these persistently rewrite laptop state or run phone-controlled
    // code/files on it.
    "settings:save",
    "settings:testAgent",
    "api:saveSettings",
    "remote:tailscaleCert",
  ])("denies %s remotely", (channel) => {
    expect(CHANNEL_POLICY[channel as keyof typeof CHANNEL_POLICY]).toBe("desktop-only");
    expect(isRemoteAllowed(channel)).toBe(false);
  });

  it("allows the guarded api send path remotely", () => {
    expect(CHANNEL_POLICY["api:send"]).toBe("remote");
    expect(isRemoteAllowed("api:send")).toBe(true);
  });

  it.each([
    "projects:list",
    "session:log",
    "git:changes",
    "terminal:attach",
    "settings:read",
    "editor:open",
    "workspace:snapshot",
    "terminal:panes",
    "terminal:snapshot",
    "session:snapshot",
    // M11 Task 4 (ruling 6): remote-legal now that dispatch.ts forces
    // `{ background: true }` for a remote origin — see the dedicated test
    // below for that forcing itself.
    "cluster:open",
    // A phone may create a new terminal tab the same way it already types
    // into an existing one (terminal:input) — dispatch.ts membership-checks
    // the project for a remote origin, see dispatch.test.ts.
    "terminal:open",
  ])("allows %s remotely", (channel) => {
    expect(isRemoteAllowed(channel)).toBe(true);
  });

  // M7: the live session list a phone can pull before the first
  // sessions:update push (ruling 10). Read-only, so it is remote.
  // [bite-proof: mark it "desktop-only" in CHANNEL_POLICY; this test fails]
  it("allows sessions:list remotely", () => {
    expect(CHANNEL_POLICY["sessions:list"]).toBe("remote");
    expect(isRemoteAllowed("sessions:list")).toBe(true);
  });

  // M8 ruling 10: read-only recovery for a phone that missed a turn:new
  // push while disconnected.
  it("allows turns:list remotely", () => {
    expect(CHANNEL_POLICY["turns:list"]).toBe("remote");
    expect(isRemoteAllowed("turns:list")).toBe(true);
  });

  // M9 Task 3: a phone's own path to "a JSON file the user picked", since
  // it has no filesystem for dialog:readJson (desktop-only, below) to read
  // from — dispatch.ts's own handler additionally refuses a desktop origin.
  it("allows remote:readJsonUpload remotely", () => {
    expect(CHANNEL_POLICY["remote:readJsonUpload"]).toBe("remote");
    expect(isRemoteAllowed("remote:readJsonUpload")).toBe(true);
  });

  // A phone has no business enumerating the laptop's network interfaces —
  // least of all before it is paired, which is when it would want to.
  it("keeps remote:bindChoices desktop-only", () => {
    expect(CHANNEL_POLICY["remote:bindChoices"]).toBe("desktop-only");
    expect(isRemoteAllowed("remote:bindChoices")).toBe(false);
  });

  // Pairing, status and revocation are the laptop's own consent gate on
  // who gets a device token — a phone must not open its own pairing
  // window, approve itself, see the pairing secret, or revoke.
  it.each([
    "remote:status",
    "remote:pair",
    "remote:cancelPair",
    "remote:decidePair",
    "remote:revoke",
  ])("keeps %s desktop-only", (channel) => {
    expect(CHANNEL_POLICY[channel as keyof typeof CHANNEL_POLICY]).toBe("desktop-only");
    expect(isRemoteAllowed(channel)).toBe(false);
  });

  // M10 Task 4: a phone registers and clears only its own push token.
  it.each(["remote:registerPush", "remote:unregisterPush"])("allows %s remotely", (channel) => {
    expect(CHANNEL_POLICY[channel as keyof typeof CHANNEL_POLICY]).toBe("remote");
    expect(isRemoteAllowed(channel)).toBe(true);
  });

  // [bite-proof: mark `terminal:commandFinished` `remote`; this fails]
  it("keeps terminal:commandFinished desktop-only", () => {
    expect(CHANNEL_POLICY["terminal:commandFinished"]).toBe("desktop-only");
    expect(isRemoteAllowed("terminal:commandFinished")).toBe(false);
  });
});

// M12 Task 3.
describe("REMOTE_EFFECT", () => {
  // [bite-proof: delete a cell from REMOTE_EFFECT; `tsc -b` fails on the
  // `satisfies Record<RemoteChannel, …>` clause — the missing key is not a
  // runtime failure this test alone can prove, only a compile one.]
  it("has a cell for every remote channel and no other key", () => {
    const remoteChannels = Object.entries(CHANNEL_POLICY)
      .filter(([, access]) => access === "remote")
      .map(([channel]) => channel);
    expect(new Set(Object.keys(REMOTE_EFFECT))).toEqual(new Set(remoteChannels));
  });

  it("classifies docker:unfollow as a mutation", () => {
    expect(REMOTE_EFFECT["docker:unfollow"]).toBe("mutate");
  });

  it("classifies terminal:open as a mutation, always audited", () => {
    expect(REMOTE_EFFECT["terminal:open"]).toBe("mutate");
    expect(auditPolicyFor("terminal:open", () => false)).toBe("always");
  });
});

describe("auditPolicyFor", () => {
  const noBlobs = () => false;
  const isVoiceUpload = (channel: string) => channel === "remote:uploadAudio";

  it("always for a mutate channel", () => {
    expect(auditPolicyFor("git:commit", noBlobs)).toBe("always");
  });

  it("first-per-key for an input channel", () => {
    expect(auditPolicyFor("session:input", noBlobs)).toBe("first-per-key");
  });

  it("never for a read channel", () => {
    expect(auditPolicyFor("projects:list", noBlobs)).toBe("never");
  });

  it("always for a blob channel, regardless of REMOTE_EFFECT", () => {
    expect(auditPolicyFor("remote:uploadAudio", isVoiceUpload)).toBe("always");
  });

  it("never for an unknown channel", () => {
    expect(auditPolicyFor("nope:nope", noBlobs)).toBe("never");
  });

  // Prototype names must not leak through an object lookup.
  it("never for __proto__", () => {
    expect(auditPolicyFor("__proto__", noBlobs)).toBe("never");
  });
});
