// The per-project API store (M9 Task 5): collection -> folder -> request
// drill-down, the request editor's draft/variables, send/save/curl,
// history/cookies/settings reads, collection/folder/request CRUD,
// environment save and Postman import — every `api:*` channel
// remote-policy.ts marks `remote` (packages/desktop/src/remote-policy.ts),
// through `ApiAction`, a discriminated union whose fields match the exact
// current `RendererApi` signatures in packages/desktop/src/ipc.ts (`api:
// saveSettings` is desktop-only — Behaviour: "settings exposes reads
// only", so there is no ApiAction for it).
//
// The `Api*` shapes below mirror packages/platform/src/{bruno,api-store,
// cookies,http-runner,assertions,scripts}.ts and packages/desktop/src/ipc.
// ts's `ApiSendResult` structurally — this file never imports any of them
// (global-constraints.md rule 4: mobile imports only @jarvis/wire at
// runtime and @jarvis/core type-only). Every field is parsed defensively,
// field by field, never spread from the wire payload.
//
// Generation counters (the same pattern as workspace-store.ts/docker-store.
// ts): `open()`, `readTree()` and `readRequest()` each bump their own
// counter before awaiting a reply, and a reply whose generation no longer
// matches is dropped — a stale tree/request answer, or one for a project/
// path the user has since navigated away from, never overwrites what's on
// screen (or a dirty draft) with old data. Reconnect (`client.onState`)
// only ever refreshes the top-level collections list — never re-sends,
// never re-loads the selected tree/request — so a dirty draft is never
// silently replaced and a reconnect can never itself trigger a send.
import type { RpcClient, RpcError, RpcResult } from "./rpc-client";
import { parseGitViewResult } from "./workspace-results";

export type ApiCollection = { name: string; path: string };
export type ApiRequestFile = {
  name: string;
  path: string;
  seq: number;
  method: string;
  url: string;
};
export type ApiFolder = {
  name: string;
  path: string;
  requests: ApiRequestFile[];
  folders: ApiFolder[];
};
export type ApiVariable = { name: string; value: string; enabled: boolean; secret: boolean };
export type ApiEnvironment = { name: string; path: string; variables: ApiVariable[] };
export type ApiTree = {
  collection: ApiCollection;
  root: ApiFolder;
  environments: ApiEnvironment[];
};

export type ApiHistoryEntry = {
  at: number;
  name: string;
  method: string;
  url: string;
  status: number;
  timeMs: number;
  bytes: number;
  bodyPreview: string;
};

export type ApiSettingsView = { proxyUrl: string; verifyCertificate: boolean; timeoutMs: number };

export type ApiCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  secure: boolean;
  httpOnly: boolean;
};

export type ApiHttpResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  timeMs: number;
  bytes: number;
  unresolved: string[];
};

export type ApiHttpFailure = {
  failed: true;
  detail: string;
  timeMs: number;
  kind?: "responseTooLarge" | "responseHeadersTooLarge" | "multipartUpload";
};

export type ApiAssertionResult = {
  target: string;
  expression: string;
  passed: boolean;
  actual: string;
};

export type ApiScriptsResult = {
  logs: string[];
  tests: { name: string; passed: boolean; error?: string }[];
  error?: string;
};

export type ApiSendResultView = {
  response: ApiHttpResponse | ApiHttpFailure;
  assertions: ApiAssertionResult[];
  scripts?: ApiScriptsResult;
  history: ApiHistoryEntry[];
  cookies: ApiCookie[];
};

/** Every current `RendererApi` mutation/read the phone's API pane can
 *  reach, with the exact arguments `invoke()` sends — see
 *  packages/desktop/src/ipc.ts lines 620-702 for the signatures this
 *  mirrors. Explicit named fields, never an arbitrary channel string. */
export type ApiAction =
  | { kind: "send" }
  | { kind: "save" }
  | { kind: "curl" }
  | { kind: "history" }
  | { kind: "clearHistory" }
  | { kind: "cookies" }
  | { kind: "clearCookies" }
  | { kind: "removeCookie"; name: string; domain: string; path: string }
  | { kind: "settings" }
  | { kind: "createRequest"; folderPath: string; name: string; seq: number }
  | { kind: "createFolder"; parentPath: string; name: string }
  | { kind: "rename"; path: string; name: string; isFolder: boolean }
  | { kind: "delete"; path: string }
  | { kind: "createCollection"; name: string }
  | { kind: "saveEnvironment"; collectionPath: string; name: string; variables: ApiVariable[] }
  | { kind: "importPostman"; name: string; collection: unknown };

