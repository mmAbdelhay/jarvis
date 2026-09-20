// The per-project sidecars screen's store (task-6-brief.md): Editor,
// Database and Cluster rows, built from `editor:roots [project]` and
// `cluster:names [project]`, and the `open()` call that turns a tapped row
// into a proxied URL the WebView screen can load.
//
// Ruling 12: the LAN-only state is a property of the pairing record alone
// (`record.name === undefined`), decided once, before any request — a
// record without a `name` never calls `*:open`/`*:roots`/`*:names` at all,
// so a pinned pairing can never leak a request to a phone that has no
// system-trust route to dial a sidecar's own certificate.
//
// Two layers of "ok/failure" are in play on `open()` (see task brief's
// context note): `client.call`'s own `RpcResult` (offline/timeout/
// unsupported/remote-error — the RPC round trip itself), and, nested
// inside a *successful* `RpcResult`'s `value`, the `*:open` handler's own
// domain result (`{ ok: true; value } | { ok: false; text }` — whether the
// laptop could actually open that Editor/Database/Cluster). Both are
// parsed defensively, field by field, exactly like every other server
// payload in this app (rpc-client.ts, dashboard-store.ts) — never spread
// into a typed value.

import { isAllowedSidecarUrl } from "./sidecar-url";
import type { RpcClient, RpcError, RpcResult } from "./rpc-client";

export type SidecarRow = {
  kind: "editor" | "database" | "cluster";
  // A root or cluster name; "" for the default (the one editor row shown
  // when the project has no configured roots, and the database's one row,
  // which is never named).
  label: string;
};

export type SidecarsView =
  | { mode: "lanOnly" }
  | { mode: "loading" }
  | {
      mode: "ready";
      rows: SidecarRow[];
      opening: SidecarRow | undefined;
      error: string | undefined;
    };

export type SidecarsStore = {
  view(): SidecarsView;
  subscribe(cb: () => void): () => void;
  load(): Promise<void>;
  open(row: SidecarRow): Promise<{ url: string } | undefined>;
  dismissError(): void;
};

export type SidecarsStoreDeps = {
  client: Pick<RpcClient, "call">;
  record: { name?: string; port: number };
  project: string;
};

/**
 * A generic fallback shown when an `RpcResult` failed without server text
 * to show verbatim (offline/timeout/unsupported) — an `i18n.ts`
 * `MessageKey` string (widens to `string` at this type, per the binding
 * `SidecarsView.error: string | undefined` interface), which the screen
 * resolves through `t()` when rendering; a genuine server string never
 * collides with it because no real server text is ever exactly this key.
 */
const GENERIC_LOAD_ERROR = "sidecars.loadFailed";

/**
 * Shown when `open()`'s own URL — not the RPC round trip — is the problem:
 * a URL that failed `isAllowedSidecarUrl` (task-6 review, fix round 1,
 * Minor 2). Distinct from `GENERIC_LOAD_ERROR`'s "try again" copy, which is
 * wrong advice for a refusal that will simply repeat; a malformed `*:open`
 * domain payload (an unparseable shape, rather than a bad URL) still uses
 * `GENERIC_LOAD_ERROR` — that is a parse failure, not an address one.
 */
const UNEXPECTED_ADDRESS_ERROR = "sidecars.unexpectedAddress";

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function rpcErrorText(error: RpcError): string {
  return error.kind === "remote" ? error.text : GENERIC_LOAD_ERROR;
}

/** The `*:open` handler's own domain result, nested inside a successful `RpcResult.value` — parsed field by field, never trusted as a shape. */
type OpenOutcome = { ok: true; value: unknown } | { ok: false; text: string };

function parseOpenOutcome(value: unknown): OpenOutcome | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  if (obj.ok === true) return { ok: true, value: obj.value };
  if (obj.ok === false && typeof obj.text === "string") return { ok: false, text: obj.text };
  return undefined;
}

