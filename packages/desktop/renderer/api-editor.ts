import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";

// The API tab's request editor: the tabbed half where a request is actually
// built. Split from api.ts because the two have different jobs — this one
// knows the shape of a Bruno request and nothing about tabs, panes or the
// workspace.

export type Pair = { name?: string; value?: string; enabled?: boolean; type?: string };

/** Everything the editor needs from its owner: the request being edited, and
 *  what to do when it changes. */
export type EditorHost = {
  request(): Record<string, unknown> | undefined;
  changed(): void;
};

const $ = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing element #${id}`);
  return element;
};

export const EDITOR_TABS = ["params", "auth", "headers", "body", "assert", "docs"] as const;
export type EditorTab = (typeof EDITOR_TABS)[number];

const BODY_MODES = ["none", "json", "text", "xml", "graphql", "formUrlEncoded", "multipartForm"] as const;
const AUTH_MODES = ["none", "bearer", "basic", "apikey", "oauth2"] as const;
const OAUTH2_GRANTS = ["client_credentials", "password", "authorization_code"] as const;

/** The rows each tab edits, and which key of the request they live under. */
const PAIR_KEY: Partial<Record<EditorTab, string>> = {
  params: "params",
  headers: "headers",
  assert: "assertions",
};

let host: EditorHost;
let activeTab: EditorTab = "params";

export function initEditor(editorHost: EditorHost): void {
  host = editorHost;
  activeTab = "params";
}

export function currentTab(): EditorTab {
  return activeTab;
}

export function selectTab(tab: EditorTab): void {
  activeTab = tab;
  renderEditor();
}

function request(): Record<string, unknown> | undefined {
  return host.request();
}

function http(): Record<string, unknown> {
  const existing = request()?.["http"];
  return typeof existing === "object" && existing !== null ? (existing as Record<string, unknown>) : {};
}

function pairs(key: string): Pair[] {
  const list = request()?.[key];
  return Array.isArray(list) ? (list as Pair[]) : [];
}

function setField(key: string, value: unknown): void {
  const current = request();
  if (current === undefined) return;
  current[key] = value;
  host.changed();
}

export function setHttp(field: string, value: string): void {
  setField("http", { ...http(), [field]: value });
}

/** How many rows a tab is carrying, for the badge on its button — the thing
 *  that makes a tab worth opening or worth ignoring. */
function tabCount(tab: EditorTab): number {
  const key = PAIR_KEY[tab];
  if (key !== undefined) return pairs(key).filter((pair) => pair.enabled !== false).length;
  if (tab === "auth") return String(http()["auth"] ?? "none") === "none" ? 0 : 1;
  if (tab === "body") return String(http()["body"] ?? "none") === "none" ? 0 : 1;
  if (tab === "docs") return String(request()?.["docs"] ?? "") === "" ? 0 : 1;
  return 0;
}

export function renderEditor(): void {
  renderTabStrip();
  const panel = $("api-panel");
  panel.replaceChildren();

  if (request() === undefined) {
    panel.append(note(MESSAGES.apiNoRequest(PRIMARY_LANGUAGE)));
    return;
  }

  if (activeTab === "params" || activeTab === "headers") {
    panel.append(pairTable(PAIR_KEY[activeTab] as string, activeTab === "params" ? "query" : undefined));
    return;
  }
  if (activeTab === "assert") {
    panel.append(assertTable());
    return;
  }
  if (activeTab === "auth") {
    panel.append(authPanel());
    return;
  }
  if (activeTab === "body") {
    panel.append(bodyPanel());
    return;
  }
  panel.append(docsPanel());
}

function renderTabStrip(): void {
  const strip = $("api-tabs");
  strip.replaceChildren();
  for (const tab of EDITOR_TABS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "api-tab";
    button.classList.toggle("api-tab--on", tab === activeTab);
    button.dataset["tab"] = tab;
    button.textContent = tab;

    const count = tabCount(tab);
    if (count > 0) {
      const badge = document.createElement("span");
      badge.className = "api-tab-count";
      badge.textContent = String(count);
      button.append(badge);
    }

    button.addEventListener("click", () => selectTab(tab));
    strip.append(button);
  }
}

function note(text: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "api-empty";
  element.textContent = text;
  return element;
}

function textInput(value: string, placeholder: string, onChange: (value: string) => void): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "mono";
  input.spellcheck = false;
  input.placeholder = placeholder;
  input.value = value;
  // On change, not on input: a re-render must never steal focus mid-keystroke,
  // the same discipline Settings follows.
  input.addEventListener("change", () => onChange(input.value));
  return input;
}