export type ApiView = {
  project?: string;
  phase: "idle" | "loading" | "ready" | "failed";
  collections: ApiCollection[];
  selectedCollectionPath?: string;
  tree?: ApiTree;
  treeLoading: boolean;
  selectedRequestPath?: string;
  /** The last on-disk copy of the selected request, as `readRequest`/`save`
   *  last saw it — the merge base `save` submits alongside `draft`. */
  request?: Record<string, unknown>;
  /** The editable copy the request editor mutates via `setDraft`. */
  draft?: Record<string, unknown>;
  requestLoading: boolean;
  dirty: boolean;
  variables: Record<string, string>;
  lastResponse?: ApiSendResultView;
  history: ApiHistoryEntry[];
  cookies: ApiCookie[];
  settings?: ApiSettingsView;
  curlText?: string;
  busy: boolean;
  stale: boolean;
  uncertain: boolean;
  notice?: string;
};

export type ApiStore = {
  get(): ApiView;
  subscribe(fn: (view: ApiView) => void): () => void;
  open(project: string): void;
  /** Fix round 1 (I3): re-reads the collections list (and the selected
   *  tree, if any) for the currently open project — pull-to-refresh's own
   *  entry point, since calling `open()` again would reset the draft and
   *  selection `open()` is otherwise careful to preserve. A no-op before
   *  any `open()`. */
  refresh(): void;
  readTree(path: string): void;
  readRequest(path: string): void;
  setDraft(request: Record<string, unknown>): void;
  setVariables(variables: Record<string, string>): void;
  invoke(action: ApiAction): Promise<void>;
  close(): void;
};

/** Shown for a failed read/action with no server text to show verbatim —
 *  the same `i18n.ts` `MessageKey`-as-notice convention as docker-store.ts's
 *  `DOCKER_LOAD_FAILED`. */
export const API_LOAD_FAILED = "api.loadFailed";
/** `invoke()` called while a previous action is still in flight. */
export const API_ACTION_BUSY = "api.busy";
/** The laptop's welcome didn't advertise this channel — behaviour rule 3:
 *  shown as an explicit refusal, never hidden behind optimistic success. */
export const API_CAPABILITY_MISSING = "api.capabilityMissing";

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArray<T>(value: unknown, parseItem: (v: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: T[] = [];
  for (const item of value) {
    const parsed = parseItem(item);
    if (parsed === undefined) return undefined;
    out.push(parsed);
  }
  return out;
}

function parseStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isString(entry)) return undefined;
    out[key] = entry;
  }
  return out;
}

function parseCollection(value: unknown): ApiCollection | undefined {
  if (!isRecord(value) || !isString(value.name) || !isString(value.path)) return undefined;
  return { name: value.name, path: value.path };
}

function parseRequestFile(value: unknown): ApiRequestFile | undefined {
  if (!isRecord(value)) return undefined;
  const { name, path, seq, method, url } = value;
  if (!isString(name) || !isString(path) || !isFiniteNumber(seq)) return undefined;
  if (!isString(method) || !isString(url)) return undefined;
  return { name, path, seq, method, url };
}

function parseFolder(value: unknown): ApiFolder | undefined {
  if (!isRecord(value) || !isString(value.name) || !isString(value.path)) return undefined;
  const requests = parseArray(value.requests, parseRequestFile);
  if (requests === undefined) return undefined;
  const folders = parseArray(value.folders, parseFolder);
  if (folders === undefined) return undefined;
  return { name: value.name, path: value.path, requests, folders };
}

function parseVariable(value: unknown): ApiVariable | undefined {
  if (!isRecord(value) || !isString(value.name) || !isString(value.value)) return undefined;
  if (typeof value.enabled !== "boolean" || typeof value.secret !== "boolean") return undefined;
  return { name: value.name, value: value.value, enabled: value.enabled, secret: value.secret };
}

function parseEnvironment(value: unknown): ApiEnvironment | undefined {
  if (!isRecord(value) || !isString(value.name) || !isString(value.path)) return undefined;
  const variables = parseArray(value.variables, parseVariable);
  if (variables === undefined) return undefined;
  return { name: value.name, path: value.path, variables };
}

