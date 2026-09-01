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
      <button id="api-send"></button>
      <button id="api-save"><span id="api-dirty" hidden></span></button>
      <button id="api-curl"></button>
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
  };
  window.prompt = () => prompts.shift() ?? null;
  window.confirm = () => confirmAnswer;
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: () => Promise.resolve() },
    configurable: true,
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
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

  it("names unresolved variables and a script it did not run", async () => {
    requestFile = { ...requestFile, script: { req: "x" } };
    sendResult = {
      response: { status: 200, statusText: "OK", headers: {}, body: "", timeMs: 1, bytes: 0, unresolved: ["token"] },
      assertions: [],
    };
    const module = await load();
    await show(module);
    await openFirst();

    document.getElementById("api-send")?.click();
    await settle();

    const notes = [...document.querySelectorAll(".api-note")].map((n) => n.textContent).join(" ");
    expect(notes).toContain("token");
    expect(notes).toContain("not run here");
  });
});

describe("api collection editing", () => {
  beforeEach(() => harness());

  it("creates a request and opens it", async () => {
    prompts = ["Created"];
    const module = await load();
    await show(module);

    document.getElementById("api-new-request")?.click();
    await settle();

    expect(calls.find((e) => e.call === "createApiRequest")?.args.slice(0, 3)).toEqual([
      "acme",
      "/p/api",
      "Created",
    ]);
  });

  it("does nothing when the name prompt is cancelled", async () => {
    prompts = [null];
    const module = await load();
    await show(module);

    document.getElementById("api-new-request")?.click();
    await settle();

    expect(calls.some((e) => e.call === "createApiRequest")).toBe(false);
  });

  it("creates a folder and a collection", async () => {
    prompts = ["orders", "second"];
    const module = await load();
    await show(module);

    document.getElementById("api-new-folder")?.click();
    await settle();
    document.getElementById("api-new-collection")?.click();
    await settle();

    expect(calls.some((e) => e.call === "createApiFolder")).toBe(true);
    expect(calls.find((e) => e.call === "createApiCollection")?.args).toEqual(["acme", "second"]);
  });

  it("renames a request from its row", async () => {
    prompts = ["Renamed"];
    const module = await load();
    await show(module);

    document.querySelector<HTMLElement>(".api-request .api-entry-action")?.click();
    await settle();

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

  it("imports a pasted Postman collection", async () => {
    prompts = ['{"info":{"name":"D"}}'];
    const module = await load();
    await show(module);

    document.getElementById("api-import")?.click();
    await settle();

    expect(calls.find((e) => e.call === "importPostmanCollection")?.args[2]).toEqual({
      info: { name: "D" },
    });
  });

  it("says so when the pasted import is not JSON", async () => {
    prompts = ["not json"];
    const module = await load();
    await show(module);

    document.getElementById("api-import")?.click();
    await settle();

    expect(document.getElementById("api-status")?.textContent).toContain("JSON");
    expect(calls.some((e) => e.call === "importPostmanCollection")).toBe(false);
  });

  it("edits the selected environment as name=value lines", async () => {
    prompts = ["base=http://edited\ntoken=abc"];
    const module = await load();
    await show(module);

    document.getElementById("api-env-edit")?.click();
    await settle();

    expect(calls.find((e) => e.call === "saveApiEnvironment")?.args[3]).toEqual([
      { name: "base", value: "http://edited", enabled: true, secret: false },
      { name: "token", value: "abc", enabled: true, secret: false },
    ]);
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
