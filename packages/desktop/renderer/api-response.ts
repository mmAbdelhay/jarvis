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

export const RESPONSE_TABS = ["body", "headers", "tests", "console"] as const;
export type ResponseTab = (typeof RESPONSE_TABS)[number];

type ScriptTest = { name: string; passed: boolean; error?: string };

type View = {
  response: ApiResponse | ApiFailure | undefined;
  assertions: AssertionResult[];
  /** What the request's own scripts printed and asserted, when it has any. */
  scripts?: { logs: string[]; tests: ScriptTest[]; error?: string };
};

let activeTab: ResponseTab = "body";
/** Raw shows exactly the bytes that came back; pretty is a convenience that
 *  can only be offered for JSON. */
let raw = false;
let view: View = { response: undefined, assertions: [] };
/** Find in the body: kept across responses, so re-sending a request keeps
 *  the search on screen against the new body. */
let query = "";
let currentMatch = 0;

/** More matches than this and only the first are marked — a one-letter
 *  search in a 2 MB body must not build a million elements. */
export const MAX_MARKED_MATCHES = 2000;

/** Every case-insensitive occurrence of `needle` in `text`, as start
 *  offsets, at most `MAX_MARKED_MATCHES + 1` (one more says "and more"). */
export function findMatches(text: string, needle: string): number[] {
  if (needle === "") return [];
  const haystack = text.toLowerCase();
  const target = needle.toLowerCase();
  const found: number[] = [];
  let from = 0;
  while (found.length <= MAX_MARKED_MATCHES) {
    const at = haystack.indexOf(target, from);
    if (at === -1) break;
    found.push(at);
    from = at + Math.max(1, target.length);
  }
  return found;
}

export function setResponse(next: View): void {
  view = next;
  // A new response with failures is worth landing on: the tab that has
  // something to say wins over the one that was open.
  const failed =
    next.assertions.some((assertion) => !assertion.passed) ||
    (next.scripts?.tests ?? []).some((test) => !test.passed);
  if (failed) activeTab = "tests";
  else if (next.scripts?.error !== undefined) activeTab = "console";
  else if (
    activeTab === "tests" &&
    next.assertions.length === 0 &&
    (next.scripts?.tests.length ?? 0) === 0
  ) {
    activeTab = "body";
  } else if (activeTab === "console" && (next.scripts?.logs.length ?? 0) === 0) activeTab = "body";
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

  head.append(statusChip(response), responseMeta(response), copyButton(response.body));
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
  if (activeTab === "console") {
    panel.append(consoleView());
    return;
  }
  panel.append(bodyView(response.body));
}

/**
 * The status code, on its own and coloured by its class.
 *
 * It used to be the head of a single string — "200 OK · 12ms · 11 B" — with
 * one red variant for everything at 400 and above. The code is the first
 * thing anyone looks for and the class is most of what it means: a 404 is
 * the API answering, a 500 is it breaking, and a 302 is neither. Splitting
 * the chip from the timing also stops the eye having to find the number
 * inside a run of unrelated digits.
 */
function statusChip(response: ApiResponse): HTMLElement {
  const chip = document.createElement("span");
  chip.className = `api-status api-status--${statusClass(response.status)}`;
  // HTTP/2 sends no status text, so joining unconditionally would render
  // "200 ", which reads as a word gone missing.
  chip.textContent = [String(response.status), response.statusText]
    .filter((part) => part !== "")
    .join(" ");
  return chip;
}

/** 1xx and anything unrecognised fall through to "info": a chip must always
 *  get a colour, and an unknown code is not a failure to report as one. */
function statusClass(status: number): "ok" | "redirect" | "client" | "server" | "info" {
  if (status >= 200 && status < 300) return "ok";
  if (status >= 300 && status < 400) return "redirect";
  if (status >= 400 && status < 500) return "client";
  if (status >= 500) return "server";
  return "info";
}

/** How long it took and how much came back: worth having, never worth
 *  reading first, so they sit beside the chip in the muted weight. */
