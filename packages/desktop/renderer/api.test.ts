// @vitest-environment jsdom
//
// The API tab's renderer half: the tree and its editing actions, the tabbed
// request editor, and the response pane. The main process's half — parsing
// .bru, issuing the request, evaluating assertions — is covered by
// bruno.test.ts, http-runner.test.ts and assertions.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceTab } from "@jarvis/core";

type Recorded = { call: string; args: unknown[] };

let calls: Recorded[];
let requestFile: Record<string, unknown>;
let sendResult: unknown;
let collections: unknown[];
let prompts: (string | null)[];
let confirmAnswer: boolean;
let historyRows: unknown[];
let cookieRows: unknown[];
let settingsValue: { proxyUrl: string; verifyCertificate: boolean; timeoutMs: number };
let pickedFiles: string[];
let jsonFile: unknown;

function tab(overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return {
    id: "tab-1",
    project: "acme",
    url: "",
    kind: "api",
    title: "acme API",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: undefined,
    ...overrides,
  };
}

const TREE = {
  collection: { name: "api", path: "/p/api" },
  root: {
    name: "api",
    path: "/p/api",
    requests: [{ name: "Health", path: "/p/api/health.bru", seq: 1, method: "GET", url: "{{base}}/health" }],
    folders: [
      {
        name: "orders",
        path: "/p/api/orders",
        requests: [
          { name: "List orders", path: "/p/api/orders/list.bru", seq: 1, method: "POST", url: "{{base}}/orders" },
        ],
        folders: [],
      },
    ],
  },
  environments: [
    {
      name: "local",
      path: "/p/api/environments/local.bru",
      variables: [{ name: "base", value: "http://localhost:8000", enabled: true, secret: false }],
    },
  ],
};

function markup(): string {
  return `
    <div id="workspace-api" hidden>
      <select id="api-collection"></select>
      <button id="api-new-request"></button>
      <button id="api-new-folder"></button>
      <button id="api-new-collection"></button>
      <button id="api-import"></button>
      <div id="api-tree"></div>
      <select id="api-method"></select>
      <input id="api-url" />
      <select id="api-environment"></select>
      <button id="api-env-edit"></button>
      <div id="api-env-panel" hidden>
        <input id="api-env-name" />
        <button id="api-env-add"></button>
        <button id="api-env-save"></button>
        <button id="api-env-close"></button>
        <div id="api-env-vars"></div>
      </div>
      <button id="api-send"></button>
      <button id="api-save"><span id="api-dirty" hidden></span></button>
      <button id="api-curl"></button>
      <div id="api-ask" hidden>
        <span id="api-ask-label"></span>
        <input id="api-ask-input" />
        <button id="api-ask-ok"></button>
        <button id="api-ask-cancel"></button>
      </div>
      <button id="api-history-toggle"></button>
      <button id="api-cookies-toggle"></button>
      <button id="api-settings-toggle"></button>
      <div id="api-side-panel" hidden>
        <div id="api-side-tabs"></div>
        <div id="api-side-body"></div>
      </div>

      <span id="api-status"></span>
      <div id="api-tabs"></div>
      <div id="api-panel"></div>
      <div id="api-response-tabs"></div>
      <div id="api-response-head"></div>
      <div id="api-response"></div>
    </div>`;
}