/** editor/cluster hand back the URL string directly; database hands back `{ url }`. */
function extractUrl(kind: SidecarRow["kind"], value: unknown): string | undefined {
  if (kind === "database") {
    if (typeof value !== "object" || value === null) return undefined;
    const url = (value as Record<string, unknown>).url;
    return typeof url === "string" ? url : undefined;
  }
  return typeof value === "string" ? value : undefined;
}

function openArgs(project: string, row: SidecarRow): { channel: string; args: unknown[] } {
  switch (row.kind) {
    case "editor":
      return {
        channel: "editor:open",
        args: row.label === "" ? [project] : [project, row.label],
      };
    case "database":
      return { channel: "database:open", args: [project] };
    case "cluster":
      return { channel: "cluster:open", args: [project, row.label, true] };
  }
}

export function createSidecarsStore(deps: SidecarsStoreDeps): SidecarsStore {
  const lanOnly = deps.record.name === undefined;
  const listeners = new Set<() => void>();

  let view: SidecarsView = lanOnly ? { mode: "lanOnly" } : { mode: "loading" };

  function setView(next: SidecarsView): void {
    view = next;
    for (const listener of [...listeners]) listener();
  }

  async function load(): Promise<void> {
    if (lanOnly) return;
    setView({ mode: "loading" });

    const [rootsResult, clustersResult] = (await Promise.all([
      deps.client.call("editor:roots", [deps.project]),
      deps.client.call("cluster:names", [deps.project]),
    ])) as [RpcResult, RpcResult];

    let error: string | undefined;
    const rows: SidecarRow[] = [];

    if (rootsResult.ok) {
      const roots = parseStringArray(rootsResult.value);
      if (roots.length === 0) {
        rows.push({ kind: "editor", label: "" });
      } else {
        for (const root of roots) rows.push({ kind: "editor", label: root });
      }
    } else {
      error = rpcErrorText(rootsResult.error);
    }

    rows.push({ kind: "database", label: "" });

    if (clustersResult.ok) {
      for (const name of parseStringArray(clustersResult.value)) {
        rows.push({ kind: "cluster", label: name });
      }
    } else {
      error = error ?? rpcErrorText(clustersResult.error);
    }

    setView({ mode: "ready", rows, opening: undefined, error });
  }

  async function open(row: SidecarRow): Promise<{ url: string } | undefined> {
    if (lanOnly) return undefined;
    if (view.mode !== "ready") return undefined;

    const readyView = view;
    setView({ ...readyView, opening: row });

    const { channel, args } = openArgs(deps.project, row);
    const result = await deps.client.call(channel, args);

    // A later load()/open() may have replaced the view while this one was
    // in flight; only apply this call's outcome if it is still current.
    const current = view;
    if (current.mode !== "ready") return undefined;

    if (!result.ok) {
      setView({ ...current, opening: undefined, error: rpcErrorText(result.error) });
      return undefined;
    }

    const outcome = parseOpenOutcome(result.value);
    if (outcome === undefined) {
      setView({ ...current, opening: undefined, error: GENERIC_LOAD_ERROR });
      return undefined;
    }
    if (!outcome.ok) {
      setView({ ...current, opening: undefined, error: outcome.text });
      return undefined;
    }

    const url = extractUrl(row.kind, outcome.value);
    // `record.name` is defined here — `lanOnly` (checked above) is exactly
    // `record.name === undefined`.
    const name = deps.record.name as string;
    if (url === undefined || !isAllowedSidecarUrl(url, name, deps.record.port)) {
      // [bite-proof] dropping this check lets a URL that failed
      // isAllowedSidecarUrl (e.g. a loopback address) return normally.
      setView({ ...current, opening: undefined, error: UNEXPECTED_ADDRESS_ERROR });
      return undefined;
    }

    setView({ ...current, opening: undefined, error: undefined });
    return { url };
  }

  function dismissError(): void {
    if (view.mode === "ready") setView({ ...view, error: undefined });
  }

  return {
    view: () => view,
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    load,
    open,
    dismissError,
  };
}
