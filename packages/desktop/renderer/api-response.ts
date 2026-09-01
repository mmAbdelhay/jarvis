import type { ApiFailure, ApiResponse, AssertionResult } from "@jarvis/platform";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";

// The API tab's response half: what came back, and what it means.
//
// Three tabs, because Postman's users reach for all three and the first
// version of this pane had only one: the body, the headers that came with it,
// and the assertions that were checked against it.

const $ = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing element #${id}`);
  return element;
};

export const RESPONSE_TABS = ["body", "headers", "tests"] as const;
export type ResponseTab = (typeof RESPONSE_TABS)[number];

type View = { response: ApiResponse | ApiFailure | undefined; assertions: AssertionResult[]; hasScript: boolean };

let activeTab: ResponseTab = "body";
/** Raw shows exactly the bytes that came back; pretty is a convenience that
 *  can only be offered for JSON. */
let raw = false;
let view: View = { response: undefined, assertions: [], hasScript: false };

export function setResponse(next: View): void {
  view = next;
  // A new response with failures is worth landing on: the tab that has
  // something to say wins over the one that was open.
  if (next.assertions.some((assertion) => !assertion.passed)) activeTab = "tests";
  else if (activeTab === "tests" && next.assertions.length === 0) activeTab = "body";
  renderResponse();
}

export function selectResponseTab(tab: ResponseTab): void {
  activeTab = tab;
  renderResponse();
}

export function renderResponse(): void {
  const head = $("api-response-head");
  const strip = $("api-response-tabs");
  const panel = $("api-response");
  head.replaceChildren();
  strip.replaceChildren();
  panel.replaceChildren();

  const response = view.response;
  if (response === undefined) return;

  if ("failed" in response) {
    const failure = document.createElement("span");
    failure.className = "api-status api-status--failed";
    failure.textContent = response.detail;
    head.append(failure);
    return;
  }

  head.append(statusBadge(response), copyButton(response.body));
  if (view.hasScript) head.append(scriptNote());
  if (response.unresolved.length > 0) head.append(unresolvedNote(response.unresolved));

  for (const tab of RESPONSE_TABS) strip.append(tabButton(tab, response));

  if (activeTab === "headers") {
    panel.append(headerTable(response.headers));
    return;
  }
  if (activeTab === "tests") {
    panel.append(testList());
    return;
  }
  panel.append(bodyView(response.body));
}

function statusBadge(response: ApiResponse): HTMLElement {
  const badge = document.createElement("span");
  badge.className = "api-status";
  badge.classList.toggle("api-status--bad", response.status >= 400);
  // HTTP/2 sends no status text, so joining unconditionally would render
  // "200  · 12ms", which reads as a word gone missing.
  const status = [String(response.status), response.statusText].filter((part) => part !== "").join(" ");
  badge.textContent = `${status} · ${response.timeMs}ms · ${formatBytes(response.bytes)}`;
  return badge;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function copyButton(body: string): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.id = "api-copy-response";
  button.className = "settings-add";
  button.textContent = "copy";
  button.addEventListener("click", () => {
    void navigator.clipboard?.writeText(body);
    button.textContent = MESSAGES.apiCopied(PRIMARY_LANGUAGE);
  });
  return button;
}

function scriptNote(): HTMLElement {
  const note = document.createElement("span");
  note.className = "api-note";
  note.textContent = MESSAGES.apiScriptsNotRun(PRIMARY_LANGUAGE);
  return note;
}

function unresolvedNote(names: string[]): HTMLElement {
  const note = document.createElement("span");
  note.className = "api-note";
  note.textContent = MESSAGES.apiUnresolved(names.join(", "), PRIMARY_LANGUAGE);
  return note;
}

function tabButton(tab: ResponseTab, response: ApiResponse): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "api-tab";
  button.classList.toggle("api-tab--on", tab === activeTab);
  button.dataset["tab"] = tab;
  button.textContent = tab;

  const count =
    tab === "headers"
      ? Object.keys(response.headers).length
      : tab === "tests"
        ? view.assertions.length
        : 0;
  if (count > 0) {
    const badge = document.createElement("span");
    badge.className = "api-tab-count";
    // A failing test count is the one badge that has to be noticeable.
    const failed = tab === "tests" && view.assertions.some((assertion) => !assertion.passed);
    badge.classList.toggle("api-tab-count--bad", failed);
    badge.textContent = String(count);
    button.append(badge);
  }

  button.addEventListener("click", () => selectResponseTab(tab));
  return button;
}

function bodyView(body: string): HTMLElement {
  const wrapper = document.createElement("div");

  const pretty = prettify(body);
  if (pretty !== body) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.id = "api-raw-toggle";
    toggle.className = "settings-add";
    toggle.textContent = raw ? "pretty" : "raw";
    toggle.addEventListener("click", () => {
      raw = !raw;
      renderResponse();
    });
    wrapper.append(toggle);
  }

  const pre = document.createElement("pre");
  pre.className = "api-response-body mono";
  pre.textContent = raw ? body : pretty;
  wrapper.append(pre);
  return wrapper;
}

function headerTable(headers: Record<string, string>): HTMLElement {
  const table = document.createElement("div");
  table.className = "api-header-table";
  for (const [name, value] of Object.entries(headers)) {
    const row = document.createElement("div");
    row.className = "api-header-row";
    const key = document.createElement("span");
    key.className = "api-header-name mono";
    key.textContent = name;
    const val = document.createElement("span");
    val.className = "mono";
    val.textContent = value;
    row.append(key, val);
    table.append(row);
  }
  return table;
}

function testList(): HTMLElement {
  const list = document.createElement("div");
  list.className = "api-tests";

  if (view.assertions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "api-empty";
    empty.textContent = MESSAGES.apiNoTests(PRIMARY_LANGUAGE);
    list.append(empty);
    return list;
  }

  const passed = view.assertions.filter((assertion) => assertion.passed).length;
  const summary = document.createElement("div");
  summary.className = "api-tests-summary";
  summary.classList.toggle("api-tests-summary--bad", passed !== view.assertions.length);
  summary.textContent = MESSAGES.apiTestsPassed(passed, view.assertions.length, PRIMARY_LANGUAGE);
  list.append(summary);

  for (const assertion of view.assertions) {
    const row = document.createElement("div");
    row.className = "api-test";
    row.classList.toggle("api-test--failed", !assertion.passed);

    const mark = document.createElement("span");
    mark.className = "api-test-mark";
    mark.textContent = assertion.passed ? "✓" : "✗";

    const text = document.createElement("span");
    text.className = "mono";
    // A failure has to say what it actually got, or it sends the reader back
    // to the request to guess.
    text.textContent = assertion.passed
      ? `${assertion.target} ${assertion.expression}`
      : `${assertion.target} ${assertion.expression} — got ${assertion.actual}`;

    row.append(mark, text);
    list.append(row);
  }

  return list;
}

/** Pretty-prints JSON, and leaves everything else exactly as it came. */
function prettify(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}
