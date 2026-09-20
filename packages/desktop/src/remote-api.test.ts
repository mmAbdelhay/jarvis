import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  bindRemoteUploadResolver,
  clampRemoteTimeout,
  isCleanScalar,
  MAX_REMOTE_REQUEST_BYTES,
  MAX_REMOTE_COLLECTION_PAIRS,
  MAX_REMOTE_MULTIPART_FILES,
  prepareRemoteApiRequest,
  prepareRemoteApiSave,
  REMOTE_TIMEOUT_CAP_MS,
  stripEphemeralUploadRefs,
  writeAtomically,
} from "./remote-api.js";

// M12 Task 7: writeAtomically's own test needs a real rename that can be
// made to fail on demand, without breaking every other real fs call this
// file (and remote-api.ts's own writeAtomically) makes — `node:fs/promises`
// is an ESM namespace vitest cannot vi.spyOn directly ("Module namespace is
// not configurable"), so this mocks the whole module through to the real
// implementation for everything, with `rename` alone routed through a
// mutable override that defaults to the real `rename` and is set only for
// the one test that needs it to throw.
const renameOverride: { impl?: (...args: unknown[]) => Promise<void> } = {};
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: (...args: unknown[]) =>
      renameOverride.impl
        ? renameOverride.impl(...args)
        : actual.rename(...(args as [never, never])),
  };
});

const request = (overrides: Record<string, unknown> = {}) => ({
  meta: { name: "Request" },
  http: { method: "post", url: "https://api.test/items", body: "none", auth: "none" },
  ...overrides,
});