export function parseApiTree(value: unknown): ApiTree | undefined {
  if (!isRecord(value)) return undefined;
  const collection = parseCollection(value.collection);
  if (collection === undefined) return undefined;
  const root = parseFolder(value.root);
  if (root === undefined) return undefined;
  const environments = parseArray(value.environments, parseEnvironment);
  if (environments === undefined) return undefined;
  return { collection, root, environments };
}

function parseHistoryEntry(value: unknown): ApiHistoryEntry | undefined {
  if (!isRecord(value)) return undefined;
  const { at, name, method, url, status, timeMs, bytes, bodyPreview } = value;
  if (!isFiniteNumber(at) || !isString(name) || !isString(method) || !isString(url))
    return undefined;
  if (!isFiniteNumber(status) || !isFiniteNumber(timeMs) || !isFiniteNumber(bytes))
    return undefined;
  if (!isString(bodyPreview)) return undefined;
  return { at, name, method, url, status, timeMs, bytes, bodyPreview };
}

function parseCookie(value: unknown): ApiCookie | undefined {
  if (!isRecord(value)) return undefined;
  const { name, value: cookieValue, domain, path, secure, httpOnly, expires } = value;
  if (!isString(name) || !isString(cookieValue) || !isString(domain) || !isString(path)) {
    return undefined;
  }
  if (typeof secure !== "boolean" || typeof httpOnly !== "boolean") return undefined;
  const cookie: ApiCookie = { name, value: cookieValue, domain, path, secure, httpOnly };
  if (expires !== undefined) {
    if (!isFiniteNumber(expires)) return undefined;
    cookie.expires = expires;
  }
  return cookie;
}

function parseApiSettings(value: unknown): ApiSettingsView | undefined {
  if (!isRecord(value)) return undefined;
  const { proxyUrl, verifyCertificate, timeoutMs } = value;
  if (!isString(proxyUrl) || typeof verifyCertificate !== "boolean" || !isFiniteNumber(timeoutMs)) {
    return undefined;
  }
  return { proxyUrl, verifyCertificate, timeoutMs };
}

const FAILURE_KINDS = new Set(["responseTooLarge", "responseHeadersTooLarge", "multipartUpload"]);

function parseApiFailure(value: unknown): ApiHttpFailure | undefined {
  if (!isRecord(value) || value.failed !== true) return undefined;
  const { detail, timeMs, kind } = value;
  if (!isString(detail) || !isFiniteNumber(timeMs)) return undefined;
  const failure: ApiHttpFailure = { failed: true, detail, timeMs };
  if (isString(kind) && FAILURE_KINDS.has(kind)) {
    failure.kind = kind as ApiHttpFailure["kind"];
  }
  return failure;
}

function parseApiResponse(value: unknown): ApiHttpResponse | undefined {
  if (!isRecord(value)) return undefined;
  const { status, statusText, headers, body, timeMs, bytes, unresolved } = value;
  if (!isFiniteNumber(status) || !isString(statusText)) return undefined;
  const parsedHeaders = parseStringRecord(headers);
  if (parsedHeaders === undefined) return undefined;
  if (!isString(body) || !isFiniteNumber(timeMs) || !isFiniteNumber(bytes)) return undefined;
  const parsedUnresolved = parseArray(unresolved, (v) => (isString(v) ? v : undefined));
  if (parsedUnresolved === undefined) return undefined;
  return {
    status,
    statusText,
    headers: parsedHeaders,
    body,
    timeMs,
    bytes,
    unresolved: parsedUnresolved,
  };
}

function parseApiResponseOrFailure(value: unknown): ApiHttpResponse | ApiHttpFailure | undefined {
  return parseApiFailure(value) ?? parseApiResponse(value);
}

function parseAssertionResult(value: unknown): ApiAssertionResult | undefined {
  if (!isRecord(value)) return undefined;
  const { target, expression, passed, actual } = value;
  if (!isString(target) || !isString(expression) || typeof passed !== "boolean") return undefined;
  if (!isString(actual)) return undefined;
  return { target, expression, passed, actual };
}

function parseScriptTest(
  value: unknown,
): { name: string; passed: boolean; error?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const { name, passed, error } = value;
  if (!isString(name) || typeof passed !== "boolean") return undefined;
  const test: { name: string; passed: boolean; error?: string } = { name, passed };
  if (isString(error)) test.error = error;
  return test;
}

