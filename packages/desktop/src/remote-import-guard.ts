import { isCleanScalar } from "./remote-api.js";

// Bounds a JSON value before it is ever handed to postman-import.ts's
// conversion (M9 Task 3, spec "workspace"). Two independent things this
// guards against, both cheap for a well-formed collection and expensive (or
// dangerous) for a hostile one:
//
//   - a prototype-pollution key (`__proto__`, `prototype`, `constructor`)
//     anywhere in the tree — postman-import.ts's own toBruno() rebuilds its
//     output field by field and never assigns through an attacker-chosen
//     key, so this is defence in depth, not the only thing standing between
//     a crafted collection and Object.prototype;
//   - unbounded shape — depth and total node count here; the number of
//     requests a collection expands to is checked separately by the caller
//     (ipc.ts's importPostman, after postmanToRequests has run) since that
//     count only exists once the collection has been walked.
//
// So a deeply nested or enormous JSON document can never make
// api:importPostman do O(depth) recursion or O(nodes) work before any of
// the ordinary project/symlink containment checks even run.
//
// `validateRemoteImport` is iterative, not recursive: a stack of pending
// nodes rather than a call per nesting level, so pathological depth is a
// bounded loop here rather than a real call-stack overflow before this
// function even gets to reject it. `seen` also makes a cyclic object graph
// (never producible by `JSON.parse`, but reachable if a caller ever hands
// this a live in-process value) terminate rather than loop forever — a
// shared-but-acyclic reference is treated the same as a cycle, a deliberate
// over-approximation: this function returns a plain boolean, so refusing a
// harmless shared reference costs nothing a caller cannot work around by
// not sharing it, while missing a real cycle would hang the import.

/** Nesting depth a remote import may reach — the root value is depth 1, so a
 *  root object holding an array holding an object is depth 3. */
export const MAX_IMPORT_DEPTH = 32;

/** Total object/array nodes (not primitives) a remote import may contain,
 *  across the *whole* tree (ruling 13) — `nodes` below is a single counter
 *  incremented once per node visited by the iterative walk below,
 *  regardless of which branch or nesting level it is under, and never reset
 *  or scoped per level. M9's own deferred minor described this as a
 *  "product limit" (depth × width); it is not one — a wide-and-shallow tree
 *  and a deep-and-narrow one are both bounded by the identical running
 *  total, confirmed by remote-import-guard.test.ts's wide-two-level and
 *  deep-narrow-chain cases (M12 Task 7). */
export const MAX_IMPORT_NODES = 5_000;

/** The most `ImportedRequest`s a remote api:importPostman call may write —
 *  checked by the caller against postmanToRequests's own output, once
 *  conversion has actually counted them. */
export const MAX_IMPORT_REQUESTS = 1_000;

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

type StackItem = { readonly value: unknown; readonly depth: number };

/**
 * True only if `value` is shallow/small/clean enough to convert: every
 * object or array node within {@link MAX_IMPORT_DEPTH} of the root, no more
 * than {@link MAX_IMPORT_NODES} such nodes in total, no own key named
 * `__proto__`/`prototype`/`constructor` anywhere, and no cycle (including a
 * merely-shared, non-cyclic reference — see the file comment for why that
 * over-approximation is deliberate).
 *
 * A primitive at the root (a bare string, number, `null`…) always passes —
 * it holds nothing to bound — leaving `postmanToRequests`'s own shape checks
 * to reject it for not looking like a collection at all.
 */
export function validateRemoteImport(value: unknown): boolean {
  const seen = new Set<object>();
  let nodes = 0;
  const stack: StackItem[] = [{ value, depth: 1 }];

  while (stack.length > 0) {
    // `stack.length > 0` just proved this pop cannot be undefined.
    const { value: node, depth } = stack.pop() as StackItem;

    if (node === null || typeof node !== "object") continue;

    if (depth > MAX_IMPORT_DEPTH) return false;
    if (seen.has(node)) return false;
    seen.add(node);

    nodes += 1;
    if (nodes > MAX_IMPORT_NODES) return false;

    if (Array.isArray(node)) {
      for (const child of node) stack.push({ value: child, depth: depth + 1 });
      continue;
    }

    // `Object.keys`, not `for...in`: own enumerable string keys only, never
    // one inherited off a prototype.
    for (const key of Object.keys(node)) {
      if (DANGEROUS_KEYS.has(key)) return false;
      stack.push({ value: (node as Record<string, unknown>)[key], depth: depth + 1 });
    }
  }

  return true;
}

