// Which invoke channels a paired phone may call.
//
// No default. A channel nobody has marked `remote` is refused, so a new
// RendererApi method is unreachable from a phone until someone writes down
// here that it is safe — and `satisfies Record<InvokeChannel, …>` makes
// forgetting to write it down a compile error.
//
// The rule (spec, finding 3): parity of content, not of the tab model.
// Anything that creates, destroys or rearranges a tab, pane or view on the
// LAPTOP's screen is desktop-only; the phone reads `workspace:update` and
// opens its own surfaces. Anything that speaks, records or shows a native
// dialog on the laptop is desktop-only. Everything that reads or mutates
// project state — sessions, git, files, Docker, API collections, bookmarks,
// settings — is remote, because a paired device is the user.
import type { InvokeChannel } from "./channels.js";

export type ChannelAccess = "remote" | "desktop-only";

export const CHANNEL_POLICY = {
  "setup:check": "remote",
  "setup:install": "desktop-only",
  "input:send": "remote",
  // Read-only recovery for a reply the phone missed while disconnected
  // (M8 ruling 10) — the same conversation turn:new already shares live.
  "turns:list": "remote",
  "voice:start": "desktop-only",
  "voice:stop": "desktop-only",
  "voice:target": "desktop-only",
  "voice:list": "remote",
  "voice:preview": "desktop-only",
  "history:list": "remote",
  // Remote (M7): the same read-only Session[] as the sessions:update push,
  // pullable so a phone can render the session table before the first push.
  "sessions:list": "remote",
  // Remote: a paired phone may ask the laptop to look again — the same
  // read a pull-to-refresh triggers, never a write. See SECURITY.md for
  // what this exposes (agent names, cwd and pids of the user's own agents,
  // never their arguments).
  "sessions:refresh": "remote",
  "git:changes": "remote",
  "git:diff": "remote",
  "git:setStaged": "remote",
  "git:commit": "remote",
  "session:log": "remote",
  "session:transcript": "remote",
  "session:resume": "desktop-only",
  "session:input": "remote",
  "session:resize": "remote",
  // Ruling 10's client attach rule (M7): subscribe to session:output first,
  // then call this, then drop any push already covered by the returned
  // `end` (`o + c.length <= end`) rather than rendering it a second time.
  "session:snapshot": "remote",
  "providers:refresh": "remote",
  "workspace:open": "desktop-only",
  "workspace:close": "desktop-only",
  "workspace:rename": "desktop-only",
  "workspace:move": "desktop-only",
  "workspace:activate": "desktop-only",
  "workspace:navigate": "desktop-only",
  "workspace:back": "desktop-only",
  "workspace:forward": "desktop-only",
  "workspace:reload": "desktop-only",
  "workspace:bounds": "desktop-only",
  "workspace:devtools": "desktop-only",
  "workspace:devtoolsBounds": "desktop-only",
  "workspace:devtoolsDock": "desktop-only",
  "workspace:devtoolsDockMenu": "desktop-only",
  "workspace:visible": "desktop-only",
  "workspace:hideAll": "desktop-only",
  "workspace:pip": "desktop-only",
  "workspace:snapshot": "remote",
  "editor:open": "remote",
  "editor:roots": "remote",
  "database:open": "remote",
  // M11 Task 4 (ruling 6): remote-legal now that dispatch.ts forces
  // `{ background: true }` for a remote origin regardless of what the
  // phone sent — a remote call can never open a login terminal tab or
  // trigger an MFA push on the laptop, only warm an already-connected
  // cluster or give up with the sidecar's own localised text.
  "cluster:open": "remote",
  "cluster:names": "remote",
  "chat:open": "remote",
  "chat:names": "remote",
  // Remote: a phone may create a new terminal tab in a configured project
  // the same way it already types into an existing one (terminal:input,
  // already remote above) — dispatch.ts requires the project to be one of
  // `deps.projects` for a remote origin and refuses anything else as
  // unknownProject, the same membership gate docker:open/api:open apply.
  "terminal:open": "remote",
  "terminal:suggest": "remote",
  "terminal:history": "remote",
  "terminal:listDir": "remote",
  "terminal:openFile": "desktop-only",
  "terminal:settings": "remote",
  "terminal:workflows": "remote",
  "terminal:ai": "remote",
  "terminal:chips": "remote",
  "terminal:attach": "remote",
  "terminal:panes": "remote",
  // Ruling 10's client attach rule (M7): subscribe to terminal:data first,
  // then call this, then drop any push already covered by the returned
  // `end` (`o + c.length <= end`) rather than rendering it a second time.
  "terminal:snapshot": "remote",
  "terminal:input": "remote",
  "terminal:resize": "remote",
  "terminal:split": "desktop-only",
  "terminal:closePane": "desktop-only",
  // Desktop-only (M10 Task 4): the laptop's own local decision to push,
  // reported by the pane that watched the block finish — a phone has no
  // pane of its own to report from, and dispatch.ts refuses a remote
  // origin outright as belt and braces even though this policy already
  // does.
  "terminal:commandFinished": "desktop-only",
  "docker:open": "desktop-only",
  "docker:names": "remote",
  "docker:view": "remote",
  "docker:containers": "remote",
  "docker:start": "remote",
  "docker:stop": "remote",
  "docker:restart": "remote",
  "docker:composeUp": "remote",
  "docker:composeDown": "remote",
  "docker:shell": "desktop-only",
  "docker:follow": "remote",
  "docker:unfollow": "remote",
  "api:open": "desktop-only",
  "api:collections": "remote",
  "api:tree": "remote",
  "api:request": "remote",
  "api:save": "remote",
  // M9 Task 4: dispatch supplies the authenticated origin only to the
  // guarded path, which rebuilds the request before history or execution.
  "api:send": "remote",
  "api:curl": "remote",
  "api:history": "remote",
  "api:clearHistory": "remote",
  "api:cookies": "remote",
  "api:clearCookies": "remote",
  "api:removeCookie": "remote",
  "api:settings": "remote",
  // Desktop-only (M4 final review, I3): saveSettings can pin a persistent
  // upstream proxy or turn off TLS verification for every future request,
  // from a phone that will not be sitting there to notice. Revisit in the
  // M9 phone API pane.
  "api:saveSettings": "desktop-only",
  "api:createRequest": "remote",
  "api:createFolder": "remote",
  "api:rename": "remote",
  "api:delete": "remote",
  "api:createCollection": "remote",
  "api:saveEnvironment": "remote",
  "api:importPostman": "remote",
  "dialog:pickFiles": "desktop-only",
  "dialog:readJson": "desktop-only",
  // Remote (M9 Task 3): the phone's own path to "a JSON file the user
  // picked" — it decodes a file this same device already staged with
  // remote:uploadFile, since it has no filesystem for dialog:readJson to
  // read from. dispatch.ts additionally refuses this for a desktop origin
  // (it has dialog:readJson instead) — policy alone would allow either, the
  // handler is what actually narrows it to remote-only.
  "remote:readJsonUpload": "remote",
  "bookmarks:list": "remote",
  "bookmarks:add": "remote",
  "bookmarks:remove": "remote",
  "bookmarks:setPinned": "remote",
  "bookmarks:rename": "remote",
  "bookmarks:reorder": "remote",
  "settings:read": "remote",
  // Desktop-only (M4 final review, I2): settings:save persistently rewrites
  // spawned agent commands and project roots, and racing it against a
  // concurrent config write can silently undo the user turning the bridge
  // off. Revisit when a phone Settings UI ships.
  "settings:save": "desktop-only",
  // Desktop-only (M4 final review, I2): runs a phone-supplied executable on
  // the laptop by name. Revisit when a phone Settings UI ships.
  "settings:testAgent": "desktop-only",
  "settings:restart": "desktop-only",
  "projects:list": "remote",
  // Desktop-only: the laptop's interface list is reconnaissance to anyone
  // who is not already sitting at it, and a phone only ever needs the one
  // address the pairing QR hands it.
  "remote:bindChoices": "desktop-only",
  // Desktop-only, all five: a phone must not open its own pairing window,
  // approve its own request, see the pairing secret (the QR/link carries
  // it), read the raw status feed outside its own connection, or revoke
  // (including itself). Pairing and revocation are the laptop's own consent
  // gate on who gets a device token at all — granting them over the bridge
  // that same token controls would let a paired phone widen its own access.
  "remote:status": "desktop-only",
  "remote:pair": "desktop-only",
  "remote:cancelPair": "desktop-only",
  "remote:decidePair": "desktop-only",
  "remote:revoke": "desktop-only",
  // Remote (M10 Task 4): a phone registers and clears only its own Expo
  // push token — dispatch.ts's handlers act on `origin.deviceId` alone,
  // never a device id carried in the arguments, so this being remote-legal
  // never lets one paired phone touch another's registration.
  "remote:registerPush": "remote",
  "remote:unregisterPush": "remote",
  // Desktop-only: runs `tailscale cert` on the laptop and writes
  // jarvis.yaml (remote.tls.certPath/keyPath, remote.sidecarProxy) —
  // exactly the class of persistent, laptop-controlled-tool config change
  // settings:save and settings:testAgent are already desktop-only for.
  "remote:tailscaleCert": "desktop-only",
} as const satisfies Record<InvokeChannel, ChannelAccess>;