function responseMeta(response: ApiResponse): HTMLElement {
  const meta = document.createElement("span");
  meta.className = "api-meta mono";
  meta.textContent = `${response.timeMs}ms · ${formatBytes(response.bytes)}`;
  return meta;
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

  const allTests = [...view.assertions, ...(view.scripts?.tests ?? [])];
  const count =
    tab === "headers"
      ? Object.keys(response.headers).length
      : tab === "tests"
        ? allTests.length
        : tab === "console"
          ? (view.scripts?.logs.length ?? 0) + (view.scripts?.error === undefined ? 0 : 1)
          : 0;
  if (count > 0) {
    const badge = document.createElement("span");
    badge.className = "api-tab-count";
    // A failing test count is the one badge that has to be noticeable.
    const failed =
      (tab === "tests" && allTests.some((test) => !("passed" in test ? test.passed : true))) ||
      (tab === "console" && view.scripts?.error !== undefined);
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

  const text = raw ? body : pretty;
  const bar = document.createElement("div");
  bar.className = "api-find";
  const input = document.createElement("input");
  input.type = "search";
  input.id = "api-response-search";
  input.className = "api-find-input mono";
  input.placeholder = MESSAGES.apiFindInResponse(PRIMARY_LANGUAGE);
  input.setAttribute("aria-label", MESSAGES.apiFindInResponse(PRIMARY_LANGUAGE));
  input.value = query;
  const count = document.createElement("span");
  count.className = "api-find-count mono";
  count.dir = "ltr";
  const step = (label: string, delta: number): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "settings-add api-find-step";
    button.textContent = delta < 0 ? "↑" : "↓";
    button.setAttribute("aria-label", label);
    button.title = label;
    button.addEventListener("click", () => move(delta));
    return button;
  };
  const previous = step(MESSAGES.apiFindPrevious(PRIMARY_LANGUAGE), -1);
  const next = step(MESSAGES.apiFindNext(PRIMARY_LANGUAGE), 1);
  bar.append(input, count, previous, next);

  const pre = document.createElement("pre");
  pre.className = "api-response-body mono";

  // Redraws the body and the count in place — never the input, so typing
  // keeps its focus and caret.
  function draw(scroll: boolean): void {
    const matches = findMatches(text, query);
    const marked = matches.slice(0, MAX_MARKED_MATCHES);
    if (marked.length === 0) {
      currentMatch = 0;
      pre.textContent = text;
    } else {
      currentMatch = ((currentMatch % marked.length) + marked.length) % marked.length;
      const nodes: Node[] = [];
      let at = 0;
      marked.forEach((start, index) => {
        if (start > at) nodes.push(document.createTextNode(text.slice(at, start)));
        const mark = document.createElement("mark");
        mark.className = index === currentMatch ? "api-match api-match--current" : "api-match";
        mark.textContent = text.slice(start, start + query.length);
        nodes.push(mark);
        at = start + query.length;
      });
      nodes.push(document.createTextNode(text.slice(at)));
      pre.replaceChildren(...nodes);
      if (scroll) pre.querySelector(".api-match--current")?.scrollIntoView?.({ block: "nearest" });
    }
    const more = matches.length > MAX_MARKED_MATCHES ? "+" : "";
    count.textContent =
      query === "" ? "" : `${marked.length === 0 ? 0 : currentMatch + 1}/${marked.length}${more}`;
    previous.disabled = marked.length < 2;
    next.disabled = marked.length < 2;
  }

  function move(delta: number): void {
    currentMatch += delta;
    draw(true);
  }

  input.addEventListener("input", () => {
    query = input.value;
    currentMatch = 0;
    draw(true);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      move(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape" && input.value !== "") {
      event.preventDefault();
      input.value = "";
      query = "";
      draw(false);
    }
  });

  draw(false);
  wrapper.append(bar, pre);
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

/** Everything a script printed, plus the error that stopped it if one did.
 *  A post-response script that threw must not look like a quiet success. */
function consoleView(): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "api-console";

  if (view.scripts?.error !== undefined) {
    const error = document.createElement("div");
    error.className = "api-console-error mono";
    error.textContent = view.scripts.error;
    panel.append(error);
  }

  for (const line of view.scripts?.logs ?? []) {
    const row = document.createElement("div");
    row.className = "api-console-line mono";
    row.textContent = line;
    panel.append(row);
  }

  if (panel.children.length === 0) {
    const empty = document.createElement("div");
    empty.className = "api-empty";
    empty.textContent = MESSAGES.apiNoConsole(PRIMARY_LANGUAGE);
    panel.append(empty);
  }
  return panel;
}

function testList(): HTMLElement {
  const list = document.createElement("div");
  list.className = "api-tests";

  const scriptTests = view.scripts?.tests ?? [];
  if (view.assertions.length === 0 && scriptTests.length === 0) {
    const empty = document.createElement("div");
    empty.className = "api-empty";
    empty.textContent = MESSAGES.apiNoTests(PRIMARY_LANGUAGE);
    list.append(empty);
    return list;
  }

  const total = view.assertions.length + scriptTests.length;
  const passed =
    view.assertions.filter((assertion) => assertion.passed).length +
    scriptTests.filter((test) => test.passed).length;
  const summary = document.createElement("div");
  summary.className = "api-tests-summary";
  summary.classList.toggle("api-tests-summary--bad", passed !== total);
  summary.textContent = MESSAGES.apiTestsPassed(passed, total, PRIMARY_LANGUAGE);
  list.append(summary);

  // The tests block's own results, beside the declarative assertions: both
  // are tests, and splitting them across two places would hide half of them.
  for (const test of scriptTests) {
    const row = document.createElement("div");
    row.className = "api-test";
    row.classList.toggle("api-test--failed", !test.passed);

    const mark = document.createElement("span");
    mark.className = "api-test-mark";
    mark.textContent = test.passed ? "✓" : "✗";

    const text = document.createElement("span");
    text.className = "mono";
    text.textContent = test.error === undefined ? test.name : `${test.name} — ${test.error}`;

    row.append(mark, text);
    list.append(row);
  }

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