function harness(): void {
  document.body.innerHTML = markup();
  calls = [];
  prompts = [];
  confirmAnswer = true;
  collections = [{ name: "api", path: "/p/api" }];
  historyRows = [
    { at: 1, name: "Health", method: "GET", url: "http://h/health", status: 200, timeMs: 12, bytes: 4, bodyPreview: "{}" },
    { at: 2, name: "Bad", method: "POST", url: "http://h/x", status: 500, timeMs: 30, bytes: 9, bodyPreview: "" },
  ];
  cookieRows = [
    { name: "sid", value: "abc", domain: "h", path: "/", secure: true, httpOnly: true },
  ];
  settingsValue = { proxyUrl: "", verifyCertificate: true, timeoutMs: 30_000 };
  pickedFiles = ["/tmp/collection.json"];
  jsonFile = { ok: true, value: { info: { name: "D" } } };
  requestFile = {
    meta: { name: "Health", type: "http", seq: "1" },
    http: { method: "get", url: "{{base}}/health", body: "none", auth: "none" },
    headers: [{ name: "Accept", value: "application/json", enabled: true }],
  };
  sendResult = {
    response: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
      timeMs: 12,
      bytes: 11,
      unresolved: [],
    },
    assertions: [],
  };

  const record =
    (call: string, value: () => unknown) =>
    (...args: unknown[]) => {
      calls.push({ call, args });
      return Promise.resolve(value());
    };
  (window as unknown as { jarvis: Record<string, unknown> }).jarvis = {
    listApiCollections: record("listApiCollections", () => ({ ok: true, value: collections })),
    readApiTree: record("readApiTree", () => ({ ok: true, value: TREE })),
    readApiRequest: record("readApiRequest", () => ({ ok: true, value: structuredClone(requestFile) })),
    saveApiRequest: record("saveApiRequest", () => ({ ok: true, value: undefined })),
    sendApiRequest: record("sendApiRequest", () => ({ ok: true, value: sendResult })),
    apiCurl: record("apiCurl", () => ({ ok: true, value: "curl 'http://h'" })),
    createApiRequest: record("createApiRequest", () => ({ ok: true, value: "/p/api/New.bru" })),
    createApiFolder: record("createApiFolder", () => ({ ok: true, value: "/p/api/f" })),
    renameApiEntry: record("renameApiEntry", () => ({ ok: true, value: "/p/api/renamed.bru" })),
    deleteApiEntry: record("deleteApiEntry", () => ({ ok: true, value: undefined })),
    createApiCollection: record("createApiCollection", () => ({ ok: true, value: "/p/new" })),
    saveApiEnvironment: record("saveApiEnvironment", () => ({ ok: true, value: "/p/api/environments/local.bru" })),
    importPostmanCollection: record("importPostmanCollection", () => ({ ok: true, value: "/p/imported" })),
    apiHistory: record("apiHistory", () => ({ ok: true, value: historyRows })),
    clearApiHistory: record("clearApiHistory", () => ({ ok: true, value: undefined })),
    apiCookies: record("apiCookies", () => ({ ok: true, value: cookieRows })),
    clearApiCookies: record("clearApiCookies", () => ({ ok: true, value: [] })),
    removeApiCookie: record("removeApiCookie", () => ({ ok: true, value: [] })),
    apiSettings: record("apiSettings", () => ({ ok: true, value: settingsValue })),
    saveApiSettings: (...args: unknown[]) => {
      calls.push({ call: "saveApiSettings", args });
      settingsValue = args[1] as typeof settingsValue;
      return Promise.resolve({ ok: true, value: settingsValue });
    },
    pickFiles: record("pickFiles", () => pickedFiles),
    readJsonFile: record("readJsonFile", () => jsonFile),
  };
  // Electron has no window.prompt, so the pane asks with its own row; a test
  // answers it the way a person would.
  window.prompt = () => {
    throw new Error("prompt() is not supported");
  };
  window.confirm = () => confirmAnswer;
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: () => Promise.resolve() },
    configurable: true,
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

/** Answers the pane's inline name row, or cancels it. */
async function answerAsk(): Promise<void> {
  await settle();
  const row = document.getElementById("api-ask") as HTMLElement;
  if (row === null || row.hidden) return;
  const answer = prompts.shift() ?? null;
  const input = document.getElementById("api-ask-input") as HTMLInputElement;
  if (answer === null) {
    document.getElementById("api-ask-cancel")?.click();
  } else {
    input.value = answer;
    document.getElementById("api-ask-ok")?.click();
  }
  await settle();
}

async function load() {
  vi.resetModules();
  const module = await import("./api.js");
  module.initApi();
  return module;
}

/** Shows the pane and waits for its chain of loads. */
async function show(module: { renderApi: typeof import("./api.js").renderApi }) {
  module.renderApi([tab()], "tab-1", "acme");
  await settle();
}

/** Opens the first request in the tree. */
async function openFirst(): Promise<void> {
  document.querySelector<HTMLElement>(".api-request")?.click();
  await settle();
}