describe("prepareRemoteApiRequest", () => {
  it.each([
    ["accepts", MAX_REMOTE_COLLECTION_PAIRS, true],
    ["refuses", MAX_REMOTE_COLLECTION_PAIRS + 1, false],
  ])("%s exactly at the remote collection row limit (%i)", (_label, count, accepted) => {
    const result = prepareRemoteApiRequest(
      request({
        headers: Array.from({ length: count }, (_, index) => ({ name: `x-${index}`, value: "v" })),
      }),
      {},
    );
    expect(result.ok).toBe(accepted);
  });

  it.each([
    ["accepts", MAX_REMOTE_MULTIPART_FILES, true],
    ["refuses", MAX_REMOTE_MULTIPART_FILES + 1, false],
  ])("%s exactly at the remote multipart file limit (%i)", (_label, count, accepted) => {
    const result = prepareRemoteApiRequest(
      request({
        http: { method: "post", url: "https://api.test", body: "multipartForm", auth: "none" },
        body: {
          multipartForm: [
            {
              name: "file",
              type: "file",
              value: Array.from({ length: count }, () => ({ uploadId: "a".repeat(32) })),
            },
          ],
        },
      }),
      {},
    );
    expect(result.ok).toBe(accepted);
  });

  it("rebuilds a new request without scripts, tests, or nested hooks", () => {
    const original = request({
      script: { req: "process.exit()", event: { after: "process.exit()" } },
      tests: "process.exit()",
      hooks: { beforeRequest: "process.exit()" },
      headers: [{ name: "x-request-id", value: "one", enabled: true }],
    });

    const result = prepareRemoteApiRequest(original, { token: "safe" });

    expect(result).toEqual({
      ok: true,
      value: {
        request: expect.objectContaining({
          headers: [{ name: "x-request-id", value: "one", enabled: true }],
        }),
        variables: { token: "safe" },
      },
    });
    if (!result.ok) throw new Error("expected a sanitized request");
    expect(result.value.request).not.toBe(original);
    expect(result.value.request).not.toHaveProperty("script");
    expect(result.value.request).not.toHaveProperty("tests");
    expect(result.value.request).not.toHaveProperty("hooks");
  });

  it("refuses OAuth before a request can reach the runner", () => {
    expect(prepareRemoteApiRequest(request({ http: { auth: "oauth2" } }), {})).toMatchObject({
      ok: false,
    });
  });

  it.each([
    ["absolute", ["/etc/passwd"]],
    ["traversal", ["../../.ssh/id_rsa"]],
    ["interpolated", ["{{hostPath}}"]],
    ["mixed", [{ uploadId: "a".repeat(32) }, "/etc/passwd"]],
  ])("refuses %s multipart path bypasses", (_name, value) => {
    const result = prepareRemoteApiRequest(
      request({
        http: { method: "post", url: "https://api.test", body: "multipartForm", auth: "none" },
        body: { multipartForm: [{ name: "file", type: "file", value }] },
      }),
      {},
    );

    expect(result).toMatchObject({ ok: false });
  });

  it("refuses malformed headers and non-string variables instead of dropping them", () => {
    expect(
      prepareRemoteApiRequest(request({ headers: [{ value: "missing-name" }] }), {}),
    ).toMatchObject({
      ok: false,
    });
    expect(prepareRemoteApiRequest(request(), { safe: 1 })).toMatchObject({ ok: false });
  });

  it("caps decoded request and variable bytes before rebuilding fields", () => {
    expect(
      prepareRemoteApiRequest(request({ body: "x".repeat(MAX_REMOTE_REQUEST_BYTES) }), {}),
    ).toMatchObject({
      ok: false,
    });
  });

  // Critical 1 (review, ruling 2026-09-19b): every short scalar
  // jsonToBruV2 writes raw, with no quoting or escaping at all, refuses a
  // control character rather than carrying one through to the file — a
  // `\n` is what lets a crafted value close its own block and open a
  // `script:pre-request { ... }` one of its own.
  it("refuses a meta.name carrying the crafted script-injection payload from the review", () => {
    const craftedName =
      'x\n}\n\nscript:pre-request {\n console.log("INJECTED")\n}\n\nmeta {\n name: y';

    expect(prepareRemoteApiRequest(request({ meta: { name: craftedName } }), {})).toMatchObject({
      ok: false,
    });
  });

  it.each([["\r"], ["\n"], ["\u0000"], ["\u001f"], ["\u007f"]])(
    "refuses a meta.name carrying control character %j",
    (char) => {
      expect(prepareRemoteApiRequest(request({ meta: { name: `x${char}y` } }), {})).toMatchObject({
        ok: false,
      });
    },
  );

  it("restricts http.method to the runner's standard method set, case-insensitively", () => {
    expect(
      prepareRemoteApiRequest(
        request({ http: { method: "PoSt", url: "https://api.test", body: "none", auth: "none" } }),
        {},
      ),
    ).toMatchObject({ ok: true, value: { request: { http: { method: "post" } } } });

    expect(
      prepareRemoteApiRequest(
        request({
          http: {
            method: "get\n}\n\nscript:pre-request {\n console.log(1)\n}",
            url: "https://api.test",
            body: "none",
            auth: "none",
          },
        }),
        {},
      ),
    ).toMatchObject({ ok: false });

    expect(
      prepareRemoteApiRequest(
        request({
          http: { method: "propfind", url: "https://api.test", body: "none", auth: "none" },
        }),
        {},
      ),
    ).toMatchObject({ ok: false });
  });

  it("refuses a control character in a path param's type or an apikey's placement", () => {
    expect(
      prepareRemoteApiRequest(
        request({ params: [{ name: "id", value: "1", type: "path\n" }] }),
        {},
      ),
    ).toMatchObject({ ok: false });

    expect(
      prepareRemoteApiRequest(
        request({
          http: { method: "get", url: "https://api.test", body: "none", auth: "apikey" },
          auth: { apikey: { key: "k", value: "v", placement: "header\n" } },
        }),
        {},
      ),
    ).toMatchObject({ ok: false });
  });

  it("refuses a control character in a multipart field's contentType", () => {
    expect(
      prepareRemoteApiRequest(
        request({
          http: { method: "post", url: "https://api.test", body: "multipartForm", auth: "none" },
          body: {
            multipartForm: [
              { name: "note", type: "text", value: "hi", contentType: "text/plain\n" },
            ],
          },
        }),
        {},
      ),
    ).toMatchObject({ ok: false });
  });

  // Minor (review): a variables key of __proto__/constructor/prototype was
  // silently dropped rather than refused, which loses the caller's
  // variable without telling them — treated the same as any other
  // malformed variables object instead.
  it("refuses a variables object carrying __proto__/constructor/prototype keys", () => {
    const hostile = JSON.parse('{"__proto__":"x","token":"safe"}') as Record<string, unknown>;
    expect(prepareRemoteApiRequest(request(), hostile)).toMatchObject({ ok: false });
    expect(prepareRemoteApiRequest(request(), { constructor: "x" })).toMatchObject({ ok: false });
    expect(prepareRemoteApiRequest(request(), { prototype: "x" })).toMatchObject({ ok: false });
  });

  // Fix round 1b (ruling, same injection class as Critical 1): every row
  // *name* the whitelist copies verbatim — header, query/path param,
  // formUrlEncoded, multipart field, assertion — is a scalar
  // @usebruno/lang's jsonToBru.js writes via getKeyString (or, for a
  // `path`-typed param and an enabled assertion, with no quoting helper at
  // all). A control character is refused in every one of them the same way.
  it.each([
    ["a header name", { headers: [{ name: "x\ny", value: "v", enabled: true }] }],
    [
      "a query param name",
      { params: [{ name: "x\ny", value: "v", enabled: true, type: "query" }] },
    ],
    ["a path param name", { params: [{ name: "x\ny", value: "v", enabled: true, type: "path" }] }],
    ["an assertion name", { assertions: [{ name: "x\ny", value: "v", enabled: true }] }],
  ])("refuses a control character in %s", (_label, overrides) => {
    expect(prepareRemoteApiRequest(request(overrides), {})).toMatchObject({ ok: false });
  });

  it("refuses a control character in a formUrlEncoded row name", () => {
    expect(
      prepareRemoteApiRequest(
        request({
          http: { method: "post", url: "https://api.test", body: "formUrlEncoded", auth: "none" },
          body: { formUrlEncoded: [{ name: "x\ny", value: "v", enabled: true }] },
        }),
        {},
      ),
    ).toMatchObject({ ok: false });
  });

  it("refuses a control character in a multipart field's own name", () => {
    expect(
      prepareRemoteApiRequest(
        request({
          http: { method: "post", url: "https://api.test", body: "multipartForm", auth: "none" },
          body: { multipartForm: [{ name: "x\ny", type: "text", value: "hi" }] },
        }),
        {},
      ),
    ).toMatchObject({ ok: false });
  });

  // Fix round 1b: auth:bearer/basic/apikey's own token/username/password/
  // key/value fields are every bit as raw a sink as meta.name — jsonToBru.js
  // interpolates each one with no quoting at all.
  it("refuses a control character in a bearer token", () => {
    expect(
      prepareRemoteApiRequest(
        request({
          http: { method: "get", url: "https://api.test", body: "none", auth: "bearer" },
          auth: { bearer: { token: "x\ny" } },
        }),
        {},
      ),
    ).toMatchObject({ ok: false });
  });

  it("refuses a control character in a basic auth username or password", () => {
    expect(
      prepareRemoteApiRequest(
        request({
          http: { method: "get", url: "https://api.test", body: "none", auth: "basic" },
          auth: { basic: { username: "x\ny", password: "p" } },
        }),
        {},
      ),
    ).toMatchObject({ ok: false });

    expect(
      prepareRemoteApiRequest(
        request({
          http: { method: "get", url: "https://api.test", body: "none", auth: "basic" },
          auth: { basic: { username: "u", password: "x\ny" } },
        }),
        {},
      ),
    ).toMatchObject({ ok: false });
  });

  it("refuses a control character in an apikey's key or value", () => {
    expect(
      prepareRemoteApiRequest(
        request({
          http: { method: "get", url: "https://api.test", body: "none", auth: "apikey" },
          auth: { apikey: { key: "x\ny", value: "v", placement: "header" } },
        }),
        {},
      ),
    ).toMatchObject({ ok: false });

    expect(
      prepareRemoteApiRequest(
        request({
          http: { method: "get", url: "https://api.test", body: "none", auth: "apikey" },
          auth: { apikey: { key: "k", value: "x\ny", placement: "header" } },
        }),
        {},
      ),
    ).toMatchObject({ ok: false });
  });

  // Fix round 1b (ruling checklist): `meta.type` and `http.body`/`http.auth`
  // ("body mode strings") are never at risk from a submitted request —
  // meta.type has no path from `submitted` into the result at all, and the
  // body/auth mode strings must already exactly match a fixed safe set.
  it("never carries a submitted meta.type through, and refuses a body mode outside its fixed set", () => {
    const result = prepareRemoteApiRequest(request({ meta: { name: "R", type: "http\ny" } }), {});
    expect(result).toMatchObject({ ok: true, value: { request: { meta: { name: "R" } } } });
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.request["meta"]).not.toHaveProperty("type");

    expect(
      prepareRemoteApiRequest(
        request({ http: { method: "get", url: "https://api.test", body: "json\n", auth: "none" } }),
        {},
      ),
    ).toMatchObject({ ok: false });
  });
});

