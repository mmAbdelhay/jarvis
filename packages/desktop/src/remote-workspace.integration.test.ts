// M9 Task 8: integration, validation and handoff. The Workspace/Changes/
// Docker/API/history pieces T1-T7 each cover in isolation, wired together
// the way remote-access.ts and main.ts actually wire them — a real
// `createDispatchTable` behind the real `CHANNEL_POLICY` gate
// (remoteRequestHandler), a real `createBlobTable` for
// `remote:uploadFile`, a real `createFileUploadStore` staging directory, a
// real `createDockerFollowers` lifecycle and the real `createApiExecutor`/
// `createApiHandlers` trust boundary for `api:send`/`api:importPostman`.
//
// This file never opens a real socket or a real `@jarvis/remote` bridge
// (that full wire path is remote-voice.integration.test.ts's own scope,
// already proven for the blob-framing/heartbeat machinery this reuses
// unchanged); it drives `remoteRequestHandler`'s `handle()` directly, the
// same "everything past the wire is real" scope remote-file-upload.
// integration.test.ts already established for M9 Task 3. Every fixture
// here is isolated (mkdtemp, in-memory fakes) — nothing connects to the
// installed app.
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthenticatedDevice } from "@jarvis/remote";
import { postmanToRequests } from "@jarvis/platform";
import { FILE_UPLOAD_CHANNEL } from "@jarvis/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiExecutorDeps } from "./api-executor.js";
import { createApiExecutor } from "./api-executor.js";
import { createDockerFollowers, MAX_REMOTE_FOLLOWERS_PER_DEVICE } from "./docker-followers.js";
import { createDispatchTable } from "./dispatch.js";
import { fakeDeps } from "./dispatch.test.js";
import { createFileUploadHandler, createFileUploadStore, type UploadStore } from "./file-upload.js";
import type { ApiHandlerDeps } from "./ipc.js";
import { createApiHandlers } from "./ipc.js";
import { MESSAGES } from "./messages.js";
import { REMOTE_TIMEOUT_CAP_MS } from "./remote-api.js";
import { remoteRequestHandler } from "./remote-access.js";
import { createBlobTable } from "./remote-blob.js";
import { REMOTE_PUSH_POLICY, remoteKeyAuthorizer } from "./remote-push-policy.js";

const DEVICE_A: AuthenticatedDevice = { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "Phone A" };
const DEVICE_B: AuthenticatedDevice = { id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "Phone B" };

// The store's own construction-time wipe (reconcileStaging in file-upload.ts)
// fires an un-awaited recursive rm() of baseDir; this suite's own cleanup
// rm() can race it and hit Windows' well-documented EBUSY/EPERM on a
// directory another handle is still finishing a delete on.
// `maxRetries`/`retryDelay` are fs.rm's own documented answer to exactly
// this — a bounded linear-backoff retry — not a change to what any test
// asserts.
const RM_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;
const PROJECT = "acme";

type Outcome =
  | { kind: "value"; value: unknown }
  | { kind: "unknown-channel" }
  | { kind: "forbidden" };

function outcomeValue(outcome: Outcome): unknown {
  if (outcome.kind !== "value") throw new Error(`expected a value outcome, got ${outcome.kind}`);
  return outcome.value;
}

