// A focused integration test (M9 Task 3): the pieces file-upload.test.ts,
// remote-import-guard.test.ts, dispatch.test.ts and remote-access.test.ts
// each cover in isolation, wired together the way main.ts actually wires
// them — a blob upload reaching the store through remoteRequestHandler's
// own gate, a JSON read-back reaching the same store through the ordinary
// dispatch table, and a remote api:importPostman call running through the
// same bounded-import guard whether or not an upload was ever involved.
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthenticatedDevice } from "@jarvis/remote";
import { postmanToRequests } from "@jarvis/platform";
import { FILE_UPLOAD_CHANNEL, VOICE_UPLOAD_CHANNEL } from "@jarvis/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDispatchTable } from "./dispatch.js";
import { fakeDeps } from "./dispatch.test.js";
import { createFileUploadHandler, createFileUploadStore, type UploadStore } from "./file-upload.js";
import { createApiHandlers, type ApiHandlerDeps } from "./ipc.js";
import { remoteRequestHandler } from "./remote-access.js";
import { createBlobTable, type BlobHandler } from "./remote-blob.js";

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

type Outcome =
  | { kind: "value"; value: unknown }
  | { kind: "unknown-channel" }
  | { kind: "forbidden" };

describe("remote file upload + bounded JSON import: integration", () => {
  let baseDir: string;
  let store: UploadStore;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "jarvis-remote-file-upload-it-"));
    store = createFileUploadStore({
      now: Date.now,
      randomId: () => randomBytes(16).toString("hex"),
      baseDir,
      language: "en",
      log: () => {},
    });
  });

  afterEach(async () => {
    await store.stop();
    await rm(baseDir, RM_OPTIONS);
  });

  function buildStack(
    writeImported = vi.fn(
      async (root: string, name: string, _requests: readonly never[]) => `${root}/${name}`,
    ),
  ) {
    const apiDeps: ApiHandlerDeps = {
      listCollections: () => Promise.resolve([]),
      readCollection: () => Promise.reject(new Error("unused")),
      readRequest: () => Promise.reject(new Error("unused")),
      writeRequest: () => Promise.resolve(),
      sendRequest: () => Promise.reject(new Error("unused")),
      truncateBody: (body) => body,
      store: {
        read: () =>
          Promise.resolve({
            history: [],
            cookies: [],
            settings: { proxyUrl: "", verifyCertificate: true, timeoutMs: 30_000 },
          }),
        addHistory: (_project, entry) => Promise.resolve([entry]),
        clearHistory: () => Promise.resolve(),
        saveCookies: () => Promise.resolve(),
        saveSettings: (_project, settings) => Promise.resolve(settings),
      },
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
      projects: { acme: "/p/acme" },
      language: "en",
      realPath: (path: string) => path,
    };
    const api = createApiHandlers(apiDeps);

    const uploadAudio: BlobHandler = vi.fn(async () => ({
      kind: "invalid",
      text: "x",
      language: "en",
    }));
    const uploadFile = createFileUploadHandler(store, "en");
    const blobs = () => createBlobTable({ uploadAudio, uploadFile });

    const dispatchDeps = fakeDeps({ api, uploads: { readJson: store.readJson } });
    const table = () => createDispatchTable(dispatchDeps);
    const handle = remoteRequestHandler(table, blobs);

    return { handle, writeImported, uploadAudio };
  }

  it("stages a file over the blob channel, then reads it back as JSON for the same device", async () => {
    const { handle } = buildStack();
    const bytes = new TextEncoder().encode(JSON.stringify({ hello: "world" }));

    const uploadOutcome = (await handle(
      FILE_UPLOAD_CHANNEL,
      [{ name: "c.json", contentType: "application/json" }],
      DEVICE_A,
      bytes,
    )) as Outcome;
    expect(uploadOutcome.kind).toBe("value");
    const uploaded = (
      uploadOutcome as { kind: "value"; value: { ok: true; value: { fileId: string } } }
    ).value;
    expect(uploaded.ok).toBe(true);

    const readOutcome = await handle("remote:readJsonUpload", [uploaded.value.fileId], DEVICE_A);
    expect(readOutcome).toEqual({
      kind: "value",
      value: { ok: true, value: { hello: "world" } },
    });
  });

  // [bite-proof: cross-owner ids through the full request-routing stack,
  // not just the store directly]
  it("refuses to read back a staged file for a different device", async () => {
    const { handle } = buildStack();
    const uploadOutcome = (await handle(
      FILE_UPLOAD_CHANNEL,
      [{ name: "c.json", contentType: "application/json" }],
      DEVICE_A,
      new TextEncoder().encode("{}"),
    )) as { kind: "value"; value: { ok: true; value: { fileId: string } } };

    const readOutcome = (await handle(
      "remote:readJsonUpload",
      [uploadOutcome.value.value.fileId],
      DEVICE_B,
    )) as { kind: "value"; value: { ok: boolean } };

    expect(readOutcome.value.ok).toBe(false);
  });

  // [bite-proof: M8 audio uploads unchanged]
  it("remote:uploadAudio still routes to its own handler, unaffected by remote:uploadFile sharing the table", async () => {
    const { handle, uploadAudio } = buildStack();

    const outcome = await handle(
      VOICE_UPLOAD_CHANNEL,
      ["meta"],
      DEVICE_A,
      new Uint8Array([1, 2, 3]),
    );

    expect(outcome).toEqual({
      kind: "value",
      value: { kind: "invalid", text: "x", language: "en" },
    });
    expect(uploadAudio).toHaveBeenCalledTimes(1);
  });

  // [bite-proof: direct import bypass attempt — no upload/blob involved]
  it("refuses a hostile collection sent directly as api:importPostman args, without ever calling writeImported", async () => {
    const { handle, writeImported } = buildStack();
    const hostile = JSON.parse(
      '{"info":{"schema":"v2.1"},"item":[{"__proto__":{"polluted":true}}]}',
    );

    const outcome = (await handle("api:importPostman", ["acme", "hostile", hostile], DEVICE_A)) as {
      kind: "value";
      value: { ok: boolean };
    };

    expect(outcome.value.ok).toBe(false);
    expect(writeImported).not.toHaveBeenCalled();
  });

  // [bite-proof: hooks removed]
  it("imports an ordinary remote collection, stripping event/script/file fields the importer never reads", async () => {
    const { handle, writeImported } = buildStack();
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

    const outcome = (await handle("api:importPostman", ["acme", "demo", collection], DEVICE_A)) as {
      kind: "value";
      value: { ok: boolean };
    };

    expect(outcome.value.ok).toBe(true);
    expect(writeImported).toHaveBeenCalledTimes(1);
    const requestsArg = writeImported.mock.calls[0]?.[2];
    const serialized = JSON.stringify(requestsArg);
    expect(serialized).not.toContain("prerequest");
    expect(serialized).not.toContain("readFileSync");
    expect(serialized).not.toContain("/etc/passwd");
    // M12 Task 7 (task-3-review.md:54): also assert method/url survive, so
    // a converter that dropped *everything* — not just the hooks — could
    // never pass the "not.toContain" assertions above by accident.
    expect(requestsArg?.[0]).toMatchObject({
      json: { http: { method: "get", url: "https://x/health" } },
    });
  });
});