describe("isCleanScalar", () => {
  it("accepts an ordinary short value and refuses one carrying a control character", () => {
    expect(isCleanScalar("List orders")).toBe(true);
    expect(isCleanScalar("a\nb")).toBe(false);
    expect(isCleanScalar("a\rb")).toBe(false);
    expect(isCleanScalar("a\u0000b")).toBe(false);
    expect(isCleanScalar("a\u007fb")).toBe(false);
  });

  // M12 Task 7 (M9 T4 minor, deferred): ''' is @usebruno/lang's own
  // raw-string delimiter (jsonToBru.js's getValueString) — a value
  // containing it closes the enclosing `'''...'''` block early, the same
  // break-out class the control-character checks above exist to close.
  it("refuses a value carrying the ''' raw-string delimiter, even with no control character present", () => {
    expect(isCleanScalar("ordinary")).toBe(true);
    expect(isCleanScalar("a'''b")).toBe(false);
    expect(isCleanScalar("'''")).toBe(false);
    expect(isCleanScalar("a''b")).toBe(true); // two quotes alone do not open the block
  });
});

// M12 Task 7 (controller ruling 6): isCleanScalar's ''' refusal reaches a
// value, a row name, an environment name, and a Postman-import scalar —
// the identical set the control-character checks above already guard, and
// it applies to a desktop-origin call through ipc.ts's guardedWrite too
// (ipc.test.ts's "refuses to save an environment whose variable name
// carries the ''' raw-string delimiter" and
// remote-import-guard.test.ts's Postman-scalar coverage exercise the other
// two; this file covers prepareRemoteApiRequest's own value/row-name
// sinks).
describe("''' raw-string delimiter refusal (M9 T4 minor)", () => {
  it("refuses a remote save URL carrying the ''' raw-string delimiter", () => {
    expect(
      prepareRemoteApiSave(
        undefined,
        request({
          http: { method: "get", url: "https://api.test/x'''y", body: "none", auth: "none" },
        }),
      ),
    ).toMatchObject({ ok: false });
  });

  it("refuses a remote save header value carrying the ''' raw-string delimiter", () => {
    expect(
      prepareRemoteApiSave(
        undefined,
        request({ headers: [{ name: "x-test", value: "x'''y", enabled: true }] }),
      ),
    ).toMatchObject({ ok: false });
  });

  it("keeps a multiline header value (newline, tab, carriage return) but refuses any other control character", () => {
    const pem = "-----BEGIN-----\nab\tcd\r\n-----END-----";
    expect(
      prepareRemoteApiSave(
        undefined,
        request({ headers: [{ name: "x-pem", value: pem, enabled: true }] }),
      ),
    ).toMatchObject({ ok: true });
    expect(
      prepareRemoteApiSave(
        undefined,
        request({ headers: [{ name: "x-test", value: "a\u0007b", enabled: true }] }),
      ),
    ).toMatchObject({ ok: false });
  });

  it("refuses ''' in a header row's own name", () => {
    expect(
      prepareRemoteApiRequest(
        request({ headers: [{ name: "x'''y", value: "v", enabled: true }] }),
        {},
      ),
    ).toMatchObject({ ok: false });
  });

  it("refuses ''' in meta.name", () => {
    expect(prepareRemoteApiRequest(request({ meta: { name: "x'''y" } }), {})).toMatchObject({
      ok: false,
    });
  });

  it("refuses ''' in a bearer token", () => {
    expect(
      prepareRemoteApiRequest(
        request({
          http: { method: "get", url: "https://api.test", body: "none", auth: "bearer" },
          auth: { bearer: { token: "x'''y" } },
        }),
        {},
      ),
    ).toMatchObject({ ok: false });
  });
});