/** The enable checkbox every row carries. A disabled row is kept in the file
 *  and skipped when sending — that is what makes it different from deleting
 *  it, and why Postman users reach for it. */
function enableBox(checked: boolean, onToggle: (checked: boolean) => void): HTMLInputElement {
  const box = document.createElement("input");
  box.type = "checkbox";
  box.className = "api-enable";
  box.checked = checked;
  box.addEventListener("change", () => onToggle(box.checked));
  return box;
}

function removeControl(onClick: () => void): HTMLElement {
  const remove = document.createElement("span");
  remove.className = "api-pair-remove";
  remove.textContent = "×";
  remove.setAttribute("role", "button");
  remove.addEventListener("click", onClick);
  return remove;
}

function updatePair(key: string, index: number, patch: Partial<Pair>): void {
  const list = [...pairs(key)];
  const pair = list[index];
  if (pair === undefined) return;
  list[index] = { ...pair, ...patch };
  setField(key, list);
}

function addPair(key: string, extra: Partial<Pair> = {}): void {
  setField(key, [...pairs(key), { name: "", value: "", enabled: true, ...extra }]);
  renderEditor();
}

function removePair(key: string, index: number): void {
  setField(
    key,
    pairs(key).filter((_pair, i) => i !== index),
  );
  renderEditor();
}

function pairTable(key: string, type?: string): HTMLElement {
  const table = document.createElement("div");
  table.className = "api-pairs";
  table.dataset["key"] = key;

  pairs(key).forEach((pair, index) => {
    const row = document.createElement("div");
    row.className = "api-pair";
    row.append(
      enableBox(pair.enabled !== false, (checked) => {
        updatePair(key, index, { enabled: checked });
        renderTabStrip();
      }),
      textInput(pair.name ?? "", "name", (value) => updatePair(key, index, { name: value })),
      textInput(pair.value ?? "", "value", (value) => updatePair(key, index, { value })),
      removeControl(() => removePair(key, index)),
    );
    table.append(row);
  });

  const add = document.createElement("button");
  add.type = "button";
  add.className = "settings-add";
  add.textContent = "+ add";
  add.addEventListener("click", () => addPair(key, type === undefined ? {} : { type }));
  table.append(add);
  return table;
}

/** Assertions are `target` + `operator operand`, so the row is the same shape
 *  as a header but means something different — worth its own labels. */
function assertTable(): HTMLElement {
  const table = document.createElement("div");
  table.className = "api-pairs";
  table.dataset["key"] = "assertions";

  pairs("assertions").forEach((pair, index) => {
    const row = document.createElement("div");
    row.className = "api-pair";
    row.append(
      enableBox(pair.enabled !== false, (checked) => {
        updatePair("assertions", index, { enabled: checked });
        renderTabStrip();
      }),
      textInput(pair.name ?? "", "res.status", (value) => updatePair("assertions", index, { name: value })),
      textInput(pair.value ?? "", "eq 200", (value) => updatePair("assertions", index, { value })),
      removeControl(() => removePair("assertions", index)),
    );
    table.append(row);
  });

  const add = document.createElement("button");
  add.type = "button";
  add.className = "settings-add";
  add.textContent = "+ assertion";
  add.addEventListener("click", () => addPair("assertions"));
  table.append(add);
  return table;
}

function auth(): Record<string, Record<string, string>> {
  const existing = request()?.["auth"];
  return typeof existing === "object" && existing !== null
    ? (existing as Record<string, Record<string, string>>)
    : {};
}

function setAuth(mode: string, field: string, value: string): void {
  setField("auth", { ...auth(), [mode]: { ...(auth()[mode] ?? {}), [field]: value } });
}

