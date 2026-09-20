// Task 4 fix round (Important 2, review): `sendApiRequest` used to live
// entirely inside main.ts, closing over Electron-only state — apiFetch,
// apiMultipart, dispatcherFor, uploadStore, workspace — which meant the one
// place that gates runScript/fetchOAuth2Token/readFile behind
// `remote === undefined` had no test of its own. Extracted here with every
// one of those pieces injected instead, so a spy can prove a remote call
// never reaches any of them, and a desktop call reaches every one of them
// exactly as before. main.ts keeps only the wiring: building `ApiExecutorDeps`
// from its own apiFetch/apiMultipart/dispatcherFor/uploadStore/workspace and
// handing `createApiExecutor`'s return value to createApiHandlers as its own
// `sendRequest` dependency.
import type {
  ApiFailure,
  ApiResponse,
  ApiSettings,
  Cookie,
  NetworkOptions,
  OAuth2Config,
  OAuth2Result,
  OAuth2Token,
  ScriptRequest,
  ScriptResponse,
  ScriptResult,
  SendDeps,
} from "@jarvis/platform";
import { createCookieJar } from "@jarvis/platform";
import { MESSAGES, PRIMARY_LANGUAGE } from "./messages.js";
import {
  bindRemoteUploadResolver,
  clampRemoteTimeout,
  MAX_REMOTE_RESPONSE_BYTES,
  MAX_REMOTE_RESPONSE_HEADER_BYTES,
  type RemoteApiContext,
} from "./remote-api.js";

/** Everything `sendApiRequest` used to reach for on main.ts's own closure.
 *  Grouped so a test can hand in a spy for each and assert it either was or
 *  was never called, per `remote`. */
export type ApiExecutorDeps = {
  apiFetch: typeof fetch;
  now: () => number;
  /** Desktop-only: never called for a remote origin — see the
   *  `remote === undefined` guard around the pre-request script below. */
  runScript: (
    code: string,
    options: {
      variables: Record<string, string>;
      request: ScriptRequest;
      response?: ScriptResponse;
      timeoutMs?: number;
    },
  ) => ScriptResult;
  /** Desktop-only: never called for a remote origin — see the
   *  `remote === undefined` guard around the oauth2 branch below. An
   *  oauth2 auth mode is also refused well before this file by
   *  prepareRemoteApiRequest (Behaviour rule 1); this guard is this file's
   *  own, independent one. */
  fetchOAuth2Token: (
    config: OAuth2Config,
    variables: Record<string, string>,
    deps: {
      fetch: typeof fetch;
      now: () => number;
      authorize?: (url: string, redirectUri: string) => Promise<string>;
    },
  ) => Promise<OAuth2Result>;
  /** The http runner (http-runner.ts's own `sendRequest`) — injected so a
   *  test can assert exactly what this file hands it, never a real
   *  network. */
  sendRequest: (
    request: Record<string, unknown>,
    variables: Record<string, string>,
    deps: SendDeps,
    options?: NetworkOptions,
  ) => Promise<ApiResponse | ApiFailure>;
  /** Desktop-only: a remote call never supplies this to the runner — see
   *  the `remote === undefined` guard where `SendDeps` is assembled. */
  readFile: (path: string) => Promise<Uint8Array>;
  multipart: { FormData: typeof FormData; File: typeof File };
  dispatcherFor: (options: NetworkOptions) => unknown;
  /** Resolves one of a device's own staged uploads. Bound to the
   *  authenticated device id by bindRemoteUploadResolver — never to
   *  anything the request itself names — so a remote send can only ever
   *  read its own device's files. */
  uploads: {
    resolve(
      deviceId: string,
      uploadId: string,
    ): Promise<{ bytes: Uint8Array; name: string; contentType: string } | undefined>;
  };
  /** Desktop-only: a remote call never supplies this either — see the
   *  `remote === undefined` guard around the oauth2 branch. Drives an
   *  OAuth2 authorization-code redirect through a Workspace tab. */
  authorizeInWorkspace: (project: string, url: string, redirectUri?: string) => Promise<string>;
  store: {
    read: (project: string) => Promise<{ cookies: Cookie[]; settings: ApiSettings }>;
    saveCookies: (project: string, cookies: readonly Cookie[]) => Promise<void>;
  };
};

export type ApiExecutorResult = {
  response: ApiResponse | ApiFailure;
  scripts?: { logs: string[]; tests: ScriptResult["tests"]; error?: string };
  cookies: Cookie[];
};

export type ApiExecutor = (
  request: Record<string, unknown>,
  variables: Record<string, string>,
  project: string,
  remote?: RemoteApiContext,
) => Promise<ApiExecutorResult>;

/**
 * One send, with everything a request can ask for around it: the project's
 * cookie jar and network settings, its pre-request and post-response
 * scripts, and an OAuth2 token when the request wants one.
 *
 * `remote` is the whole trust boundary this file enforces. Undefined (a
 * desktop call) runs scripts, allows oauth2, and reads local multipart
 * files exactly as it always has. Present (an authenticated remote call,
 * built only from dispatch.ts's own Origin, never from anything the request
 * itself carries) skips every one of those: no script ever reaches
 * `deps.runScript`, the oauth2 branch is never evaluated so
 * `deps.fetchOAuth2Token` is never called, and `deps.readFile` never
 * appears in the object handed to the runner — instead the timeout is
 * clamped, the response is bounded, and multipart files resolve only
 * through this device's own staged uploads.
 */
