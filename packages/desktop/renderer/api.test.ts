// @vitest-environment jsdom
//
// The API tab's renderer half: which requests the tree shows, what an edit
// does to the request being edited, and what the response pane says. The
// main process's half — parsing .bru, issuing the request — is covered by
// bruno.test.ts and http-runner.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceTab } from "@jarvis/core";

type Recorded = { call: string; args: unknown[] };

let calls: Recorded[];
let requestFile: Record<string, unknown>;
let sendResult: unknown;

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
          { name: "List orders", path: "/p/api/orders/list.bru", seq: 1, method: "GET", url: "{{base}}/orders" },
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

function harness(options: { collections?: unknown[] } = {}): void {
  document.body.innerHTML = `
    <div id="workspace-api" hidden>
      <select id="api-collection"></select>
      <div id="api-tree"></div>
      <select id="api-method"></select>
      <input id="api-url" />
      <select id="api-environment"></select>
      <button id="api-send"></button>
      <button id="api-save"></button>
      <div id="api-params"></div>
      <div id="api-headers"></div>
      <select id="api-body-mode"></select>
      <textarea id="api-body"></textarea>
      <div id="api-response"></div>
    </div>`;
  calls = [];
  requestFile = {
    meta: { name: "List orders", type: "http", seq: "1" },
    http: { method: "get", url: "{{base}}/orders", body: "none", auth: "none" },
    headers: [{ name: "Accept", value: "application/json", enabled: true }],
  };
  sendResult = {
    status: 200,
    statusText: "OK",
    headers: {},
    body: '{"ok":true}',
    timeMs: 12,
    bytes: 11,
    unresolved: [],
  };
  const record =
    (call: string, value: () => unknown) =>
    (...args: unknown[]) => {
      calls.push({ call, args });
      return Promise.resolve(value());
    };
  (window as unknown as { jarvis: Record<string, unknown> }).jarvis = {
    listApiCollections: record("listApiCollections", () => ({
      ok: true,
      value: options.collections ?? [{ name: "api", path: "/p/api" }],
    })),
    readApiTree: record("readApiTree", () => ({ ok: true, value: TREE })),
    readApiRequest: record("readApiRequest", () => ({ ok: true, value: requestFile })),
    saveApiRequest: record("saveApiRequest", () => ({ ok: true, value: undefined })),
    sendApiRequest: record("sendApiRequest", () => ({ ok: true, value: sendResult })),
  };
}

async function load() {
  vi.resetModules();
  const module = await import("./api.js");
  module.initApi();
  return module;
}

