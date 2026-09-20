import { describe, expect, it, vi } from "vitest";
import type { ApiFailure, ApiResponse, OAuth2Result } from "@jarvis/platform";
import { createApiExecutor, type ApiExecutorDeps } from "./api-executor.js";

const OK_RESPONSE: ApiResponse = {
  status: 200,
  statusText: "OK",
  headers: {},
  body: "{}",
  timeMs: 1,
  bytes: 2,
  unresolved: [],
};

function baseDeps(overrides: Partial<ApiExecutorDeps> = {}) {
  const sendRequest = vi.fn<ApiExecutorDeps["sendRequest"]>(async () => OK_RESPONSE);
  const runScript = vi.fn<ApiExecutorDeps["runScript"]>(() => ({
    variables: {},
    logs: [],
    tests: [],
  }));
  const fetchOAuth2Token = vi.fn(
    async (): Promise<OAuth2Result> => ({
      ok: true,
      token: {
        accessToken: "t",
        placement: "header",
        headerPrefix: "Bearer",
        queryKey: "access_token",
      },
    }),
  );
  const readFile = vi.fn(async () => new Uint8Array());
  const resolve = vi.fn(async () => undefined);
  const saveCookies = vi.fn(async () => undefined);
  const deps: ApiExecutorDeps = {
    apiFetch: fetch,
    now: () => 0,
    runScript,
    fetchOAuth2Token,
    sendRequest,
    readFile,
    multipart: { FormData, File },
    dispatcherFor: () => undefined,
    uploads: { resolve },
    authorizeInWorkspace: vi.fn(async () => "code"),
    store: {
      read: async () => ({
        cookies: [],
        settings: { proxyUrl: "", verifyCertificate: true, timeoutMs: 30_000 },
      }),
      saveCookies,
    },
    ...overrides,
  };
  return { deps, sendRequest, runScript, fetchOAuth2Token, readFile, resolve, saveCookies };
}

const request = (overrides: Record<string, unknown> = {}) => ({
  http: { method: "post", url: "https://api.test", auth: "none", body: "none" },
  ...overrides,
});