export function createApiExecutor(deps: ApiExecutorDeps): ApiExecutor {
  return async function sendApiRequest(request, variables, project, remote) {
    const state = await deps.store.read(project);
    const jar = createCookieJar(state.cookies);
    const settings = state.settings;

    const http = (request["http"] ?? {}) as { method?: string; url?: string; auth?: string };
    const scriptBlock =
      remote === undefined ? ((request["script"] ?? {}) as { req?: string; res?: string }) : {};
    const logs: string[] = [];
    const tests: ScriptResult["tests"] = [];
    let scriptError: string | undefined;

    const scriptRequest: ScriptRequest = {
      method: (http.method ?? "get").toUpperCase(),
      url: http.url ?? "",
      headers: {},
      body: request["body"],
    };

    // The pre-request script runs first, and the variables it sets are
    // available to the request it precedes — that is the whole point of it.
    let resolved = { ...variables };
    if (typeof scriptBlock.req === "string" && scriptBlock.req.trim() !== "") {
      const outcome = deps.runScript(scriptBlock.req, {
        variables: resolved,
        request: scriptRequest,
      });
      resolved = { ...resolved, ...outcome.variables };
      logs.push(...outcome.logs);
      tests.push(...outcome.tests);
      scriptError = outcome.error;
    }

    // OAuth2 is fetched after the pre-request script, so a script can set
    // the client secret the token call needs.
    let token: OAuth2Token | undefined;
    if (remote === undefined && http.auth === "oauth2") {
      const config = ((request["auth"] ?? {}) as Record<string, never>)["oauth2"] ?? {};
      const result = await deps.fetchOAuth2Token(config, resolved, {
        fetch: deps.apiFetch,
        now: deps.now,
        authorize: (url, redirectUri) => deps.authorizeInWorkspace(project, url, redirectUri),
      });
      if (!result.ok) {
        return {
          response: { failed: true as const, detail: `OAuth2: ${result.detail}`, timeMs: 0 },
          cookies: jar.list(),
          scripts: { logs, tests, ...(scriptError === undefined ? {} : { error: scriptError }) },
        };
      }
      token = result.token;
    }

    const response = await deps.sendRequest(
      request,
      resolved,
      {
        fetch: deps.apiFetch,
        now: deps.now,
        jar,
        ...(remote === undefined
          ? { readFile: deps.readFile }
          : { resolveUpload: bindRemoteUploadResolver(deps.uploads, remote) }),
        multipart: deps.multipart,
        dispatcherFor: deps.dispatcherFor,
        ...(token === undefined ? {} : { token }),
      },
      {
        verifyCertificate: settings.verifyCertificate,
        timeoutMs:
          remote === undefined ? settings.timeoutMs : clampRemoteTimeout(settings.timeoutMs),
        ...(settings.proxyUrl === "" ? {} : { proxyUrl: settings.proxyUrl }),
        ...(remote === undefined
          ? {}
          : {
              maxResponseBytes: MAX_REMOTE_RESPONSE_BYTES,
              maxResponseHeaderBytes: MAX_REMOTE_RESPONSE_HEADER_BYTES,
            }),
      },
    );

    // The post-response script and the tests block see the response. A
    // response body that is JSON arrives parsed, which is what every
    // example in the wild assumes.
    if (remote === undefined && !("failed" in response)) {
      let parsed: unknown = response.body;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        // Not JSON; the script gets the text.
      }
      const scriptResponse: ScriptResponse = {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        body: parsed,
        responseTime: response.timeMs,
      };
      const after = [scriptBlock.res, request["tests"]].filter(
        (code): code is string => typeof code === "string" && code.trim() !== "",
      );
      for (const code of after) {
        const outcome = deps.runScript(code, {
          variables: resolved,
          request: scriptRequest,
          response: scriptResponse,
        });
        logs.push(...outcome.logs);
        tests.push(...outcome.tests);
        scriptError = scriptError ?? outcome.error;
      }
    }

    await deps.store.saveCookies(project, jar.list());

    // Important 3 (review): branches on the runner's own `kind`, never on
    // matching its English `detail` text by hand.
    const safeResponse =
      remote !== undefined && "failed" in response
        ? {
            ...response,
            detail:
              response.kind === "responseTooLarge" || response.kind === "responseHeadersTooLarge"
                ? MESSAGES.remoteApiResponseTooLarge(PRIMARY_LANGUAGE)
                : response.kind === "multipartUpload"
                  ? MESSAGES.fileUploadNotFound(PRIMARY_LANGUAGE)
                  : response.kind === "timeout"
                    ? MESSAGES.remoteApiTimedOut(PRIMARY_LANGUAGE)
                    : MESSAGES.apiUnavailable(PRIMARY_LANGUAGE),
          }
        : response;

    return {
      response: safeResponse,
      cookies: jar.list(),
      ...(logs.length === 0 && tests.length === 0 && scriptError === undefined
        ? {}
        : {
            scripts: {
              logs,
              tests,
              ...(scriptError === undefined ? {} : { error: scriptError }),
            },
          }),
    };
  };
}