function change(element: Element): void {
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

const tabButton = (strip: string, name: string) =>
  document.querySelector<HTMLElement>(`#${strip} .api-tab[data-tab="${name}"]`);

describe("api pane", () => {
  beforeEach(() => harness());

  it("stays hidden unless an api tab for the selected project is active", async () => {
    const module = await load();

    module.renderApi([tab({ kind: "web", url: "https://x.test" })], "tab-1", "acme");
    expect(document.getElementById("workspace-api")?.hidden).toBe(true);

    module.renderApi([tab()], "tab-1", "storefront");
    expect(document.getElementById("workspace-api")?.hidden).toBe(true);
  });

  it("loads the project's collections when shown", async () => {
    const module = await load();
    await show(module);

    expect(document.getElementById("workspace-api")?.hidden).toBe(false);
    expect(calls).toContainEqual({ call: "listApiCollections", args: ["acme"] });
    expect(calls).toContainEqual({ call: "readApiTree", args: ["acme", "/p/api"] });
  });

  it("renders folders, requests and their methods", async () => {
    const module = await load();
    await show(module);

    expect([...document.querySelectorAll(".api-request-name")].map((n) => n.textContent)).toEqual([
      "Health",
      "List orders",
    ]);
    expect(document.querySelector(".api-folder")?.textContent).toContain("orders");
    expect([...document.querySelectorAll(".api-method-badge")].map((n) => n.textContent)).toEqual([
      "GET",
      "POST",
    ]);
  });

  it("says what is missing when there are no collections", async () => {
    collections = [];
    const module = await load();
    await show(module);

    expect(document.querySelector(".api-empty")?.textContent).toContain("bruno.json");
  });
});

describe("api request editor", () => {
  beforeEach(() => harness());

  it("fills the toolbar and the tabs from the request", async () => {
    const module = await load();
    await show(module);
    await openFirst();

    expect((document.getElementById("api-url") as HTMLInputElement).value).toBe("{{base}}/health");
    expect((document.getElementById("api-method") as HTMLSelectElement).value).toBe("get");
    expect([...document.querySelectorAll("#api-tabs .api-tab")].map((n) => n.textContent)).toEqual([
      "params",
      "auth",
      "headers1",
      "body",
      "assert",
      "docs",
    ]);
  });

  it("switches to the headers tab and edits a header", async () => {
    const module = await load();
    await show(module);
    await openFirst();

    tabButton("api-tabs", "headers")?.click();
    const inputs = document.querySelectorAll<HTMLInputElement>("#api-panel .api-pair input[type=text]");
    expect(inputs[0]?.value).toBe("Accept");

    inputs[1]!.value = "text/plain";
    change(inputs[1]!);
    document.getElementById("api-save")?.click();
    await settle();

    const saved = calls.find((entry) => entry.call === "saveApiRequest");
    const json = saved?.args[2] as Record<string, unknown>;
    expect((json["headers"] as Record<string, unknown>[])[0]?.["value"]).toBe("text/plain");
  });

  // A disabled row stays in the file and is skipped when sending — that is
  // what makes it different from deleting it.
  it("disables a row without removing it", async () => {
    const module = await load();
    await show(module);
    await openFirst();
    tabButton("api-tabs", "headers")?.click();

    const box = document.querySelector<HTMLInputElement>("#api-panel .api-enable")!;
    box.checked = false;
    change(box);
    document.getElementById("api-save")?.click();
    await settle();

    const json = calls.find((e) => e.call === "saveApiRequest")?.args[2] as Record<string, unknown>;
    expect((json["headers"] as Record<string, unknown>[])[0]).toMatchObject({
      name: "Accept",
      enabled: false,
    });
  });

  it("edits bearer auth on the auth tab", async () => {
    const module = await load();
    await show(module);
    await openFirst();

    tabButton("api-tabs", "auth")?.click();
    const mode = document.getElementById("api-auth-mode") as HTMLSelectElement;
    mode.value = "bearer";
    change(mode);

    const token = document.querySelector<HTMLInputElement>("#api-panel input[type=text]")!;
    token.value = "{{token}}";
    change(token);
    document.getElementById("api-save")?.click();
    await settle();

    const json = calls.find((e) => e.call === "saveApiRequest")?.args[2] as Record<string, unknown>;
    expect(json["http"]).toMatchObject({ auth: "bearer" });
    expect(json["auth"]).toEqual({ bearer: { token: "{{token}}" } });
  });

  it("edits a JSON body and formats it", async () => {
    const module = await load();
    await show(module);
    await openFirst();

    tabButton("api-tabs", "body")?.click();
    const mode = document.getElementById("api-body-mode") as HTMLSelectElement;
    mode.value = "json";
    change(mode);

    const area = document.getElementById("api-body") as HTMLTextAreaElement;
    area.value = '{"a":1}';
    change(area);
    document.getElementById("api-format")?.click();

    expect((document.getElementById("api-body") as HTMLTextAreaElement).value).toBe('{\n  "a": 1\n}');
  });

  // Reformatting is a convenience; destroying something half-typed to
  // provide it would not be one.
  it("leaves an unparseable body alone when formatting", async () => {
    const module = await load();
    await show(module);
    await openFirst();
    tabButton("api-tabs", "body")?.click();
    const mode = document.getElementById("api-body-mode") as HTMLSelectElement;
    mode.value = "json";
    change(mode);

    const area = document.getElementById("api-body") as HTMLTextAreaElement;
    area.value = '{"a":';
    change(area);
    document.getElementById("api-format")?.click();

    expect((document.getElementById("api-body") as HTMLTextAreaElement).value).toBe('{"a":');
  });

  // Pasting a URL from a log or a browser should do what the user meant.
  it("splits a pasted query string into the params tab", async () => {
    const module = await load();
    await show(module);
    await openFirst();

    const url = document.getElementById("api-url") as HTMLInputElement;
    url.value = "http://h/orders?page=2&q=abc";
    change(url);

    tabButton("api-tabs", "params")?.click();
    const inputs = [...document.querySelectorAll<HTMLInputElement>("#api-panel input[type=text]")];
    expect(inputs.map((input) => input.value)).toEqual(["page", "2", "q", "abc"]);
  });

  it("shows the params back in the URL field", async () => {
    const module = await load();
    await show(module);
    await openFirst();

    const url = document.getElementById("api-url") as HTMLInputElement;
    url.value = "http://h/orders?page=2";
    change(url);

    expect((document.getElementById("api-url") as HTMLInputElement).value).toBe("http://h/orders?page=2");
  });

  // Each row's handler used to close over the list as it was at render time,
  // so a second edit spread the original array and silently discarded the
  // first. Two edits in a row is the ordinary case.
  it("keeps both edits when two body fields are changed in a row", async () => {
    requestFile = {
      ...requestFile,
      http: { method: "post", url: "http://h", body: "formUrlEncoded", auth: "none" },
      body: {
        formUrlEncoded: [
          { name: "a", value: "1", enabled: true },
          { name: "b", value: "2", enabled: true },
        ],
      },
    };
    const module = await load();
    await show(module);
    await openFirst();
    tabButton("api-tabs", "body")?.click();

    const inputs = [...document.querySelectorAll<HTMLInputElement>("#api-panel .api-pair input[type=text]")];
    inputs[1]!.value = "one";
    change(inputs[1]!);
    inputs[3]!.value = "two";
    change(inputs[3]!);

    document.getElementById("api-save")?.click();
    await settle();

    const json = calls.find((e) => e.call === "saveApiRequest")?.args[2] as Record<string, unknown>;
    const fields = (json["body"] as Record<string, unknown>)["formUrlEncoded"] as Record<string, unknown>[];
    expect(fields.map((field) => field["value"])).toEqual(["one", "two"]);
  });

  // A value carrying & or = used to be split into two params by the display
  // and re-parse, which loses what the user typed.
  it("keeps a query value that contains & and = intact", async () => {
    const module = await load();
    await show(module);
    await openFirst();
    tabButton("api-tabs", "params")?.click();

    // Add a param by hand and give it an awkward value.
    [...document.querySelectorAll<HTMLElement>("#api-panel button")].at(-1)?.click();
    const inputs = [...document.querySelectorAll<HTMLInputElement>("#api-panel input[type=text]")];
    inputs[0]!.value = "q";
    change(inputs[0]!);
    inputs[1]!.value = "a&b=c";
    change(inputs[1]!);

    // Re-render the toolbar, which is where the URL is rebuilt from params.
    const url = document.getElementById("api-url") as HTMLInputElement;
    change(url);
    tabButton("api-tabs", "params")?.click();

    const after = [...document.querySelectorAll<HTMLInputElement>("#api-panel input[type=text]")];
    expect(after.map((input) => input.value)).toEqual(["q", "a&b=c"]);
  });

  it("enables Save only once something has changed", async () => {
    const module = await load();
    await show(module);
    await openFirst();
    expect((document.getElementById("api-save") as HTMLButtonElement).disabled).toBe(true);

    const url = document.getElementById("api-url") as HTMLInputElement;
    url.value = "http://edited.test";
    change(url);

    expect((document.getElementById("api-save") as HTMLButtonElement).disabled).toBe(false);
    expect((document.getElementById("api-dirty") as HTMLElement).hidden).toBe(false);
  });

  // The whole parsed object goes back to disk, which is what keeps scripts,
  // assertions and docs from being dropped by a save.
  it("saves fields Jarvis never edits, untouched", async () => {
    requestFile = { ...requestFile, script: { req: "console.log(1)" }, docs: "notes" };
    const module = await load();
    await show(module);
    await openFirst();

    const url = document.getElementById("api-url") as HTMLInputElement;
    url.value = "http://edited.test";
    change(url);
    document.getElementById("api-save")?.click();
    await settle();

    const json = calls.find((e) => e.call === "saveApiRequest")?.args[2] as Record<string, unknown>;
    expect(json["script"]).toEqual({ req: "console.log(1)" });
    expect(json["docs"]).toBe("notes");
  });
});

describe("api response", () => {
  beforeEach(() => harness());

  it("renders status, time, size and a pretty body", async () => {
    const module = await load();
    await show(module);
    await openFirst();

    document.getElementById("api-send")?.click();
    await settle();

    expect(document.querySelector(".api-status")?.textContent).toBe("200 OK · 12ms · 11 B");
    expect(document.querySelector(".api-response-body")?.textContent).toBe('{\n  "ok": true\n}');
  });

  it("sends with the selected environment's variables", async () => {
    const module = await load();
    await show(module);
    await openFirst();

    document.getElementById("api-send")?.click();
    await settle();

    expect(calls.find((e) => e.call === "sendApiRequest")?.args[2]).toEqual({
      base: "http://localhost:8000",
    });
  });

  it("shows the response headers on their own tab", async () => {
    const module = await load();
    await show(module);
    await openFirst();
    document.getElementById("api-send")?.click();
    await settle();

    tabButton("api-response-tabs", "headers")?.click();

    expect(document.querySelector(".api-header-name")?.textContent).toBe("content-type");
  });

  it("toggles between pretty and raw", async () => {
    const module = await load();
    await show(module);
    await openFirst();
    document.getElementById("api-send")?.click();
    await settle();

    document.getElementById("api-raw-toggle")?.click();

    expect(document.querySelector(".api-response-body")?.textContent).toBe('{"ok":true}');
  });

  it("renders a failure as a failure", async () => {
    sendResult = { response: { failed: true, detail: "ECONNREFUSED", timeMs: 3 }, assertions: [] };
    const module = await load();
    await show(module);
    await openFirst();

    document.getElementById("api-send")?.click();
    await settle();

    const status = document.querySelector(".api-status");
    expect(status?.textContent).toBe("ECONNREFUSED");
    expect(status?.classList.contains("api-status--failed")).toBe(true);
  });

  it("lists assertion results, and says what a failure actually got", async () => {
    sendResult = {
      response: { status: 500, statusText: "Error", headers: {}, body: "", timeMs: 4, bytes: 0, unresolved: [] },
      assertions: [
        { target: "res.status", expression: "eq 200", passed: false, actual: "500" },
        { target: "res.responseTime", expression: "lt 999", passed: true, actual: "4" },
      ],
    };
    const module = await load();
    await show(module);
    await openFirst();

    document.getElementById("api-send")?.click();
    await settle();

    // A response with a failing assertion lands on the tab that has
    // something to say.
    expect(document.querySelector(".api-tests-summary")?.textContent).toBe("1 of 2 passed");
    expect(document.querySelector(".api-test--failed")?.textContent).toContain("got 500");
  });

  it("names variables that had no value", async () => {
    sendResult = {
      response: { status: 200, statusText: "OK", headers: {}, body: "", timeMs: 1, bytes: 0, unresolved: ["token"] },
      assertions: [],
    };
    const module = await load();
    await show(module);
    await openFirst();

    document.getElementById("api-send")?.click();
    await settle();

    expect(document.querySelector(".api-note")?.textContent).toContain("token");
  });

  // Scripts run now, so what they printed has somewhere to go.
  it("shows what a script printed on the console tab", async () => {
    sendResult = {
      response: { status: 200, statusText: "OK", headers: {}, body: "", timeMs: 1, bytes: 0, unresolved: [] },
      assertions: [],
      scripts: { logs: ["token refreshed", "id 41"], tests: [] },
    };
    const module = await load();
    await show(module);
    await openFirst();

    document.getElementById("api-send")?.click();
    await settle();

    tabButton("api-response-tabs", "console")?.click();
    expect([...document.querySelectorAll(".api-console-line")].map((n) => n.textContent)).toEqual([
      "token refreshed",
      "id 41",
    ]);
  });

  // A post-response script that threw must not look like a quiet success.
  it("lands on the console when a script failed", async () => {
    sendResult = {
      response: { status: 200, statusText: "OK", headers: {}, body: "", timeMs: 1, bytes: 0, unresolved: [] },
      assertions: [],
      scripts: { logs: [], tests: [], error: "token is not defined" },
    };
    const module = await load();
    await show(module);
    await openFirst();

    document.getElementById("api-send")?.click();
    await settle();

    expect(document.querySelector(".api-console-error")?.textContent).toBe("token is not defined");
  });

  // Both kinds of test are tests; splitting them across two places would
  // hide half of them.
  it("counts a tests block beside the declarative assertions", async () => {
    sendResult = {
      response: { status: 200, statusText: "OK", headers: {}, body: "", timeMs: 1, bytes: 0, unresolved: [] },
      assertions: [{ target: "res.status", expression: "eq 200", passed: true, actual: "200" }],
      scripts: {
        logs: [],
        tests: [
          { name: "has an id", passed: true },
          { name: "is fast", passed: false, error: "expected 900 to be below 500" },
        ],
      },
    };
    const module = await load();
    await show(module);
    await openFirst();

    document.getElementById("api-send")?.click();
    await settle();

    expect(document.querySelector(".api-tests-summary")?.textContent).toBe("2 of 3 passed");
    expect(document.querySelector(".api-test--failed")?.textContent).toContain(
      "expected 900 to be below 500",
    );
  });
});

describe("api history, cookies and network settings", () => {
  beforeEach(() => harness());

  it("opens the history drawer and lists what was sent", async () => {
    const module = await load();
    await show(module);

    document.getElementById("api-history-toggle")?.click();
    await settle();

    expect((document.getElementById("api-side-panel") as HTMLElement).hidden).toBe(false);
    const rows = [...document.querySelectorAll(".api-history-row .api-history-url")];
    expect(rows.map((row) => row.textContent)).toEqual(["http://h/health", "http://h/x"]);
    expect(document.querySelectorAll(".api-history-status--bad")).toHaveLength(1);
  });

  // Clicking the open drawer again is the only way to get the height back.
  it("closes the drawer when its own button is clicked again", async () => {
    const module = await load();
    await show(module);

    document.getElementById("api-history-toggle")?.click();
    await settle();
    document.getElementById("api-history-toggle")?.click();

    expect((document.getElementById("api-side-panel") as HTMLElement).hidden).toBe(true);
  });

  it("clears the history", async () => {
    const module = await load();
    await show(module);
    document.getElementById("api-history-toggle")?.click();
    await settle();

    document.getElementById("api-history-clear")?.click();
    await settle();

    expect(calls.some((e) => e.call === "clearApiHistory")).toBe(true);
    expect(document.querySelector(".api-empty")?.textContent).toContain("Nothing sent");
  });

  // The flags are the reason a cookie is or is not being sent.
  it("lists cookies with their scope and flags", async () => {
    const module = await load();
    await show(module);

    document.getElementById("api-cookies-toggle")?.click();
    await settle();

    expect(document.querySelector(".api-cookie-row .mono")?.textContent).toBe("sid=abc");
    expect(document.querySelector(".api-cookie-scope")?.textContent).toBe("h/ · secure httpOnly");
  });

  it("removes one cookie and clears them all", async () => {
    const module = await load();
    await show(module);
    document.getElementById("api-cookies-toggle")?.click();
    await settle();

    document.querySelector<HTMLElement>(".api-cookie-row .api-pair-remove")?.click();
    await settle();
    expect(calls.find((e) => e.call === "removeApiCookie")?.args).toEqual(["acme", "sid", "h", "/"]);

    document.getElementById("api-cookies-clear")?.click();
    await settle();
    expect(calls.some((e) => e.call === "clearApiCookies")).toBe(true);
  });

  it("edits the proxy and the timeout", async () => {
    const module = await load();
    await show(module);
    document.getElementById("api-settings-toggle")?.click();
    await settle();

    const proxy = document.getElementById("api-setting-proxy") as HTMLInputElement;
    proxy.value = "http://proxy:8080";
    change(proxy);
    await settle();

    expect(calls.find((e) => e.call === "saveApiSettings")?.args[1]).toMatchObject({
      proxyUrl: "http://proxy:8080",
    });
  });

  // A half-typed number must not become a zero-millisecond timeout, which
  // would fail every request instantly.
  it("ignores a timeout that is not a number", async () => {
    const module = await load();
    await show(module);
    document.getElementById("api-settings-toggle")?.click();
    await settle();

    const timeout = document.getElementById("api-setting-timeout") as HTMLInputElement;
    timeout.value = "soon";
    change(timeout);
    await settle();

    expect(calls.some((e) => e.call === "saveApiSettings")).toBe(false);
  });

  it("turns certificate verification off deliberately", async () => {
    const module = await load();
    await show(module);
    document.getElementById("api-settings-toggle")?.click();
    await settle();

    const verify = document.getElementById("api-setting-verify") as HTMLInputElement;
    expect(verify.checked).toBe(true);
    verify.checked = false;
    change(verify);
    await settle();

    expect(calls.find((e) => e.call === "saveApiSettings")?.args[1]).toMatchObject({
      verifyCertificate: false,
    });
  });
});

describe("api collection editing", () => {
  beforeEach(() => harness());

  it("creates a request and opens it", async () => {
    prompts = ["Created"];
    const module = await load();
    await show(module);

    document.getElementById("api-new-request")?.click();
    await answerAsk();

    expect(calls.find((e) => e.call === "createApiRequest")?.args.slice(0, 3)).toEqual([
      "acme",
      "/p/api",
      "Created",
    ]);
  });

  // Electron throws on window.prompt, so the pane must never call it: every
  // create and rename silently did nothing until this row replaced it.
  it("asks for a name in the pane, not through window.prompt", async () => {
    prompts = ["Created"];
    const module = await load();
    await show(module);

    document.getElementById("api-new-request")?.click();
    await settle();

    expect((document.getElementById("api-ask") as HTMLElement).hidden).toBe(false);
    expect(document.getElementById("api-ask-label")?.textContent).toBe("New request");
    expect((document.getElementById("api-ask-input") as HTMLInputElement).value).toBe("New request");
  });

  it("accepts the name on Enter and hides the row", async () => {
    const module = await load();
    await show(module);
    document.getElementById("api-new-request")?.click();
    await settle();

    const input = document.getElementById("api-ask-input") as HTMLInputElement;
    input.value = "Typed";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();

    expect((document.getElementById("api-ask") as HTMLElement).hidden).toBe(true);
    expect(calls.find((e) => e.call === "createApiRequest")?.args[2]).toBe("Typed");
  });

  it("cancels on Escape without creating anything", async () => {
    const module = await load();
    await show(module);
    document.getElementById("api-new-request")?.click();
    await settle();

    document
      .getElementById("api-ask-input")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();

    expect((document.getElementById("api-ask") as HTMLElement).hidden).toBe(true);
    expect(calls.some((e) => e.call === "createApiRequest")).toBe(false);
  });

  it("does nothing when the name prompt is cancelled", async () => {
    prompts = [null];
    const module = await load();
    await show(module);

    document.getElementById("api-new-request")?.click();
    await answerAsk();

    expect(calls.some((e) => e.call === "createApiRequest")).toBe(false);
  });

  it("creates a folder and a collection", async () => {
    prompts = ["orders", "second"];
    const module = await load();
    await show(module);

    document.getElementById("api-new-folder")?.click();
    await answerAsk();
    document.getElementById("api-new-collection")?.click();
    await answerAsk();

    expect(calls.some((e) => e.call === "createApiFolder")).toBe(true);
    expect(calls.find((e) => e.call === "createApiCollection")?.args).toEqual(["acme", "second"]);
  });

  it("renames a request from its row", async () => {
    prompts = ["Renamed"];
    const module = await load();
    await show(module);

    document.querySelector<HTMLElement>(".api-request .api-entry-action")?.click();
    await answerAsk();

    expect(calls.find((e) => e.call === "renameApiEntry")?.args).toEqual([
      "acme",
      "/p/api/health.bru",
      "Renamed",
      false,
    ]);
  });

  it("deletes a request only after confirmation", async () => {
    confirmAnswer = false;
    const module = await load();
    await show(module);

    document.querySelector<HTMLElement>(".api-request .api-entry-action--del")?.click();
    await settle();
    expect(calls.some((e) => e.call === "deleteApiEntry")).toBe(false);

    confirmAnswer = true;
    document.querySelector<HTMLElement>(".api-request .api-entry-action--del")?.click();
    await settle();
    expect(calls.find((e) => e.call === "deleteApiEntry")?.args).toEqual([
      "acme",
      "/p/api/health.bru",
    ]);
  });

  it("imports a Postman collection from a file the user picks", async () => {
    const module = await load();
    await show(module);

    document.getElementById("api-import")?.click();
    await settle();

    expect(calls.some((e) => e.call === "pickFiles")).toBe(true);
    expect(calls.find((e) => e.call === "importPostmanCollection")?.args[2]).toEqual({
      info: { name: "D" },
    });
  });

  // Cancelling a picker is not a failure and must not start an import.
  it("does nothing when the file picker is cancelled", async () => {
    pickedFiles = [];
    const module = await load();
    await show(module);

    document.getElementById("api-import")?.click();
    await settle();

    expect(calls.some((e) => e.call === "importPostmanCollection")).toBe(false);
  });

  it("reports a file that could not be read as JSON", async () => {
    jsonFile = { ok: false, text: "Unexpected token", language: "en" };
    const module = await load();
    await show(module);

    document.getElementById("api-import")?.click();
    await settle();

    expect(document.getElementById("api-status")?.textContent).toBe("Unexpected token");
    expect(calls.some((e) => e.call === "importPostmanCollection")).toBe(false);
  });

  it("opens the environment editor filled from the selected environment", async () => {
    const module = await load();
    await show(module);

    document.getElementById("api-env-edit")?.click();

    expect((document.getElementById("api-env-panel") as HTMLElement).hidden).toBe(false);
    expect((document.getElementById("api-env-name") as HTMLInputElement).value).toBe("local");
    const inputs = [...document.querySelectorAll<HTMLInputElement>("#api-env-vars input[type=text]")];
    expect(inputs.map((input) => input.value)).toEqual(["base", "http://localhost:8000"]);
  });

  it("edits, adds and saves environment variables", async () => {
    const module = await load();
    await show(module);
    document.getElementById("api-env-edit")?.click();

    const value = document.querySelectorAll<HTMLInputElement>("#api-env-vars input[type=text]")[1]!;
    value.value = "http://edited";
    change(value);

    document.getElementById("api-env-add")?.click();
    const added = [...document.querySelectorAll<HTMLInputElement>("#api-env-vars input[type=text]")];
    added[2]!.value = "token";
    change(added[2]!);
    added[3]!.value = "abc";
    change(added[3]!);

    document.getElementById("api-env-save")?.click();
    await settle();

    expect(calls.find((e) => e.call === "saveApiEnvironment")?.args[3]).toEqual([
      { name: "base", value: "http://edited", enabled: true, secret: false },
      { name: "token", value: "abc", enabled: true, secret: false },
    ]);
  });

  it("marks a variable secret", async () => {
    const module = await load();
    await show(module);
    document.getElementById("api-env-edit")?.click();

    const secret = document.querySelector<HTMLInputElement>("#api-env-vars .api-secret input")!;
    secret.checked = true;
    change(secret);
    document.getElementById("api-env-save")?.click();
    await settle();

    const saved = calls.find((e) => e.call === "saveApiEnvironment")?.args[3] as Record<string, unknown>[];
    expect(saved[0]).toMatchObject({ name: "base", secret: true });
  });

  // A half-typed row is not a variable.
  it("drops a variable with no name on save", async () => {
    const module = await load();
    await show(module);
    document.getElementById("api-env-edit")?.click();
    document.getElementById("api-env-add")?.click();

    document.getElementById("api-env-save")?.click();
    await settle();

    expect(calls.find((e) => e.call === "saveApiEnvironment")?.args[3]).toHaveLength(1);
  });

  // Cancelling must leave the collection exactly as it was.
  it("discards edits when the editor is closed", async () => {
    const module = await load();
    await show(module);
    document.getElementById("api-env-edit")?.click();
    const value = document.querySelectorAll<HTMLInputElement>("#api-env-vars input[type=text]")[1]!;
    value.value = "http://edited";
    change(value);

    document.getElementById("api-env-close")?.click();
    expect((document.getElementById("api-env-panel") as HTMLElement).hidden).toBe(true);

    document.getElementById("api-env-edit")?.click();
    const reopened = [...document.querySelectorAll<HTMLInputElement>("#api-env-vars input[type=text]")];
    expect(reopened[1]?.value).toBe("http://localhost:8000");
    expect(calls.some((e) => e.call === "saveApiEnvironment")).toBe(false);
  });

  it("copies the request as a cURL command", async () => {
    const module = await load();
    await show(module);
    await openFirst();

    document.getElementById("api-curl")?.click();
    await settle();

    expect(calls.some((e) => e.call === "apiCurl")).toBe(true);
    expect(document.getElementById("api-status")?.textContent).toBe("Copied");
  });

  it("sends on Cmd+Enter and saves on Cmd+S", async () => {
    const module = await load();
    await show(module);
    await openFirst();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true }));
    await settle();
    expect(calls.some((e) => e.call === "sendApiRequest")).toBe(true);

    const url = document.getElementById("api-url") as HTMLInputElement;
    url.value = "http://edited.test";
    change(url);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true }));
    await settle();
    expect(calls.some((e) => e.call === "saveApiRequest")).toBe(true);
  });

  // The shortcuts belong to the pane, not to the window: they must not fire
  // while the user is in a terminal or the Changes view.
  it("ignores the shortcuts while the pane is hidden", async () => {
    const module = await load();
    await show(module);
    await openFirst();
    module.renderApi([tab({ kind: "web", url: "https://x.test" })], "tab-1", "acme");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true }));
    await settle();

    expect(calls.some((e) => e.call === "sendApiRequest")).toBe(false);
  });
});