type PolicyEntries = typeof CHANNEL_POLICY;

/** Channels a paired phone may call. */
export type RemoteChannel = {
  [C in keyof PolicyEntries]: PolicyEntries[C] extends "remote" ? C : never;
}[keyof PolicyEntries];

/** Channels only this window's renderer may call. */
export type DesktopOnlyChannel = Exclude<keyof PolicyEntries, RemoteChannel>;

/**
 * Fail-closed lookup. `Object.hasOwn` rather than indexing, so a channel
 * named "constructor" or "__proto__" cannot read a value off the prototype.
 */
export function isRemoteAllowed(channel: string): channel is RemoteChannel {
  return (
    Object.hasOwn(CHANNEL_POLICY, channel) && CHANNEL_POLICY[channel as InvokeChannel] === "remote"
  );
}

// M12 Task 3: what a remote-legal channel's own effect is, for the audit
// log alone — a second, parallel table over the same `RemoteChannel` keys,
// never a change to `CHANNEL_POLICY`'s access values. `remote` (connection.ts)
// contains no channel names at all; this table, and `auditPolicyFor` below,
// are the only place that classifies one.
//
// `mutate`: every channel that writes laptop state — git, provider refresh,
// every API-collection write, Docker's start/stop/restart/compose,
// bookmarks, the phone's own push registration, its upload handoff, and the
// five sidecar/editor "opens" the controller ruled `mutate` (an open spawns
// or warms a real process/login on the laptop, the same weight as a write).
// Fix round 1 (review I2, controller-adopted): `terminal:ai` is also
// `mutate` — an on-demand brain call that spends the laptop's own provider
// credentials on every request, and whose `args[0]` is a two-value enum
// ("generate"/"explain") that would otherwise hide every call after the
// first under `first-per-key`. `docker:follow` is also `mutate` — it
// spawns a real `docker logs -f` child process on the laptop, the same
// weight as `docker:start`. `terminal:open` is also `mutate` — it creates a
// new tab and spawns a real shell process on the laptop, not a keystroke
// into one already running; unlike an `input` channel its own `key` field
// is never logged (connection.ts's `key` is first-per-key-only), so its
// audit line carries no project name, only the channel and outcome.
//
// `input`: a live keystroke-style stream into an already-open session or
// terminal pane — `args[0]` is always that pane/session's own id (safe to
// log up to AUDIT_KEY_MAX_CHARS chars), the rest of `args` is the actual
// keystrokes and is never logged. Auditing every one would flood the log
// for no security value, so only the first call per (channel, id) per
// connection gets a line (`auditPolicyFor`'s "first-per-key"). The six:
// `session:input`, `session:resize`, `terminal:input`, `terminal:resize`,
// `terminal:suggest`, `terminal:chips`.
//
// Everything else is `read`: it returns laptop state without changing it,
// so no remote-call line is worth the log space.
export const REMOTE_EFFECT = {
  "setup:check": "read",
  "input:send": "mutate",
  "turns:list": "read",
  "voice:list": "read",
  "history:list": "read",
  "sessions:list": "read",
  "sessions:refresh": "read",
  "git:changes": "read",
  "git:diff": "read",
  "git:setStaged": "mutate",
  "git:commit": "mutate",
  "session:log": "read",
  "session:transcript": "read",
  "session:input": "input",
  "session:resize": "input",
  "session:snapshot": "read",
  "providers:refresh": "mutate",
  "workspace:snapshot": "read",
  "editor:open": "mutate",
  "editor:roots": "read",
  "database:open": "mutate",
  "cluster:open": "mutate",
  "cluster:names": "read",
  "chat:open": "mutate",
  "chat:names": "read",
  "terminal:open": "mutate",
  "terminal:suggest": "input",
  "terminal:history": "read",
  "terminal:listDir": "read",
  "terminal:settings": "read",
  "terminal:workflows": "read",
  "terminal:ai": "mutate",
  "terminal:chips": "input",
  "terminal:attach": "mutate",
  "terminal:panes": "read",
  "terminal:snapshot": "read",
  "terminal:input": "input",
  "terminal:resize": "input",
  "docker:names": "read",
  "docker:view": "read",
  "docker:containers": "read",
  "docker:start": "mutate",
  "docker:stop": "mutate",
  "docker:restart": "mutate",
  "docker:composeUp": "mutate",
  "docker:composeDown": "mutate",
  "docker:follow": "mutate",
  "docker:unfollow": "mutate",
  "api:collections": "read",
  "api:tree": "read",
  "api:request": "read",
  "api:save": "mutate",
  "api:send": "mutate",
  "api:curl": "read",
  "api:history": "read",
  "api:clearHistory": "mutate",
  "api:cookies": "read",
  "api:clearCookies": "mutate",
  "api:removeCookie": "mutate",
  "api:settings": "read",
  "api:createRequest": "mutate",
  "api:createFolder": "mutate",
  "api:rename": "mutate",
  "api:delete": "mutate",
  "api:createCollection": "mutate",
  "api:saveEnvironment": "mutate",
  "api:importPostman": "mutate",
  "remote:readJsonUpload": "mutate",
  "bookmarks:list": "read",
  "bookmarks:add": "mutate",
  "bookmarks:remove": "mutate",
  "bookmarks:setPinned": "mutate",
  "bookmarks:rename": "mutate",
  "bookmarks:reorder": "mutate",
  "settings:read": "read",
  "projects:list": "read",
  "remote:registerPush": "mutate",
  "remote:unregisterPush": "mutate",
} as const satisfies Record<RemoteChannel, "read" | "mutate" | "input">;

/** M12 Task 3: how often `channel`'s outcome gets a `remote-call` audit
 *  line — `auditPolicyFor` alone decides this; `@jarvis/remote` never
 *  names a channel. */
export type AuditPolicy = "always" | "first-per-key" | "never";

/**
 * Rule 2. `isBlobChannel` first: a blob upload channel (never listed in
 * `REMOTE_EFFECT`, since it is not an `InvokeChannel` at all) is always
 * `always` — every upload is worth an audit line regardless of its own
 * classification. Past that, `Object.hasOwn` keeps a channel named
 * `"constructor"`/`"__proto__"` from reading a value off the prototype —
 * `never`, the fail-closed default, same as `isRemoteAllowed`.
 */
export function auditPolicyFor(
  channel: string,
  isBlobChannel: (channel: string) => boolean,
): AuditPolicy {
  if (isBlobChannel(channel)) return "always";
  if (!Object.hasOwn(REMOTE_EFFECT, channel)) return "never";
  const effect = REMOTE_EFFECT[channel as RemoteChannel];
  if (effect === "mutate") return "always";
  if (effect === "input") return "first-per-key";
  return "never";
}