describe("prepareRemoteApiSave: settings fold never invents a timeout key", () => {
  // M12 Task 7 (M9 T4 minor, deferred: "default timeout:0 written back on
  // fold"): settings is folded forward as the exact onDisk object — never
  // rebuilt field by field with a default — so a file that never had a
  // `timeout` key still does not have one after a fold.
  // [bite-proof: rebuild settings as {timeout: onDisk.settings?.timeout ??
  // 0, ...onDisk.settings} instead of the plain passthrough; a `timeout: 0`
  // key appears where this asserts there is none]
  it("folds settings forward without inventing a timeout key when onDisk never had one", () => {
    const onDisk = {
      meta: { name: "old" },
      http: { method: "get", url: "https://api.test", body: "none", auth: "none" },
      settings: { encodeUrl: true },
    };
    const submitted = {
      meta: { name: "new" },
      http: { method: "get", url: "https://api.test", body: "none", auth: "none" },
    };

    const result = prepareRemoteApiSave(onDisk, submitted);

    expect(result).toMatchObject({ ok: true, value: { settings: { encodeUrl: true } } });
    if (!result.ok) throw new Error("expected ok");
    const settings = result.value["settings"] as Record<string, unknown>;
    expect(settings).not.toHaveProperty("timeout");
  });
});