function authPanel(): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "api-panel-body";

  const mode = String(http()["auth"] ?? "none");
  const select = document.createElement("select");
  select.id = "api-auth-mode";
  select.className = "mono";
  for (const name of AUTH_MODES) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    select.append(option);
  }
  select.value = AUTH_MODES.includes(mode as (typeof AUTH_MODES)[number]) ? mode : "none";
  select.addEventListener("change", () => {
    setHttp("auth", select.value);
    renderEditor();
  });
  panel.append(labelled("mode", select));

  if (mode === "bearer") {
    panel.append(
      labelled(
        "token",
        textInput(auth()["bearer"]?.["token"] ?? "", "{{token}}", (value) => setAuth("bearer", "token", value)),
      ),
    );
  } else if (mode === "basic") {
    panel.append(
      labelled(
        "username",
        textInput(auth()["basic"]?.["username"] ?? "", "user", (value) => setAuth("basic", "username", value)),
      ),
      labelled(
        "password",
        textInput(auth()["basic"]?.["password"] ?? "", "{{password}}", (value) => setAuth("basic", "password", value)),
      ),
    );
  } else if (mode === "oauth2") {
    const oauth = auth()["oauth2"] ?? {};
    const grant = document.createElement("select");
    grant.id = "api-oauth-grant";
    grant.className = "mono";
    for (const name of OAUTH2_GRANTS) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      grant.append(option);
    }
    grant.value = OAUTH2_GRANTS.includes(oauth["grantType"] as (typeof OAUTH2_GRANTS)[number])
      ? (oauth["grantType"] as string)
      : "client_credentials";
    grant.addEventListener("change", () => {
      setAuth("oauth2", "grantType", grant.value);
      renderEditor();
    });
    panel.append(labelled("grant", grant));

    const field = (key: string, placeholder: string): HTMLElement =>
      labelled(
        key,
        textInput(oauth[key] ?? "", placeholder, (value) => setAuth("oauth2", key, value)),
      );

    // Only the fields the chosen grant actually uses: an authorization URL
    // means nothing to client credentials, and showing it invites filling it
    // in and wondering why nothing happens.
    if (grant.value === "authorization_code") {
      panel.append(field("authorizationUrl", "https://auth/authorize"), field("callbackUrl", "http://localhost/callback"));
    }
    panel.append(field("accessTokenUrl", "https://auth/token"));
    if (grant.value === "password") {
      panel.append(field("username", "user"), field("password", "{{password}}"));
    }
    panel.append(field("clientId", "{{clientId}}"), field("clientSecret", "{{clientSecret}}"), field("scope", "read write"));

    const placement = document.createElement("select");
    placement.id = "api-oauth-placement";
    placement.className = "mono";
    for (const name of ["body", "basic_auth_header"]) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      placement.append(option);
    }
    placement.value = oauth["credentialsPlacement"] ?? "body";
    placement.addEventListener("change", () => setAuth("oauth2", "credentialsPlacement", placement.value));
    panel.append(labelled("credentials", placement));
  } else if (mode === "apikey") {
    panel.append(
      labelled("key", textInput(auth()["apikey"]?.["key"] ?? "", "X-API-Key", (value) => setAuth("apikey", "key", value))),
      labelled("value", textInput(auth()["apikey"]?.["value"] ?? "", "{{apiKey}}", (value) => setAuth("apikey", "value", value))),
      labelled(
        "placement",
        textInput(auth()["apikey"]?.["placement"] ?? "header", "header", (value) => setAuth("apikey", "placement", value)),
      ),
    );
  }

  return panel;
}

function labelled(text: string, control: HTMLElement): HTMLElement {
  const label = document.createElement("label");
  label.className = "api-field";
  const span = document.createElement("span");
  span.className = "lbl";
  span.textContent = text;
  label.append(span, control);
  return label;
}

function bodies(): Record<string, unknown> {
  const existing = request()?.["body"];
  return typeof existing === "object" && existing !== null ? (existing as Record<string, unknown>) : {};
}

function bodyPanel(): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "api-panel-body";

  const mode = String(http()["body"] ?? "none");
  const select = document.createElement("select");
  select.id = "api-body-mode";
  select.className = "mono";
  for (const name of BODY_MODES) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    select.append(option);
  }
  select.value = BODY_MODES.includes(mode as (typeof BODY_MODES)[number]) ? mode : "none";
  select.addEventListener("change", () => {
    setHttp("body", select.value);
    renderEditor();
  });

  const head = document.createElement("div");
  head.className = "api-body-head";
  head.append(labelled("body", select));

  if (mode === "json") {
    const format = document.createElement("button");
    format.type = "button";
    format.id = "api-format";
    format.className = "settings-add";
    format.textContent = "format";
    format.addEventListener("click", () => formatJsonBody());
    head.append(format);
  }
  panel.append(head);

  if (mode === "none") return panel;

  if (mode === "graphql") {
    const graphql = (bodies()["graphql"] ?? {}) as Record<string, string>;

    const query = document.createElement("textarea");
    query.id = "api-body";
    query.className = "mono";
    query.spellcheck = false;
    query.placeholder = "query { }";
    query.value = graphql["query"] ?? "";
    query.addEventListener("change", () =>
      setField("body", { ...bodies(), graphql: { ...graphql, query: query.value } }),
    );

    const variablesLabel = document.createElement("div");
    variablesLabel.className = "lbl";
    variablesLabel.textContent = "variables";

    const variables = document.createElement("textarea");
    variables.id = "api-graphql-vars";
    variables.className = "mono";
    variables.spellcheck = false;
    variables.placeholder = "{ }";
    variables.value = graphql["variables"] ?? "";
    variables.addEventListener("change", () =>
      setField("body", { ...bodies(), graphql: { ...graphql, variables: variables.value } }),
    );

    panel.append(query, variablesLabel, variables);
    return panel;
  }

  if (mode === "formUrlEncoded" || mode === "multipartForm") {
    panel.append(bodyPairs(mode));
    return panel;
  }

  const area = document.createElement("textarea");
  area.id = "api-body";
  area.className = "mono";
  area.spellcheck = false;
  area.value = String(bodies()[mode] ?? "");
  area.addEventListener("change", () => setField("body", { ...bodies(), [mode]: area.value }));
  panel.append(area);
  return panel;
}