describe("remote-workspace.integration: dispatch + policy + blob + api-executor + docker followers, wired the way main.ts wires them", () => {
  let baseDir: string;
  let uploadStore: UploadStore;
  let uploadLog: string[];

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "jarvis-remote-workspace-it-"));
    uploadLog = [];
    uploadStore = createFileUploadStore({
      now: Date.now,
      randomId: () => randomBytes(16).toString("hex"),
      baseDir,
      language: "en",
      log: (line) => uploadLog.push(line),
    });
  });

  afterEach(async () => {
    await uploadStore.stop();
    await rm(baseDir, RM_OPTIONS);
  });

  function buildStack() {
    const runScript = vi.fn();
    const fetchOAuth2Token = vi.fn();
    const readFile = vi.fn(async () => new Uint8Array());
    const authorizeInWorkspace = vi.fn(async () => "https://example.invalid/authorized");
    // Proves the uploadId resolves through *this device's own* staged
    // upload store, never a filesystem path (readFile is asserted absent by
    // the caller): resolveUpload is only ever bound for a remote call
    // (api-executor.ts's own `remote === undefined` guard). The uploadId
    // itself comes straight off the sanitized request body this file's own
    // test built — never hardcoded — so a real resolve() against the file
    // actually staged for this device is what proves the wiring, not a
    // coincidence. Typed as the real ApiExecutorDeps["sendRequest"] itself
    // (all four parameters) so the mock's own call log carries `options`
    // too, for the timeout-clamp assertion below.
    const sendRequestImpl: ApiExecutorDeps["sendRequest"] = async (
      request,
      _variables,
      sendDeps,
    ) => {
      const body = request["body"] as { multipartForm?: unknown } | undefined;
      const fields = Array.isArray(body?.multipartForm) ? body.multipartForm : [];
      const firstFile = fields[0] as { value?: { uploadId?: string }[] } | undefined;
      const uploadId = firstFile?.value?.[0]?.uploadId;
      let resolvedBytes = -1;
      if (sendDeps.resolveUpload !== undefined && typeof uploadId === "string") {
        const resolved = await sendDeps.resolveUpload(uploadId);
        resolvedBytes = resolved?.bytes.length ?? -1;
      }
      return {
        status: 200,
        statusText: "OK",
        headers: {},
        body: JSON.stringify({ resolvedBytes }),
        timeMs: 5,
        bytes: 2,
        unresolved: [],
      };
    };
    const sendRequestSpy = vi.fn(sendRequestImpl);

    let projectSettings = { proxyUrl: "", verifyCertificate: true, timeoutMs: 999_999 };
    let history: {
      at: number;
      name: string;
      method: string;
      url: string;
      status: number;
      timeMs: number;
      bytes: number;
      bodyPreview: string;
    }[] = [];
    const projectStore = {
      read: vi.fn(async () => ({ history, cookies: [], settings: projectSettings })),
      addHistory: vi.fn(async (_project: string, entry: (typeof history)[number]) => {
        history = [...history, entry];
        return history;
      }),
      clearHistory: vi.fn(async () => {
        history = [];
      }),
      saveCookies: vi.fn(async () => {}),
      saveSettings: vi.fn(async (_project: string, settings: typeof projectSettings) => {
        projectSettings = settings;
        return settings;
      }),
    };

    const executor = createApiExecutor({
      apiFetch: (async () => {
        throw new Error("apiFetch must never be called for a remote send");
      }) as unknown as typeof fetch,
      now: () => 0,
      runScript,
      fetchOAuth2Token,
      sendRequest: sendRequestSpy,
      readFile,
      multipart: { FormData: FormData, File: File },
      dispatcherFor: () => undefined,
      uploads: { resolve: uploadStore.resolve },
      authorizeInWorkspace,
      store: { read: projectStore.read, saveCookies: projectStore.saveCookies },
    });

    const writeImported = vi.fn(
      async (root: string, name: string, _requests: readonly never[]) => `${root}/${name}`,
    );
    const apiDeps: ApiHandlerDeps = {
      listCollections: () => Promise.resolve([]),
      readCollection: () => Promise.reject(new Error("unused")),
      readRequest: () => Promise.reject(new Error("unused")),
      writeRequest: () => Promise.resolve(),
      sendRequest: executor,
      truncateBody: (body) => body,
      store: projectStore,
      createRequest: (folder, name) => Promise.resolve(`${folder}/${name}.bru`),
      createFolder: (parent, name) => Promise.resolve(`${parent}/${name}`),
      renameRequest: (path, name) => Promise.resolve(`renamed:${path}:${name}`),
      renameFolder: (path, name) => Promise.resolve(`folder:${path}:${name}`),
      deleteEntry: () => Promise.resolve(),
      createCollection: (root, name) => Promise.resolve(`${root}/${name}`),
      writeEnvironment: (path, name) => Promise.resolve(`${path}/environments/${name}.bru`),
      postmanToRequests,
      evaluateAssertions: () => [],
      toCurl: () => "curl 'http://h'",
      writeImported,
      projects: { [PROJECT]: "/p/acme" },
      language: "en",
      realPath: (path: string) => path,
    };
    const api = createApiHandlers(apiDeps);

    const uploadFile = createFileUploadHandler(uploadStore, "en");
    const uploadAudio = vi.fn(async () => ({
      kind: "invalid" as const,
      text: "x",
      language: "en" as const,
    }));
    const blobs = () => createBlobTable({ uploadAudio, uploadFile });

    const dockerFollow = vi.fn((_container: string, _onChunk: (chunk: string) => void) => ({
      close: vi.fn(),
    }));
    const followers = createDockerFollowers({ follow: dockerFollow, send: () => {} });

    const git = {
      ...fakeDeps().git,
      setStaged: vi.fn(async () => ({ ok: true as const, value: null })),
      commit: vi.fn(async () => ({ ok: true as const, value: null })),
    };

    const workspaceState = {
      tabs: [
        {
          id: "tab-terminal-1",
          project: PROJECT,
          url: "",
          kind: "terminal" as const,
          title: "Terminal",
          loading: false,
          canGoBack: false,
          canGoForward: false,
          error: undefined,
          hasPlayingVideo: false,
          pageFullscreen: false,
          suspended: false,
        },
      ],
      activeTabId: "tab-terminal-1",
    };
    const workspace = {
      state: vi.fn(() => workspaceState),
      open: vi.fn(),
      close: vi.fn(),
      activate: vi.fn(),
      rename: vi.fn(),
      move: vi.fn(),
      navigate: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      reload: vi.fn(),
      setDevTools: vi.fn(),
      setDevToolsDock: vi.fn(),
      setVisible: vi.fn(),
      hideAll: vi.fn(),
      requestPictureInPicture: vi.fn(),
      openDocker: vi.fn(),
      openApi: vi.fn(),
    };

    const shellsPanes = [
      { paneKey: "tab-terminal-1", exited: false },
      { paneKey: "tab-terminal-1:split-1", exited: false },
      { paneKey: "some-other-tab", exited: false },
    ];

    const sessionTranscript = vi.fn(async (_sessionId: unknown) => [
      { role: "user" as const, text: "hi", tools: [] },
    ]);
    const sessionStore = { history: vi.fn(() => [{ id: "s1" }]) };

    const dispatchDeps = fakeDeps({
      api,
      workspace,
      // The one project this stack declares — terminal:open's own remote
      // membership gate (dispatch.ts) checks a call's project name against
      // exactly this map.
      projects: { [PROJECT]: "/p/acme" },
      shells: {
        log: vi.fn(() => ""),
        snapshot: vi.fn(() => ({ text: "", end: 0 })),
        panes: vi.fn(() => shellsPanes),
      },
      followers,
      git,
      dockerConfig: { [PROJECT]: [{ name: "Web", container: "web" }] },
      sessionTranscript,
      sessionStore,
      uploads: { readJson: uploadStore.readJson },
      language: "en",
    });
    const table = () => createDispatchTable(dispatchDeps);
    const handle = remoteRequestHandler(table, blobs);

    const streams = {
      hasPane: () => false,
      hasSession: () => false,
      followerOwner: followers.ownerOf,
    };
    const authorizeKey = remoteKeyAuthorizer(streams);

    return {
      handle,
      authorizeKey,
      followers,
      git,
      workspace,
      sessionTranscript,
      sessionStore,
      runScript,
      fetchOAuth2Token,
      readFile,
      sendRequestSpy,
      projectStore,
      uploadStore,
      writeImported,
    };
  }

  it("workspace read surface: snapshot and panes are readable; every tab/pane-mutating channel stays desktop-only", async () => {
    const { handle, workspace } = buildStack();

    const snapshotOutcome = (await handle("workspace:snapshot", [], DEVICE_A)) as Outcome;
    expect(outcomeValue(snapshotOutcome)).toEqual(workspace.state());

    const panesOutcome = (await handle("terminal:panes", ["tab-terminal-1"], DEVICE_A)) as Outcome;
    expect(outcomeValue(panesOutcome)).toEqual([
      { paneKey: "tab-terminal-1", exited: false },
      { paneKey: "tab-terminal-1:split-1", exited: false },
    ]);

    // No laptop view/tab activation: every mutating workspace/terminal/
    // docker/dialog channel below is desktop-only by CHANNEL_POLICY — a
    // remote origin never reaches workspace.ts, a split/close of an
    // existing terminal pane, a native dialog or the docker shell, whatever
    // args it sends. `terminal:open` (creating a *new* tab) is remote-legal
    // now — see the dedicated test below for its own project gate.
    const forbiddenChannels: [string, unknown[]][] = [
      ["workspace:open", [PROJECT, "https://x", "web", undefined]],
      ["workspace:close", ["tab-terminal-1"]],
      ["workspace:rename", ["tab-terminal-1", "renamed"]],
      ["workspace:move", ["tab-terminal-1", "tab-web-1", true]],
      ["workspace:activate", ["tab-terminal-1"]],
      ["workspace:navigate", ["tab-terminal-1", "https://x"]],
      ["workspace:visible", [true]],
      ["terminal:split", ["tab-terminal-1", "pane-1"]],
      ["terminal:closePane", ["tab-terminal-1"]],
      ["docker:shell", [PROJECT, "web"]],
      ["docker:open", [PROJECT]],
      ["dialog:readJson", ["/etc/passwd"]],
      ["dialog:pickFiles", []],
      ["session:resume", ["s1", PROJECT]],
      ["settings:save", [{}]],
      ["api:saveSettings", [PROJECT, {}]],
    ];
    for (const [channel, args] of forbiddenChannels) {
      const outcome = (await handle(channel, args, DEVICE_A)) as Outcome;
      expect(outcome).toEqual({ kind: "forbidden" });
    }
    expect(workspace.open).not.toHaveBeenCalled();
    expect(workspace.close).not.toHaveBeenCalled();
    expect(workspace.activate).not.toHaveBeenCalled();
    expect(workspace.navigate).not.toHaveBeenCalled();
  });

  it("terminal:open: remote-legal for a declared project, refused for an undeclared one, through the real policy gate", async () => {
    const { handle } = buildStack();

    const declaredOutcome = (await handle("terminal:open", [PROJECT], DEVICE_A)) as Outcome;
    expect(outcomeValue(declaredOutcome)).toEqual({ ok: true, value: "" });

    const undeclaredOutcome = (await handle("terminal:open", ["nope"], DEVICE_A)) as Outcome;
    expect(outcomeValue(undeclaredOutcome)).toEqual({
      ok: false,
      text: MESSAGES.unknownProject("en"),
      language: "en",
    });
  });

  it('Changes: stage and commit reach the real git handlers with exact args, and REMOTE_PUSH_POLICY declares git:counts a live "latest" push, never a cached value', async () => {
    const { handle, git } = buildStack();

    const stageOutcome = (await handle(
      "git:setStaged",
      ["session-1", "src/a.ts", true],
      DEVICE_A,
    )) as Outcome;
    expect(outcomeValue(stageOutcome)).toEqual({ ok: true, value: null });
    expect(git.setStaged).toHaveBeenCalledWith("session-1", "src/a.ts", true);

    const commitOutcome = (await handle(
      "git:commit",
      ["session-1", "fix: a"],
      DEVICE_A,
    )) as Outcome;
    expect(outcomeValue(commitOutcome)).toEqual({ ok: true, value: null });
    expect(git.commit).toHaveBeenCalledWith("session-1", "fix: a");

    // Authoritative refresh (global constraint 5): the phone never trusts a
    // cached view of a mutation's outcome — it re-reads git:changes itself
    // (changes-store.ts's refresh()) and treats a git:counts push as a
    // reason to do the same. This file has no real bridge/broadcaster to
    // actually fire that push through (that live round trip is
    // workspace.e2e.test.ts's own scope, on the mobile side); what this
    // assertion pins server-side is the policy entry itself — "latest",
    // not "reliable" or a cached snapshot — so a future edit that quietly
    // changed it would fail here rather than only be noticed once a phone
    // stopped refreshing after a git push.
    expect(REMOTE_PUSH_POLICY["git:counts"]).toEqual({ kind: "latest" });
  });

  it("upload stages a file, JSON reads back for the owner only, and a hostile remote Postman import is refused (the importer's own event/script/file stripping applies to every import, not a remote-only bound)", async () => {
    const { handle, writeImported } = buildStack();
    const bytes = new TextEncoder().encode(JSON.stringify({ hello: "world" }));

    const uploadOutcome = (await handle(
      FILE_UPLOAD_CHANNEL,
      [{ name: "c.json", contentType: "application/json" }],
      DEVICE_A,
      bytes,
    )) as Outcome;
    const uploaded = outcomeValue(uploadOutcome) as { ok: true; value: { fileId: string } };
    expect(uploaded.ok).toBe(true);

    // Cross-device file refusal: DEVICE_B never sees DEVICE_A's staged file.
    const crossDeviceOutcome = (await handle(
      "remote:readJsonUpload",
      [uploaded.value.fileId],
      DEVICE_B,
    )) as Outcome;
    expect((outcomeValue(crossDeviceOutcome) as { ok: boolean }).ok).toBe(false);

    const ownReadOutcome = (await handle(
      "remote:readJsonUpload",
      [uploaded.value.fileId],
      DEVICE_A,
    )) as Outcome;
    expect(outcomeValue(ownReadOutcome)).toEqual({ ok: true, value: { hello: "world" } });

    const hostile = JSON.parse(
      '{"info":{"schema":"v2.1"},"item":[{"__proto__":{"polluted":true}}]}',
    );
    const hostileOutcome = (await handle(
      "api:importPostman",
      [PROJECT, "hostile", hostile],
      DEVICE_A,
    )) as Outcome;
    expect((outcomeValue(hostileOutcome) as { ok: boolean }).ok).toBe(false);
    expect(writeImported).not.toHaveBeenCalled();

    const collection = {
      info: { name: "demo", schema: "https://schema.getpostman.com/json/collection/v2.1.0/" },
      item: [
        {
          name: "GET /health",
          event: [
            {
              listen: "prerequest",
              script: { exec: ["require('fs').readFileSync('/etc/passwd')"] },
            },
          ],
          request: {
            method: "GET",
            url: "https://x/health",
            body: { mode: "file", file: { src: "/etc/passwd" } },
          },
        },
      ],
    };
    const importedOutcome = (await handle(
      "api:importPostman",
      [PROJECT, "demo", collection],
      DEVICE_A,
    )) as Outcome;
    expect((outcomeValue(importedOutcome) as { ok: boolean }).ok).toBe(true);
    expect(writeImported).toHaveBeenCalledTimes(1);
    // postmanToRequests (packages/platform) never reads a collection's
    // event/script/file fields into its own output in the first place —
    // true for a desktop-origin import exactly as here; only the *bound*
    // above (hostile-payload/size/scalar refusal) is remote-only.
    const requestsArg = writeImported.mock.calls[0]?.[2];
    const serializedRequests = JSON.stringify(requestsArg);
    expect(serializedRequests).not.toContain("prerequest");
    expect(serializedRequests).not.toContain("readFileSync");
    expect(serializedRequests).not.toContain("/etc/passwd");
  });

  it("api:send resolves a multipart uploadId through this device's own staged upload, skips scripts/OAuth2/local file reads, and clamps the timeout", async () => {
    const { handle, runScript, fetchOAuth2Token, readFile, sendRequestSpy } = buildStack();

    const bytes = new TextEncoder().encode("file contents");
    const uploadOutcome = (await handle(
      FILE_UPLOAD_CHANNEL,
      [{ name: "attach.txt", contentType: "text/plain" }],
      DEVICE_A,
      bytes,
    )) as Outcome;
    const uploaded = outcomeValue(uploadOutcome) as { ok: true; value: { fileId: string } };

    const request = {
      meta: { name: "send" },
      http: { method: "post", url: "https://x/upload", body: "multipartForm" },
      body: {
        multipartForm: [
          { name: "file", type: "file", value: [{ uploadId: uploaded.value.fileId }] },
        ],
      },
      script: { req: "require('fs').readFileSync('/etc/passwd')" },
    };
    const sendOutcome = (await handle("api:send", [PROJECT, request, {}], DEVICE_A)) as Outcome;
    const sendValue = outcomeValue(sendOutcome) as {
      ok: boolean;
      value?: { response: { body: string } };
    };
    expect(sendValue.ok).toBe(true);
    // resolveUpload actually found this device's own staged file — 13
    // bytes, "file contents" — never -1 (not found) or the readFile path.
    expect(JSON.parse(sendValue.value?.response.body ?? "{}")).toEqual({ resolvedBytes: 13 });

    expect(runScript).not.toHaveBeenCalled();
    expect(fetchOAuth2Token).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();

    expect(sendRequestSpy).toHaveBeenCalledTimes(1);
    const call = sendRequestSpy.mock.calls[0];
    if (call === undefined) throw new Error("sendRequest was never called");
    const [, , sendDeps, options] = call;
    expect(typeof sendDeps.resolveUpload).toBe("function");
    expect(sendDeps.readFile).toBeUndefined();
    // The project's own configured timeout (999_999ms) is clamped to the
    // remote cap, never handed through unbounded (remote-api.ts).
    expect(options?.timeoutMs).toBe(REMOTE_TIMEOUT_CAP_MS);
  });

  it("Docker: follow, per-device limit, unfollow (unmount) then reconnect under a fresh follower, and cross-device key refusal", async () => {
    const { handle, authorizeKey, followers } = buildStack();
    const tabId = "remote-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const followOutcome = (await handle(
      "docker:follow",
      [tabId, PROJECT, "web"],
      DEVICE_A,
    )) as Outcome;
    expect((outcomeValue(followOutcome) as { ok: boolean }).ok).toBe(true);
    expect(followers.ownerOf(tabId)).toBe(DEVICE_A.id);

    // Cross-device follower refusal: only the owning device may subscribe
    // to this tabId's docker:log key.
    expect(authorizeKey("docker:log", tabId, DEVICE_A)).toBe(true);
    expect(authorizeKey("docker:log", tabId, DEVICE_B)).toBe(false);

    // Another device may not silently take over this device's follower.
    const stolenOutcome = (await handle(
      "docker:follow",
      [tabId, PROJECT, "web"],
      DEVICE_B,
    )) as Outcome;
    expect((outcomeValue(stolenOutcome) as { ok: boolean }).ok).toBe(false);

    // Per-device follow limit (docker-followers.ts): three more distinct
    // tabs for DEVICE_A reach the cap; a fifth is refused.
    const extraTabIds: string[] = [];
    for (let i = 0; i < MAX_REMOTE_FOLLOWERS_PER_DEVICE - 1; i++) {
      const extraTabId = `remote-b${i}${"0".repeat(30)}`;
      extraTabIds.push(extraTabId);
      const extraOutcome = (await handle(
        "docker:follow",
        [extraTabId, PROJECT, "web"],
        DEVICE_A,
      )) as Outcome;
      expect((outcomeValue(extraOutcome) as { ok: boolean }).ok).toBe(true);
    }
    const overLimitOutcome = (await handle(
      "docker:follow",
      ["remote-over-limit0000000000000000", PROJECT, "web"],
      DEVICE_A,
    )) as Outcome;
    expect((outcomeValue(overLimitOutcome) as { ok: boolean }).ok).toBe(false);

    // Unmount: the phone's own docker:unfollow (docker-log-stream.ts's
    // close()) drops exactly the one tab it owns — the other three
    // followers for this device are untouched.
    await handle("docker:unfollow", [tabId], DEVICE_A);
    expect(followers.ownerOf(tabId)).toBeUndefined();
    expect(authorizeKey("docker:log", tabId, DEVICE_A)).toBe(false);
    for (const extraTabId of extraTabIds) {
      expect(followers.ownerOf(extraTabId)).toBe(DEVICE_A.id);
    }

    // Reconnect: a dropped socket is not an explicit unfollow of any one
    // tab — main.ts's own disconnect handler reaps *every* follower this
    // device owns via followers.unfollowOwnedBy(deviceId), never a single
    // docker:unfollow call. Exercised directly here since this file does
    // not stand up a real connection to actually drop.
    const reapedCount = followers.unfollowOwnedBy(DEVICE_A.id);
    expect(reapedCount).toBe(extraTabIds.length);
    for (const extraTabId of extraTabIds) {
      expect(followers.ownerOf(extraTabId)).toBeUndefined();
      expect(authorizeKey("docker:log", extraTabId, DEVICE_A)).toBe(false);
    }

    // Every one of this device's four slots is free again after the
    // reap — not just the tab an explicit unfollow would have targeted —
    // so a fresh docker:follow for the original tabId succeeds.
    const reconnectOutcome = (await handle(
      "docker:follow",
      [tabId, PROJECT, "web"],
      DEVICE_A,
    )) as Outcome;
    expect((outcomeValue(reconnectOutcome) as { ok: boolean }).ok).toBe(true);
    expect(followers.ownerOf(tabId)).toBe(DEVICE_A.id);
  });

  it("revocation reclaims a device's already-staged uploads and discards one still being written, and nothing ever logs their content", async () => {
    const { handle, uploadStore } = buildStack();
    const secretMarker = "TOP-SECRET-PAYLOAD-1234";

    // A file staged before the revoke: reclaimed, the ordinary case.
    const earlierBytes = new TextEncoder().encode(
      JSON.stringify({ note: secretMarker, phase: "earlier" }),
    );
    const earlierOutcome = (await handle(
      FILE_UPLOAD_CHANNEL,
      [{ name: "a.json", contentType: "application/json" }],
      DEVICE_A,
      earlierBytes,
    )) as Outcome;
    const earlierUploaded = outcomeValue(earlierOutcome) as { ok: true; value: { fileId: string } };
    const beforeRevoke = (await handle(
      "remote:readJsonUpload",
      [earlierUploaded.value.fileId],
      DEVICE_A,
    )) as Outcome;
    expect((outcomeValue(beforeRevoke) as { ok: boolean; value?: unknown }).ok).toBe(true);

    // A second upload racing the revoke itself — the same "revoke lands
    // while a put() is still writing" case file-upload.test.ts's own
    // bite-proof covers (file-upload.test.ts:304-323: "revoke() that
    // lands while a put() is still writing discards the result and the
    // file"), exercised here through the full request-routing stack
    // (handle() -> the blob table -> the real store) rather than calling
    // store.put() directly. remote-access.ts's onDeviceRevoked calls
    // exactly this uploadStore.revoke() on a real revoke() (never a plain
    // disconnect) — exercised directly here since this file does not
    // stand up the whole bridge/device store.
    const raceBytes = new TextEncoder().encode(
      JSON.stringify({ note: secretMarker, phase: "race" }),
    );
    const racePromise = handle(
      FILE_UPLOAD_CHANNEL,
      [{ name: "b.json", contentType: "application/json" }],
      DEVICE_A,
      raceBytes,
    );
    const revokePromise = uploadStore.revoke(DEVICE_A.id); // bumps the generation before its own await
    const raceOutcome = (await racePromise) as Outcome;
    await revokePromise;
    expect((outcomeValue(raceOutcome) as { ok: boolean }).ok).toBe(false);

    const afterRevoke = (await handle(
      "remote:readJsonUpload",
      [earlierUploaded.value.fileId],
      DEVICE_A,
    )) as Outcome;
    expect((outcomeValue(afterRevoke) as { ok: boolean }).ok).toBe(false);

    const joinedLog = uploadLog.join("\n");
    expect(joinedLog).not.toContain(secretMarker);
    expect(joinedLog).not.toContain(earlierUploaded.value.fileId);
  });

  it("history and transcript reads are remote-allowed and read-only", async () => {
    const { handle, sessionStore, sessionTranscript } = buildStack();

    const historyOutcome = (await handle("history:list", [], DEVICE_A)) as Outcome;
    expect(outcomeValue(historyOutcome)).toEqual(sessionStore.history());

    const transcriptOutcome = (await handle("session:transcript", ["s1"], DEVICE_A)) as Outcome;
    expect(outcomeValue(transcriptOutcome)).toEqual(await sessionTranscript("s1"));

    // session:resume (resuming a session in the laptop's own terminal) is
    // desktop-only — a read of history/transcript never implies the power
    // to take one over.
    const resumeOutcome = (await handle("session:resume", ["s1", PROJECT], DEVICE_A)) as Outcome;
    expect(resumeOutcome).toEqual({ kind: "forbidden" });
  });
});