function parseScriptsResult(value: unknown): ApiScriptsResult | undefined {
  if (!isRecord(value)) return undefined;
  const { logs, tests, error } = value;
  const parsedLogs = parseArray(logs, (v) => (isString(v) ? v : undefined));
  if (parsedLogs === undefined) return undefined;
  const parsedTests = parseArray(tests, parseScriptTest);
  if (parsedTests === undefined) return undefined;
  const result: ApiScriptsResult = { logs: parsedLogs, tests: parsedTests };
  if (isString(error)) result.error = error;
  return result;
}

export function parseApiSendResult(value: unknown): ApiSendResultView | undefined {
  if (!isRecord(value)) return undefined;
  const response = parseApiResponseOrFailure(value.response);
  if (response === undefined) return undefined;
  const assertions = parseArray(value.assertions, parseAssertionResult);
  if (assertions === undefined) return undefined;
  let scripts: ApiScriptsResult | undefined;
  if (value.scripts !== undefined) {
    scripts = parseScriptsResult(value.scripts);
    if (scripts === undefined) return undefined;
  }
  const history = parseArray(value.history, parseHistoryEntry);
  if (history === undefined) return undefined;
  const cookies = parseArray(value.cookies, parseCookie);
  if (cookies === undefined) return undefined;
  const result: ApiSendResultView = { response, assertions, history, cookies };
  if (scripts !== undefined) result.scripts = scripts;
  return result;
}

function isUncertain(error: RpcError): boolean {
  return error.kind === "offline" || error.kind === "timeout";
}

function noticeFromError(error: RpcError): string | undefined {
  switch (error.kind) {
    case "remote":
      // Server-originated text, displayed verbatim (global-constraints.md
      // rule 7) — never routed through the i18n table.
      return error.text;
    case "offline":
    case "timeout":
      // The `uncertain` flag carries this outcome; no notice text of its
      // own (matches docker-store.ts's noticeFromResult).
      return undefined;
    case "unsupported":
      return API_CAPABILITY_MISSING;
    case "busy":
    case "cancelled":
      // Never actually produced by client.call() (upload()-only kinds) —
      // handled for RpcError's exhaustiveness, not because this can occur.
      return API_LOAD_FAILED;
  }
}

const EMPTY_VIEW: ApiView = {
  phase: "idle",
  collections: [],
  treeLoading: false,
  requestLoading: false,
  dirty: false,
  variables: {},
  history: [],
  cookies: [],
  busy: false,
  stale: false,
  uncertain: false,
};