function bodyPairs(mode: string): HTMLElement {
  const table = document.createElement("div");
  table.className = "api-pairs";
  table.dataset["key"] = mode;
  const list = Array.isArray(bodies()[mode]) ? (bodies()[mode] as Pair[]) : [];

  const write = (next: Pair[]): void => setField("body", { ...bodies(), [mode]: next });

  list.forEach((pair, index) => {
    const row = document.createElement("div");
    row.className = "api-pair";
    const isFile = (pair as { type?: string }).type === "file";
    const value = Array.isArray(pair.value) ? (pair.value as string[]).join(", ") : (pair.value ?? "");

    const valueControl = isFile
      ? filePickerControl(value, (paths) => {
          const next = [...list];
          next[index] = { ...pair, value: paths as unknown as string };
          write(next);
          renderEditor();
        })
      : textInput(String(value), "value", (typed) => {
          const next = [...list];
          next[index] = { ...pair, value: typed };
          write(next);
        });

    row.append(
      enableBox(pair.enabled !== false, (checked) => {
        const next = [...list];
        next[index] = { ...pair, enabled: checked };
        write(next);
      }),
      textInput(pair.name ?? "", "name", (typed) => {
        const next = [...list];
        next[index] = { ...pair, name: typed };
        write(next);
      }),
      valueControl,
      removeControl(() => {
        write(list.filter((_pair, i) => i !== index));
        renderEditor();
      }),
    );
    table.append(row);
  });

  const add = document.createElement("button");
  add.type = "button";
  add.className = "settings-add";
  add.textContent = "+ field";
  add.addEventListener("click", () => {
    write([...list, { name: "", value: "", enabled: true, ...(mode === "multipartForm" ? { type: "text" } : {}) }]);
    renderEditor();
  });
  table.append(add);

  if (mode === "multipartForm") {
    const addFile = document.createElement("button");
    addFile.type = "button";
    addFile.id = "api-add-file";
    addFile.className = "settings-add";
    addFile.textContent = "+ file";
    addFile.addEventListener("click", () => {
      write([...list, { name: "", value: [] as unknown as string, enabled: true, type: "file" }]);
      renderEditor();
    });
    table.append(addFile);
  }

  return table;
}

/** A file field's value is a list of paths, chosen through the system
 *  picker — typing one by hand is how you get a request that fails at send
 *  time with a path that never existed. */
function filePickerControl(current: string, onPick: (paths: string[]) => void): HTMLElement {
  const wrapper = document.createElement("span");
  wrapper.className = "api-file-field";

  const label = document.createElement("span");
  label.className = "api-file-name mono";
  label.textContent = current === "" ? "(no file)" : current;

  const choose = document.createElement("button");
  choose.type = "button";
  choose.className = "settings-add api-file-choose";
  choose.textContent = "choose";
  choose.addEventListener("click", () => {
    void window.jarvis.pickFiles({ multiple: true }).then((paths) => {
      if (paths.length > 0) onPick(paths);
    });
  });

  wrapper.append(label, choose);
  return wrapper;
}

/** Pretty-prints the JSON body in place. Invalid JSON is left exactly as it
 *  is: reformatting is a convenience, and destroying something half-typed to
 *  provide it would not be one. */
function formatJsonBody(): void {
  const raw = String(bodies()["json"] ?? "");
  try {
    setField("body", { ...bodies(), json: JSON.stringify(JSON.parse(raw), null, 2) });
    renderEditor();
  } catch {
    // Left alone on purpose.
  }
}

function docsPanel(): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "api-panel-body";
  const area = document.createElement("textarea");
  area.id = "api-docs";
  area.className = "mono";
  area.spellcheck = false;
  area.value = String(request()?.["docs"] ?? "");
  area.addEventListener("change", () => setField("docs", area.value));
  panel.append(area);
  return panel;
}