// Fix round 2, Critical class (review): validateRemoteImport bounds the raw
// Postman JSON's shape (depth/nodes/dangerous keys) before conversion, but
// says nothing about what postmanToRequests's own output *contains* — an
// `item.name`, a header/param/formUrlEncoded key, or a basic-auth
// username/password copied straight from the collection into the exact
// same raw meta.name/row-name/auth-scalar sinks remote-api.ts's
// `isCleanScalar` guards for api:send/api:save (postman-import.ts:57,80 →
// bruno.ts's writeRequest → @usebruno/lang's jsonToBruV2). A remote import
// never went through prepareRemoteApiRequest at all, so none of that
// applied here. This is the same check, applied to the converted requests
// instead — called by ipc.ts's importPostman only for a remote origin,
// after postmanToRequests has run and before anything is written; a
// desktop import is unbounded and unchecked, same as before this fix.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** True only if every row in `value` (a params/headers/formUrlEncoded
 *  array, or anything else, in which case there is nothing to check) has a
 *  clean-scalar `name` — the same field @usebruno/lang writes via
 *  getKeyString for every one of these collections. A row missing a string
 *  `name` at all is not this function's business: postman-import.ts always
 *  writes one (`header.key ?? ""`), so an absent name here is not a shape
 *  this converter's own output ever takes. */
function hasCleanRowNames(value: unknown): boolean {
  if (!Array.isArray(value)) return true;
  return value.every((row) => {
    if (!isPlainObject(row)) return true;
    const name = row["name"];
    return !isString(name) || isCleanScalar(name);
  });
}

/** True only if every scalar postman-import.ts's `toBruno` ever writes into
 *  one of jsonToBruV2's raw or getKeyString sinks is clean: `meta.name`,
 *  `http.method`, every params/headers/formUrlEncoded row's `name`, and
 *  `auth.bearer.token`/`auth.basic.username`/`auth.basic.password` — the
 *  identical set remote-api.ts's `prepareRemoteApiRequest` guards, since
 *  this converter's output is shaped exactly like a `.bru` request's JSON. */
function isCleanConvertedRequest(json: Record<string, unknown>): boolean {
  const meta = isPlainObject(json["meta"]) ? json["meta"] : {};
  if (isString(meta["name"]) && !isCleanScalar(meta["name"])) return false;

  const http = isPlainObject(json["http"]) ? json["http"] : {};
  if (isString(http["method"]) && !isCleanScalar(http["method"])) return false;

  if (!hasCleanRowNames(json["params"])) return false;
  if (!hasCleanRowNames(json["headers"])) return false;

  const body = isPlainObject(json["body"]) ? json["body"] : {};
  if (!hasCleanRowNames(body["formUrlEncoded"])) return false;

  const auth = isPlainObject(json["auth"]) ? json["auth"] : {};
  const bearer = isPlainObject(auth["bearer"]) ? auth["bearer"] : undefined;
  if (bearer !== undefined && isString(bearer["token"]) && !isCleanScalar(bearer["token"])) {
    return false;
  }
  const basic = isPlainObject(auth["basic"]) ? auth["basic"] : undefined;
  if (basic !== undefined) {
    const username = basic["username"];
    const password = basic["password"];
    if (isString(username) && !isCleanScalar(username)) return false;
    if (isString(password) && !isCleanScalar(password)) return false;
  }

  return true;
}

/**
 * True only if every converted request's own path segments (the item/
 * folder names Postman gave them — bruno.ts's `writeImported` runs each
 * one through `safeFileName` before it becomes a path, but this function
 * refuses the whole import on the first control character rather than
 * silently mutating a name the way `safeFileName` does for a path
 * component) and every scalar `isCleanConvertedRequest` checks are free of
 * control characters. Ruling (fix round 2): refuse the whole import rather
 * than mutate or drop the offending request — the same "reject the whole
 * thing, never silently change it" discipline `prepareRemoteApiRequest`
 * already applies.
 */
export function validateRemoteImportScalars(requests: readonly unknown[]): boolean {
  for (const request of requests) {
    // ipc.ts's ApiHandlerDeps deliberately types postmanToRequests's own
    // output as `readonly unknown[]` (the same reasoning as its
    // `writeImported`'s `readonly never[]`) — this function checks the
    // shape for itself rather than trusting it, and refuses anything that
    // does not look like an ImportedRequest at all.
    if (!isPlainObject(request)) return false;
    const segments = request["segments"];
    const json = request["json"];
    if (!Array.isArray(segments) || !segments.every(isString)) return false;
    if (!isPlainObject(json)) return false;
    if (segments.some((segment) => !isCleanScalar(segment))) return false;
    if (!isCleanConvertedRequest(json)) return false;
  }
  return true;
}