export function createApiStore(deps: { client: RpcClient }): ApiStore {
  const { client } = deps;
  const listeners = new Set<(view: ApiView) => void>();
  let state: ApiView = { ...EMPTY_VIEW };
  let visible = false;
  let openGeneration = 0;
  let treeGeneration = 0;
  let requestGeneration = 0;
  let unsubscribeState: (() => void) | undefined;

  function setState(patch: Partial<ApiView>): void {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener(state);
  }

  async function loadCollections(project: string, generation: number): Promise<void> {
    const result = await client.call("api:collections", [project], { whenNotOpen: "reject" });
    if (state.project !== project || generation !== openGeneration) return; // stale (rule 5/10)
    if (!result.ok) {
      setState({ phase: "failed", stale: true, notice: noticeFromError(result.error) });
      return;
    }
    const parsed = parseGitViewResult(result.value, (v) => parseArray(v, parseCollection));
    if (parsed.ok) {
      setState({ phase: "ready", stale: false, collections: parsed.value, notice: undefined });
    } else {
      setState({ phase: "failed", stale: true, notice: parsed.text });
    }
  }

  function refreshCollections(): void {
    if (!visible || state.project === undefined) return;
    void loadCollections(state.project, openGeneration);
  }

  function subscribeVisible(): void {
    // Rule: reconnect refreshes the collections list only — never the
    // selected tree/request, and never a send. A dirty draft is never
    // touched by this path.
    unsubscribeState = client.onState((clientState) => {
      if (clientState === "open") refreshCollections();
    });
  }

  function unsubscribeVisible(): void {
    unsubscribeState?.();
    unsubscribeState = undefined;
  }

  function open(project: string): void {
    if (visible) unsubscribeVisible();
    visible = true;
    openGeneration += 1;
    // Fix round 1 (I3): re-opening the *same* project (a blur/refocus, or
    // the screen simply re-mounting) must never discard the draft, the
    // current selection or anything already read — only a genuinely
    // different project resets the view. Either way collections get a
    // background refresh below.
    if (state.project !== project) {
      treeGeneration += 1;
      requestGeneration += 1;
      state = {
        ...EMPTY_VIEW,
        project,
        phase: "loading",
      };
      for (const listener of [...listeners]) listener(state);
    }
    subscribeVisible();
    void loadCollections(project, openGeneration);
  }

  /** Fix round 1 (I3): pull-to-refresh's own entry point — re-reads the
   *  collections list (and the selected tree, if any) without resetting
   *  `open()`'s full view the way calling `open()` again would. */
  function refresh(): void {
    const project = state.project;
    if (project === undefined) return;
    openGeneration += 1;
    setState({ stale: false });
    void loadCollections(project, openGeneration);
    refreshSelectedTree(project);
  }

  async function loadTree(project: string, path: string, generation: number): Promise<void> {
    const result = await client.call("api:tree", [project, path], { whenNotOpen: "reject" });
    if (state.project !== project || generation !== treeGeneration) return; // stale (Tests: "stale tree response")
    if (!result.ok) {
      setState({ treeLoading: false, stale: true, notice: noticeFromError(result.error) });
      return;
    }
    const parsed = parseGitViewResult(result.value, parseApiTree);
    if (parsed.ok) {
      setState({ treeLoading: false, stale: false, tree: parsed.value, notice: undefined });
    } else {
      setState({ treeLoading: false, stale: true, notice: parsed.text });
    }
  }

  function readTree(path: string): void {
    const project = state.project;
    if (project === undefined) return;
    treeGeneration += 1;
    setState({ selectedCollectionPath: path, treeLoading: true });
    void loadTree(project, path, treeGeneration);
  }

  async function loadRequest(project: string, path: string, generation: number): Promise<void> {
    const result = await client.call("api:request", [project, path], { whenNotOpen: "reject" });
    // Stale guard: a reply for a request the user has since navigated away
    // from (or a different project) is dropped without touching `draft` —
    // Tests: "unsaved draft retained".
    if (state.project !== project || generation !== requestGeneration) return;
    if (!result.ok) {
      setState({ requestLoading: false, stale: true, notice: noticeFromError(result.error) });
      return;
    }
    const parsed = parseGitViewResult(result.value, (v) => (isRecord(v) ? v : undefined));
    if (parsed.ok) {
      setState({
        requestLoading: false,
        stale: false,
        request: parsed.value,
        draft: parsed.value,
        dirty: false,
        notice: undefined,
      });
    } else {
      setState({ requestLoading: false, stale: true, notice: parsed.text });
    }
  }

  function readRequest(path: string): void {
    const project = state.project;
    if (project === undefined) return;
    requestGeneration += 1;
    setState({ selectedRequestPath: path, requestLoading: true });
    void loadRequest(project, path, requestGeneration);
  }

  function setDraft(request: Record<string, unknown>): void {
    setState({ draft: request, dirty: true });
  }

  function setVariables(variables: Record<string, string>): void {
    setState({ variables });
  }

  async function refreshHistoryAfterUncertainSend(project: string): Promise<void> {
    const result = await client.call("api:history", [project], { whenNotOpen: "reject" });
    if (state.project !== project || !result.ok) return;
    const parsed = parseGitViewResult(result.value, (v) => parseArray(v, parseHistoryEntry));
    if (parsed.ok) setState({ history: parsed.value });
  }

  async function invoke(action: ApiAction): Promise<void> {
    const project = state.project;
    if (project === undefined) return;
    if (state.busy) {
      setState({ notice: API_ACTION_BUSY });
      return;
    }
    if (client.state() !== "open") {
      setState({ stale: true });
      return;
    }
    setState({ busy: true, notice: undefined });

    switch (action.kind) {
      case "send": {
        const request = state.draft ?? state.request ?? {};
        const result = await client.call("api:send", [project, request, state.variables], {
          whenNotOpen: "reject",
        });
        if (!result.ok) {
          const uncertain = isUncertain(result.error);
          setState({ busy: false, uncertain, notice: noticeFromError(result.error) });
          // Behaviour rule 5: an uncertain outcome refreshes authoritative
          // data before the user can act again — a real history entry
          // means the request actually ran.
          if (uncertain) void refreshHistoryAfterUncertainSend(project);
          return;
        }
        const parsed = parseGitViewResult(result.value, parseApiSendResult);
        if (!parsed.ok) {
          setState({ busy: false, notice: parsed.text });
          return;
        }
        setState({
          busy: false,
          uncertain: false,
          lastResponse: parsed.value,
          history: parsed.value.history,
          cookies: parsed.value.cookies,
        });
        return;
      }
      case "save": {
        // Fix wave 2 (I1 residual): the selection/generation at save start
        // are captured up front — a reply for `path` that lands after the
        // user has since navigated away (a different selectedRequestPath,
        // or the same path re-read for a newer requestGeneration) must
        // never overwrite what is now on screen. `busy` always clears via
        // `finally`, on every return path below.
        try {
          const path = state.selectedRequestPath;
          const draft = state.draft;
          if (path === undefined || draft === undefined) {
            return;
          }
          const savedPath = path;
          const savedGeneration = requestGeneration;
          const savedDraft = draft;

          const result = await client.call("api:save", [project, path, draft], {
            whenNotOpen: "reject",
          });
          if (!result.ok) {
            setState({
              uncertain: isUncertain(result.error),
              notice: noticeFromError(result.error),
            });
            return;
          }
          const parsed = parseGitViewResult(result.value, (): true => true);
          if (!parsed.ok) {
            setState({ notice: parsed.text });
            return;
          }
          setState({ uncertain: false });

          if (state.selectedRequestPath !== savedPath || requestGeneration !== savedGeneration) {
            // The user moved on while the save was in flight — the file is
            // saved, but its re-read is skipped rather than landing under
            // whatever is selected now.
            return;
          }

          const readResult = await client.call("api:request", [project, savedPath], {
            whenNotOpen: "reject",
          });
          if (
            state.project !== project ||
            state.selectedRequestPath !== savedPath ||
            requestGeneration !== savedGeneration
          ) {
            // Moved on again while the re-read itself was in flight.
            return;
          }
          if (!readResult.ok) {
            setState({ dirty: true, stale: true, notice: noticeFromError(readResult.error) });
            return;
          }
          const readParsed = parseGitViewResult(readResult.value, (v) =>
            isRecord(v) ? v : undefined,
          );
          if (!readParsed.ok) {
            setState({ dirty: true, stale: true, notice: readParsed.text });
            return;
          }

          if (state.draft !== savedDraft) {
            // The user kept typing while the re-read was in flight: the
            // laptop's on-disk copy becomes the new merge base, but their
            // keystrokes are never overwritten.
            setState({ request: readParsed.value, dirty: true, stale: false, notice: undefined });
          } else {
            setState({
              request: readParsed.value,
              draft: readParsed.value,
              dirty: false,
              stale: false,
              notice: undefined,
            });
          }
        } finally {
          setState({ busy: false });
        }
        return;
      }
      case "curl": {
        const request = state.draft ?? state.request ?? {};
        const result = await client.call("api:curl", [project, request, state.variables], {
          whenNotOpen: "reject",
        });
        applySimple(
          result,
          (v) => (isString(v) ? v : undefined),
          (curlText) => ({ curlText }),
        );
        return;
      }
      case "history": {
        const result = await client.call("api:history", [project], { whenNotOpen: "reject" });
        applySimple(
          result,
          (v) => parseArray(v, parseHistoryEntry),
          (history) => ({ history }),
        );
        return;
      }
      case "clearHistory": {
        const result = await client.call("api:clearHistory", [project], { whenNotOpen: "reject" });
        applySimple(
          result,
          (): [] => [],
          () => ({ history: [] }),
        );
        return;
      }
      case "cookies": {
        const result = await client.call("api:cookies", [project], { whenNotOpen: "reject" });
        applySimple(
          result,
          (v) => parseArray(v, parseCookie),
          (cookies) => ({ cookies }),
        );
        return;
      }
      case "clearCookies": {
        const result = await client.call("api:clearCookies", [project], { whenNotOpen: "reject" });
        applySimple(
          result,
          (v) => parseArray(v, parseCookie),
          (cookies) => ({ cookies }),
        );
        return;
      }
      case "removeCookie": {
        const result = await client.call(
          "api:removeCookie",
          [project, action.name, action.domain, action.path],
          { whenNotOpen: "reject" },
        );
        applySimple(
          result,
          (v) => parseArray(v, parseCookie),
          (cookies) => ({ cookies }),
        );
        return;
      }
      case "settings": {
        const result = await client.call("api:settings", [project], { whenNotOpen: "reject" });
        applySimple(result, parseApiSettings, (settings) => ({ settings }));
        return;
      }
      case "createRequest": {
        const result = await client.call(
          "api:createRequest",
          [project, action.folderPath, action.name, action.seq],
          { whenNotOpen: "reject" },
        );
        finishMutation(result, () => refreshSelectedTree(project));
        return;
      }
      case "createFolder": {
        const result = await client.call(
          "api:createFolder",
          [project, action.parentPath, action.name],
          { whenNotOpen: "reject" },
        );
        finishMutation(result, () => refreshSelectedTree(project));
        return;
      }
      case "rename": {
        const result = await client.call(
          "api:rename",
          [project, action.path, action.name, action.isFolder],
          { whenNotOpen: "reject" },
        );
        finishMutation(result, () => refreshSelectedTree(project));
        return;
      }
      case "delete": {
        const result = await client.call("api:delete", [project, action.path], {
          whenNotOpen: "reject",
        });
        finishMutation(result, () => {
          if (state.selectedRequestPath === action.path) {
            setState({
              selectedRequestPath: undefined,
              request: undefined,
              draft: undefined,
              dirty: false,
            });
          }
          refreshSelectedTree(project);
        });
        return;
      }
      case "createCollection": {
        const result = await client.call("api:createCollection", [project, action.name], {
          whenNotOpen: "reject",
        });
        finishMutation(result, () => refreshCollections());
        return;
      }
      case "saveEnvironment": {
        const result = await client.call(
          "api:saveEnvironment",
          [project, action.collectionPath, action.name, action.variables],
          { whenNotOpen: "reject" },
        );
        finishMutation(result, () => refreshSelectedTree(project));
        return;
      }
      case "importPostman": {
        const result = await client.call(
          "api:importPostman",
          [project, action.name, action.collection],
          { whenNotOpen: "reject" },
        );
        finishMutation(result, () => refreshCollections());
        return;
      }
    }
  }

  function applySimple<T>(
    result: RpcResult,
    parse: (v: unknown) => T | undefined,
    apply: (value: T) => Partial<ApiView>,
  ): void {
    if (!result.ok) {
      setState({
        busy: false,
        uncertain: isUncertain(result.error),
        notice: noticeFromError(result.error),
      });
      return;
    }
    const parsed = parseGitViewResult(result.value, parse);
    if (!parsed.ok) {
      setState({ busy: false, notice: parsed.text });
      return;
    }
    setState({ busy: false, uncertain: false, notice: undefined, ...apply(parsed.value) });
  }

  /** Shared tail for a CRUD action (Behaviour rule 2): on success, runs
   *  `after` (a tree/collections refresh) and clears busy; on failure,
   *  clears busy and shows the refusal — never both. */
  function finishMutation(result: RpcResult, after: () => void): void {
    if (!result.ok) {
      setState({
        busy: false,
        uncertain: isUncertain(result.error),
        notice: noticeFromError(result.error),
      });
      return;
    }
    const parsed = parseGitViewResult(result.value, (v) => (v === undefined ? true : v));
    if (!parsed.ok) {
      setState({ busy: false, notice: parsed.text });
      return;
    }
    setState({ busy: false, uncertain: false, notice: undefined });
    after();
  }

  function refreshSelectedTree(project: string): void {
    const path = state.selectedCollectionPath;
    if (path === undefined || state.project !== project) return;
    treeGeneration += 1;
    setState({ treeLoading: true });
    void loadTree(project, path, treeGeneration);
  }

  function close(): void {
    // Fix round 1 (I3): close() only detaches the live reconnect-refresh
    // subscription — it never resets `state`. A blur/refocus of the same
    // project (the screen's own useFocusEffect cleanup, then open() again
    // for that same project) must find the draft, the selection and
    // everything already read exactly as they were. Only open()-ing a
    // *different* project resets the view.
    if (visible) unsubscribeVisible();
    visible = false;
  }

  return {
    get: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    open,
    refresh,
    readTree,
    readRequest,
    setDraft,
    setVariables,
    invoke,
    close,
  };
}