describe("createApiExecutor", () => {
  it("desktop origin: runs a pre-request script and hands the runner a readFile dependency", async () => {
    const { deps, sendRequest, runScript } = baseDeps();
    const executor = createApiExecutor(deps);

    await executor(request({ script: { req: "setVariable('x','1')" } }), {}, "acme");

    expect(runScript).toHaveBeenCalledTimes(1);
    expect(sendRequest).toHaveBeenCalledTimes(1);
    const [, , sendDeps, options] = sendRequest.mock.calls[0] ?? [];
    expect(sendDeps).toHaveProperty("readFile");
    expect(sendDeps).not.toHaveProperty("resolveUpload");
    expect((options as { timeoutMs: number }).timeoutMs).toBe(30_000);
  });

  // Fix round 2, item 4 (review): the pre-request script gate was already
  // tested above; this covers the *other* runScript call site — the
  // post-response script and the standalone `tests` block, which only run
  // once a response has actually come back (`!("failed" in response)`),
  // desktop-origin only.
  it("desktop origin: runs the post-response script and the tests block against a successful response", async () => {
    const { deps, runScript } = baseDeps();
    const executor = createApiExecutor(deps);

    await executor(
      request({ script: { res: "afterScript()" }, tests: "assertSomething()" }),
      {},
      "acme",
    );

    // Once for script.res, once for the standalone tests block — the same
    // order sendApiRequest's own `after` array always built them in.
    expect(runScript).toHaveBeenCalledTimes(2);
    expect(runScript.mock.calls[0]?.[0]).toBe("afterScript()");
    expect(runScript.mock.calls[1]?.[0]).toBe("assertSomething()");
  });

  it("remote origin: never runs the post-response script or tests block either", async () => {
    const { deps, runScript } = baseDeps();
    const executor = createApiExecutor(deps);

    await executor(
      request({ script: { res: "afterScript()" }, tests: "assertSomething()" }),
      {},
      "acme",
      { deviceId: "device-a" },
    );

    expect(runScript).not.toHaveBeenCalled();
  });

  it("desktop origin: fetches an OAuth2 token when the request asks for one", async () => {
    const { deps, fetchOAuth2Token } = baseDeps();
    const executor = createApiExecutor(deps);

    await executor(
      request({ http: { method: "get", url: "https://api.test", auth: "oauth2" } }),
      {},
      "acme",
    );

    expect(fetchOAuth2Token).toHaveBeenCalledTimes(1);
  });

  it("remote origin: never touches runScript, fetchOAuth2Token, or readFile — even for a script/oauth2 request", async () => {
    const { deps, sendRequest, runScript, fetchOAuth2Token, readFile } = baseDeps();
    const executor = createApiExecutor(deps);

    await executor(
      request({
        http: { method: "get", url: "https://api.test", auth: "oauth2" },
        script: { req: "should never run" },
        tests: "should never run",
      }),
      {},
      "acme",
      { deviceId: "device-a" },
    );

    expect(runScript).not.toHaveBeenCalled();
    expect(fetchOAuth2Token).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    const [, , sendDeps] = sendRequest.mock.calls[0] ?? [];
    expect(sendDeps).not.toHaveProperty("readFile");
  });

  it("remote origin: binds multipart upload resolution to the authenticated device id", async () => {
    const { deps, sendRequest, resolve } = baseDeps();
    const executor = createApiExecutor(deps);

    await executor(request(), {}, "acme", { deviceId: "device-a" });

    const [, , sendDeps] = sendRequest.mock.calls[0] ?? [];
    const resolveUpload = (sendDeps as { resolveUpload?: (id: string) => Promise<unknown> })
      .resolveUpload;
    expect(resolveUpload).toBeTypeOf("function");
    await resolveUpload?.("some-id");
    expect(resolve).toHaveBeenCalledWith("device-a", "some-id");
  });

  it("clamps a remote request's timeout and bounds its response before either reaches the runner", async () => {
    const { deps, sendRequest } = baseDeps({
      store: {
        read: async () => ({
          cookies: [],
          settings: { proxyUrl: "", verifyCertificate: true, timeoutMs: 0 },
        }),
        saveCookies: vi.fn(async () => undefined),
      },
    });
    const executor = createApiExecutor(deps);

    await executor(request(), {}, "acme", { deviceId: "device-a" });

    const [, , , options] = sendRequest.mock.calls[0] ?? [];
    expect(options).toMatchObject({
      timeoutMs: 30_000,
      maxResponseBytes: expect.any(Number),
      maxResponseHeaderBytes: expect.any(Number),
    });
  });

  it("desktop origin: leaves a configured timeout unclamped and never bounds the response", async () => {
    const { deps, sendRequest } = baseDeps({
      store: {
        read: async () => ({
          cookies: [],
          settings: { proxyUrl: "", verifyCertificate: true, timeoutMs: 90_000 },
        }),
        saveCookies: vi.fn(async () => undefined),
      },
    });
    const executor = createApiExecutor(deps);

    await executor(request(), {}, "acme");

    const [, , , options] = sendRequest.mock.calls[0] ?? [];
    expect(options).toMatchObject({ timeoutMs: 90_000 });
    expect(options).not.toHaveProperty("maxResponseBytes");
  });

  it("localizes only the remote-facing failure kinds, and leaves a desktop failure's detail untouched", async () => {
    const failure: ApiFailure = {
      failed: true,
      detail: "boom",
      timeMs: 1,
      kind: "responseTooLarge",
    };
    const { deps } = baseDeps({ sendRequest: vi.fn(async () => failure) });
    const executor = createApiExecutor(deps);

    const remoteResult = await executor(request(), {}, "acme", { deviceId: "device-a" });
    expect(remoteResult.response).toMatchObject({
      failed: true,
      detail: "The server response is too large.",
    });

    const desktopResult = await executor(request(), {}, "acme");
    expect(desktopResult.response).toMatchObject({ detail: "boom" });
  });

  it("localizes a multipart upload failure kind to the file-not-found message", async () => {
    const failure: ApiFailure = {
      failed: true,
      detail: "boom",
      timeMs: 1,
      kind: "multipartUpload",
    };
    const { deps } = baseDeps({ sendRequest: vi.fn(async () => failure) });
    const executor = createApiExecutor(deps);

    const result = await executor(request(), {}, "acme", { deviceId: "device-a" });

    expect(result.response).toMatchObject({ detail: "File not found, or it expired." });
  });

  // M12 Task 12 minor: http-runner.ts's own kind: "timeout" localizes to
  // "The request timed out." for a remote call, and leaves a desktop
  // call's raw detail alone, same discipline as every other kind above.
  it("localizes a timeout failure kind to the timed-out message, and leaves a desktop failure's detail untouched", async () => {
    const failure: ApiFailure = {
      failed: true,
      detail: "The operation was aborted due to timeout",
      timeMs: 1,
      kind: "timeout",
    };
    const { deps } = baseDeps({ sendRequest: vi.fn(async () => failure) });
    const executor = createApiExecutor(deps);

    const remoteResult = await executor(request(), {}, "acme", { deviceId: "device-a" });
    expect(remoteResult.response).toMatchObject({ detail: "The request timed out." });

    const desktopResult = await executor(request(), {}, "acme");
    expect(desktopResult.response).toMatchObject({
      detail: "The operation was aborted due to timeout",
    });
  });
});