/** Renders the pane and lets its chain of awaited loads settle. */
async function show(module: { renderApi: typeof import("./api.js").renderApi }) {
  module.renderApi([tab()], "tab-1", "acme");
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function change(element: Element): void {
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("api pane", () => {
  beforeEach(() => harness());

  it("stays hidden unless an api tab for the selected project is active", async () => {
    const module = await load();

    module.renderApi([tab({ kind: "web", url: "https://x.test" })], "tab-1", "acme");
    expect(document.getElementById("workspace-api")?.hidden).toBe(true);

    module.renderApi([tab()], "tab-1", "storefront");
    expect(document.getElementById("workspace-api")?.hidden).toBe(true);
  });

  it("shows for its own project and loads that project's collections", async () => {
    const module = await load();

    await show(module);

    expect(document.getElementById("workspace-api")?.hidden).toBe(false);
    expect(calls).toContainEqual({ call: "listApiCollections", args: ["acme"] });
    expect(calls).toContainEqual({ call: "readApiTree", args: ["acme", "/p/api"] });
  });

  it("renders folders and requests from the tree", async () => {
    const module = await load();
    await show(module);

    const names = [...document.querySelectorAll(".api-request-name")].map((node) => node.textContent);
    expect(names).toEqual(["Health", "List orders"]);
    expect(document.querySelector(".api-folder")?.textContent).toBe("orders");
  });

  it("says what is missing when the project has no collections", async () => {
    harness({ collections: [] });
    const module = await load();

    await show(module);

    expect(document.querySelector(".api-empty")?.textContent).toContain("bruno.json");
  });

  it("fills the editor from the request that was clicked", async () => {
    const module = await load();
    await show(module);

    document.querySelectorAll<HTMLElement>(".api-request")[1]?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toContainEqual({ call: "readApiRequest", args: ["acme", "/p/api/orders/list.bru"] });
    expect((document.getElementById("api-url") as HTMLInputElement).value).toBe("{{base}}/orders");
    expect((document.getElementById("api-method") as HTMLSelectElement).value).toBe("get");
    expect(document.querySelectorAll("#api-headers .api-pair")).toHaveLength(1);
  });

  it("offers the collection's environments", async () => {
    const module = await load();
    await show(module);

    const options = [...document.querySelectorAll("#api-environment option")].map((o) => o.textContent);
    expect(options).toEqual(["(no environment)", "local"]);
  });

  it("marks a request dirty when a field is edited, and enables Save", async () => {
    const module = await load();
    await show(module);
    document.querySelector<HTMLElement>(".api-request")?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect((document.getElementById("api-save") as HTMLButtonElement).disabled).toBe(true);

    const url = document.getElementById("api-url") as HTMLInputElement;
    url.value = "http://edited.test";
    change(url);

    expect((document.getElementById("api-save") as HTMLButtonElement).disabled).toBe(false);
  });

  // The whole parsed object goes back to disk, which is what keeps scripts,
  // assertions and docs a request carries from being dropped by a save.
  it("saves the whole request, with fields Jarvis never edits intact", async () => {
    requestFile = { ...requestFile, script: { req: "console.log(1)" }, docs: "notes" };
    const module = await load();
    await show(module);
    document.querySelector<HTMLElement>(".api-request")?.click();
    await Promise.resolve();
    await Promise.resolve();

    const url = document.getElementById("api-url") as HTMLInputElement;
    url.value = "http://edited.test";
    change(url);
    document.getElementById("api-save")?.click();
    await Promise.resolve();

    const saved = calls.find((entry) => entry.call === "saveApiRequest");
    expect(saved?.args[1]).toBe("/p/api/health.bru");
    const json = saved?.args[2] as Record<string, unknown>;
    expect((json["http"] as Record<string, unknown>)["url"]).toBe("http://edited.test");
    expect(json["script"]).toEqual({ req: "console.log(1)" });
    expect(json["docs"]).toBe("notes");
  });

  it("sends with the selected environment's variables", async () => {
    const module = await load();
    await show(module);
    document.querySelector<HTMLElement>(".api-request")?.click();
    await Promise.resolve();
    await Promise.resolve();

    document.getElementById("api-send")?.click();
    await Promise.resolve();
    await Promise.resolve();

    const sent = calls.find((entry) => entry.call === "sendApiRequest");
    expect(sent?.args[2]).toEqual({ base: "http://localhost:8000" });
  });

  it("renders status, time and a pretty-printed body", async () => {
    const module = await load();
    await show(module);
    document.querySelector<HTMLElement>(".api-request")?.click();
    await Promise.resolve();
    await Promise.resolve();

    document.getElementById("api-send")?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.querySelector(".api-response-head")?.textContent).toBe("200 OK · 12ms · 11 B");
    expect(document.querySelector(".api-response-body")?.textContent).toBe('{\n  "ok": true\n}');
  });

  it("leaves a non-JSON body exactly as it came", async () => {
    sendResult = { status: 200, statusText: "OK", headers: {}, body: "<html>", timeMs: 1, bytes: 6, unresolved: [] };
    const module = await load();
    await show(module);
    document.querySelector<HTMLElement>(".api-request")?.click();
    await Promise.resolve();
    await Promise.resolve();
    document.getElementById("api-send")?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.querySelector(".api-response-body")?.textContent).toBe("<html>");
  });

  it("renders a failure as a failure, not an empty success", async () => {
    sendResult = { failed: true, detail: "ECONNREFUSED", timeMs: 3 };
    const module = await load();
    await show(module);
    document.querySelector<HTMLElement>(".api-request")?.click();
    await Promise.resolve();
    await Promise.resolve();
    document.getElementById("api-send")?.click();
    await Promise.resolve();
    await Promise.resolve();

    const head = document.querySelector(".api-response-head");
    expect(head?.textContent).toBe("ECONNREFUSED");
    expect(head?.classList.contains("api-response-head--failed")).toBe(true);
  });

  it("names variables that had no value", async () => {
    sendResult = {
      status: 200, statusText: "OK", headers: {}, body: "", timeMs: 1, bytes: 0,
      unresolved: ["token"],
    };
    const module = await load();
    await show(module);
    document.querySelector<HTMLElement>(".api-request")?.click();
    await Promise.resolve();
    await Promise.resolve();
    document.getElementById("api-send")?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.querySelector(".api-note")?.textContent).toContain("token");
  });

  // A green result on a request whose script never ran would be a lie.
  it("says so when a request carries a script that is not run here", async () => {
    requestFile = { ...requestFile, script: { req: "x" } };
    const module = await load();
    await show(module);
    document.querySelector<HTMLElement>(".api-request")?.click();
    await Promise.resolve();
    await Promise.resolve();
    document.getElementById("api-send")?.click();
    await Promise.resolve();
    await Promise.resolve();

    const notes = [...document.querySelectorAll(".api-note")].map((node) => node.textContent);
    expect(notes.some((text) => text?.includes("not run here"))).toBe(true);
  });

  it("adds and removes a header row", async () => {
    const module = await load();
    await show(module);
    document.querySelector<HTMLElement>(".api-request")?.click();
    await Promise.resolve();
    await Promise.resolve();

    [...document.querySelectorAll<HTMLElement>("#api-headers button")].at(-1)?.click();
    expect(document.querySelectorAll("#api-headers .api-pair")).toHaveLength(2);

    document.querySelector<HTMLElement>("#api-headers .api-pair-remove")?.click();
    expect(document.querySelectorAll("#api-headers .api-pair")).toHaveLength(1);
  });
});