describe("writeAtomically", () => {
  // M12 Task 7 (M9 T4 minor, deferred: "non-atomic remote save"). Mocks
  // node:fs/promises' rename only — writeFile/rm run for real against a
  // real temp directory — so a failure lands exactly where a real rename
  // failure would (after the temp file is fully written, before it ever
  // replaces the target).
  it("a failing rename leaves the original byte-identical and no temp file behind [bite-proof: write in place; the original is truncated]", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-write-atomically-test-"));
    try {
      const target = join(dir, "request.bru");
      await writeFile(target, "before", "utf8");

      renameOverride.impl = async () => {
        throw new Error("boom");
      };
      try {
        await expect(writeAtomically(target, "after")).rejects.toThrow("boom");
      } finally {
        renameOverride.impl = undefined;
      }

      expect(await readFile(target, "utf8")).toBe("before");
      const entries = await readdir(dir);
      expect(entries).toEqual(["request.bru"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes a new file and reads back the exact text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-write-atomically-test-"));
    try {
      const target = join(dir, "new.bru");
      await writeAtomically(target, "hello");
      expect(await readFile(target, "utf8")).toBe("hello");
      expect(await readdir(dir)).toEqual(["new.bru"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("prepareRemoteApiSave", () => {
  it("folds the on-disk meta.name when submitted has no name", () => {
    const result = prepareRemoteApiSave(
      {
        meta: { name: "on-disk name" },
        http: { method: "get", url: "https://api.test", body: "none", auth: "none" },
      },
      { http: { method: "get", url: "https://api.test", body: "none", auth: "none" } },
    );

    expect(result).toMatchObject({ ok: true, value: { meta: { name: "on-disk name" } } });
  });

  // Fix wave 2: an empty string is exactly as "no usable name" as a missing
  // one — the fold must not treat "" as a submitted name that wins.
  it("folds the on-disk meta.name when submitted's name is an empty string", () => {
    const result = prepareRemoteApiSave(
      {
        meta: { name: "on-disk name" },
        http: { method: "get", url: "https://api.test", body: "none", auth: "none" },
      },
      {
        meta: { name: "" },
        http: { method: "get", url: "https://api.test", body: "none", auth: "none" },
      },
    );

    expect(result).toMatchObject({ ok: true, value: { meta: { name: "on-disk name" } } });
  });

  // M12 Task 12 minor: a whitespace-only submitted name is exactly as "no
  // usable name" as an empty string — the fold must trim before deciding,
  // not just check length > 0.
  it("folds the on-disk meta.name when submitted's name is whitespace-only", () => {
    const result = prepareRemoteApiSave(
      {
        meta: { name: "on-disk name" },
        http: { method: "get", url: "https://api.test", body: "none", auth: "none" },
      },
      {
        meta: { name: "   " },
        http: { method: "get", url: "https://api.test", body: "none", auth: "none" },
      },
    );

    expect(result).toMatchObject({ ok: true, value: { meta: { name: "on-disk name" } } });
  });

  // Critical 2 (review): a remote save used to persist only the executable
  // whitelist, silently discarding meta.seq (display order), meta.type,
  // docs, vars, settings, and any body-mode block other than the one being
  // saved. None of this ever comes from `submitted` — only from `onDisk`,
  // the file this application already wrote — so script/tests/hooks stay
  // exactly as unreachable as prepareRemoteApiRequest already makes them.
  it("preserves seq, type, docs, vars, settings and inactive body blocks, never script or tests", () => {
    const onDisk = {
      meta: { name: "old", seq: "3", type: "http" },
      http: { method: "get", url: "https://api.test", body: "json", auth: "none" },
      body: { json: "{}", text: "old text body", xml: "<old/>" },
      docs: "Some docs",
      vars: { req: [{ name: "token", value: "abc", enabled: true }] },
      settings: { encodeUrl: true },
      script: { req: "process.exit()" },
      tests: "process.exit()",
    };
    const submitted = {
      meta: { name: "new" },
      http: { method: "get", url: "https://api.test", body: "json", auth: "none" },
      body: { json: '{"a":1}' },
      script: { req: "process.exit()" },
      tests: "process.exit()",
    };

    const result = prepareRemoteApiSave(onDisk, submitted);

    expect(result).toMatchObject({
      ok: true,
      value: {
        meta: { name: "new", seq: "3", type: "http" },
        docs: "Some docs",
        vars: { req: [{ name: "token", value: "abc", enabled: true }] },
        settings: { encodeUrl: true },
        body: { json: '{"a":1}', text: "old text body", xml: "<old/>" },
      },
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.value).not.toHaveProperty("script");
    expect(result.value).not.toHaveProperty("tests");
  });

  // C2 residual (fix round 2, review): the round above only proved seq/
  // type/docs/vars/settings/the active-mode-adjacent string body blocks.
  // This proves the rest of the non-executable surface a remote save must
  // not clobber: meta.tags, an inactive graphql/formUrlEncoded/
  // multipartForm/file body block, and every on-disk auth.* sub-block the
  // submitted mode did not populate — none of it ever read from
  // `submitted`.
  it("preserves meta.tags, inactive graphql/formUrlEncoded/multipartForm/file body blocks, and every other on-disk auth block", () => {
    const onDisk = {
      meta: { name: "old", seq: "3", type: "http", tags: ["orders", "v2"] },
      http: { method: "get", url: "https://api.test", body: "json", auth: "bearer" },
      body: {
        json: "{}",
        graphql: { query: "{ a }", variables: '{"b":1}' },
        formUrlEncoded: [{ name: "f", value: "1", enabled: true }],
        multipartForm: [{ name: "m", type: "text", value: "v", enabled: true }],
        file: [{ selected: true, filePath: "/local/only/on/disk.bin" }],
      },
      auth: {
        bearer: { token: "old-token" },
        oauth2: { grantType: "client_credentials", clientId: "id", clientSecret: "secret" },
        awsv4: { accessKeyId: "AKID", secretAccessKey: "shh" },
      },
    };
    const submitted = {
      meta: { name: "new" },
      http: { method: "get", url: "https://api.test", body: "json", auth: "bearer" },
      body: { json: '{"a":1}' },
      auth: { bearer: { token: "new-token" } },
    };

    const result = prepareRemoteApiSave(onDisk, submitted);

    expect(result).toMatchObject({
      ok: true,
      value: {
        meta: { name: "new", tags: ["orders", "v2"] },
        body: {
          json: '{"a":1}',
          graphql: { query: "{ a }", variables: '{"b":1}' },
          formUrlEncoded: [{ name: "f", value: "1", enabled: true }],
          multipartForm: [{ name: "m", type: "text", value: "v", enabled: true }],
          file: [{ selected: true, filePath: "/local/only/on/disk.bin" }],
        },
        auth: {
          // The submitted mode's own edit wins over the on-disk value for
          // the *same* key.
          bearer: { token: "new-token" },
          oauth2: { grantType: "client_credentials", clientId: "id", clientSecret: "secret" },
          awsv4: { accessKeyId: "AKID", secretAccessKey: "shh" },
        },
      },
    });
  });

  // Behaviour rule 4 still applies to a multipartForm block folded in from
  // onDisk because it was inactive, exactly as it already does for the
  // active mode: stripEphemeralUploadRefs runs over whatever
  // prepareRemoteApiSave returns, unconditionally.
  it("still strips an ephemeral upload id from an inactive multipartForm block folded in from onDisk", () => {
    const onDisk = {
      meta: { name: "old" },
      http: { method: "get", url: "https://api.test", body: "json", auth: "none" },
      body: {
        json: "{}",
        multipartForm: [
          { name: "file", type: "file", value: [{ uploadId: "a".repeat(32) }], enabled: true },
        ],
      },
    };
    const submitted = {
      meta: { name: "new" },
      http: { method: "get", url: "https://api.test", body: "json", auth: "none" },
      body: { json: "{}" },
    };

    const result = prepareRemoteApiSave(onDisk, submitted);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const stripped = stripEphemeralUploadRefs(result.value);
    expect(stripped["body"]).toMatchObject({
      multipartForm: [{ name: "file", type: "file", value: [] }],
    });
  });

  it("still refuses a submitted request that fails the executable whitelist", () => {
    const onDisk = { meta: { name: "old", seq: "1" } };
    const submitted = { http: { method: "get", url: "https://api.test", auth: "oauth2" } };

    expect(prepareRemoteApiSave(onDisk, submitted)).toMatchObject({ ok: false });
  });

  it("falls back to the plain whitelist when there is no on-disk request yet", () => {
    const submitted = {
      meta: { name: "New" },
      http: { method: "get", url: "https://api.test", body: "none", auth: "none" },
    };

    expect(prepareRemoteApiSave(undefined, submitted)).toMatchObject({
      ok: true,
      value: { meta: { name: "New" } },
    });
  });
});

describe("remote execution dependencies", () => {
  // Ruling 2026-09-19a: a configured value at or below zero (the settings
  // tab's own "no timeout") or not finite gets the cap itself, not a 1 ms
  // floor that would fail an otherwise-ordinary "no timeout" project on
  // every remote send.
  it("clamps every remote timeout to a positive 30 second maximum", () => {
    expect(clampRemoteTimeout(90_000)).toBe(REMOTE_TIMEOUT_CAP_MS);
    expect(clampRemoteTimeout(0)).toBe(REMOTE_TIMEOUT_CAP_MS);
    expect(clampRemoteTimeout(-5)).toBe(REMOTE_TIMEOUT_CAP_MS);
    expect(clampRemoteTimeout(Number.NaN)).toBe(REMOTE_TIMEOUT_CAP_MS);
  });

  it("leaves a configured value under the cap untouched", () => {
    expect(clampRemoteTimeout(5_000)).toBe(5_000);
  });

  // M12 Task 7 (M9 T4 minor, deferred: "missing cap edge tests") — the
  // seven cap edges: 0, 1, exactly the cap, one past it, NaN, Infinity,
  // negative.
  it("clamps every timeout cap edge correctly", () => {
    expect(clampRemoteTimeout(0)).toBe(REMOTE_TIMEOUT_CAP_MS);
    expect(clampRemoteTimeout(1)).toBe(1);
    expect(clampRemoteTimeout(REMOTE_TIMEOUT_CAP_MS)).toBe(REMOTE_TIMEOUT_CAP_MS);
    expect(clampRemoteTimeout(REMOTE_TIMEOUT_CAP_MS + 1)).toBe(REMOTE_TIMEOUT_CAP_MS);
    expect(clampRemoteTimeout(Number.NaN)).toBe(REMOTE_TIMEOUT_CAP_MS);
    expect(clampRemoteTimeout(Number.POSITIVE_INFINITY)).toBe(REMOTE_TIMEOUT_CAP_MS);
    expect(clampRemoteTimeout(-1)).toBe(REMOTE_TIMEOUT_CAP_MS);
  });

  it("binds upload lookup to the authenticated device and leaves expired ids unresolved", async () => {
    const resolve = vi.fn(async (deviceId: string, uploadId: string) =>
      deviceId === "device-a" && uploadId === "live"
        ? { bytes: new Uint8Array([1]), name: "a.txt", contentType: "text/plain" }
        : undefined,
    );
    const resolver = bindRemoteUploadResolver({ resolve }, { deviceId: "device-a" });

    await expect(resolver("live")).resolves.toMatchObject({ name: "a.txt" });
    await expect(resolver("expired")).resolves.toBeUndefined();
    expect(resolve).toHaveBeenNthCalledWith(1, "device-a", "live");
    expect(resolve).toHaveBeenNthCalledWith(2, "device-a", "expired");
  });
});
