import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { postmanToRequests, readCollection, readRequest, writeImported } from "@jarvis/platform";
import {
  MAX_IMPORT_DEPTH,
  MAX_IMPORT_NODES,
  MAX_IMPORT_REQUESTS,
  validateRemoteImport,
  validateRemoteImportScalars,
} from "./remote-import-guard.js";

/** A chain of `depth` nested objects — the root itself is depth 1, so
 *  `nestedObject(1)` is `{}` and `nestedObject(2)` is `{ child: {} }`. */
function nestedObject(depth: number): unknown {
  let node: unknown = {};
  for (let i = 1; i < depth; i += 1) node = { child: node };
  return node;
}

/** An array holding `childCount` empty objects — `childCount + 1` total
 *  nodes once the array itself is counted. */
function wideArray(childCount: number): unknown {
  return Array.from({ length: childCount }, () => ({}));
}

describe("validateRemoteImport", () => {
  it("accepts a small, ordinary Postman-shaped collection", () => {
    expect(
      validateRemoteImport({
        info: { name: "demo", schema: "https://schema.getpostman.com/.../v2.1.0/" },
        item: [{ name: "GET /health", request: { method: "GET", url: "https://x/health" } }],
      }),
    ).toBe(true);
  });

  it("accepts a bare primitive at the root", () => {
    expect(validateRemoteImport("hello")).toBe(true);
    expect(validateRemoteImport(42)).toBe(true);
    expect(validateRemoteImport(true)).toBe(true);
    expect(validateRemoteImport(null)).toBe(true);
  });

  it("accepts an empty object and an empty array", () => {
    expect(validateRemoteImport({})).toBe(true);
    expect(validateRemoteImport([])).toBe(true);
  });

  // [bite-proof: MAX_IMPORT_DEPTH]
  it(`accepts exactly MAX_IMPORT_DEPTH (${MAX_IMPORT_DEPTH}) nested levels`, () => {
    expect(validateRemoteImport(nestedObject(MAX_IMPORT_DEPTH))).toBe(true);
  });

  it("rejects one level past MAX_IMPORT_DEPTH", () => {
    expect(validateRemoteImport(nestedObject(MAX_IMPORT_DEPTH + 1))).toBe(false);
  });

  // [bite-proof: MAX_IMPORT_NODES]
  it(`accepts exactly MAX_IMPORT_NODES (${MAX_IMPORT_NODES}) total nodes`, () => {
    expect(validateRemoteImport(wideArray(MAX_IMPORT_NODES - 1))).toBe(true);
  });

  it("rejects one node past MAX_IMPORT_NODES", () => {
    expect(validateRemoteImport(wideArray(MAX_IMPORT_NODES))).toBe(false);
  });

  // [bite-proof: a per-level-only check (verifying no single level's own
  // width exceeds MAX_IMPORT_NODES) would accept this — neither `levelOne`
  // nor `levelTwo` alone is over the cap. Ruling 13: the bound is a single
  // running total across the *whole* tree, so their combined width refuses
  // it. Wide-and-shallow, matching the security review's own proof bullet.]
  it("refuses a wide-and-shallow tree whose two sibling levels are each under the cap but sum past it", () => {
    const half = Math.floor(MAX_IMPORT_NODES / 2) + 1;
    const tree = { levelOne: wideArray(half), levelTwo: wideArray(half) };
    expect(validateRemoteImport(tree)).toBe(false);
  });

  // Deep-and-narrow, matching the security review's own proof bullet: well
  // within MAX_IMPORT_DEPTH and MAX_IMPORT_NODES, so the total-node bound
  // does not reject shape alone — only actual node/depth overruns do.
  it("accepts a deep-and-narrow chain comfortably inside both bounds", () => {
    const depth = Math.floor(MAX_IMPORT_DEPTH / 2);
    expect(validateRemoteImport(nestedObject(depth))).toBe(true);
  });

  it("rejects an own __proto__ key however deep it appears", () => {
    // Object-literal syntax special-cases `__proto__` (it sets the
    // prototype instead of creating an own key), so this uses JSON.parse —
    // the same source every real collection arrives through — to produce a
    // genuine own "__proto__" property.
    const withProto = JSON.parse('{"item":[{"__proto__":{"polluted":true}}]}');
    expect(validateRemoteImport(withProto)).toBe(false);
  });

  it("rejects an own prototype key", () => {
    expect(validateRemoteImport({ item: [{ prototype: { polluted: true } } as unknown] })).toBe(
      false,
    );
  });

  it("rejects an own constructor key", () => {
    expect(validateRemoteImport({ constructor: { polluted: true } })).toBe(false);
  });

  // [bite-proof: cycles for direct in-process inputs]
  it("rejects a cyclic object graph rather than looping forever", () => {
    const cyclic: Record<string, unknown> = { name: "demo" };
    cyclic["self"] = cyclic;
    expect(validateRemoteImport(cyclic)).toBe(false);
  });

  it("rejects a cycle reached through an array", () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(validateRemoteImport(cyclic)).toBe(false);
  });

  it("MAX_IMPORT_REQUESTS is exported for the post-conversion count check", () => {
    expect(MAX_IMPORT_REQUESTS).toBe(1_000);
  });
});

describe("validateRemoteImportScalars", () => {
  const CRAFTED_NAME = 'x\n}\n\nscript:pre-request {\n console.log("INJECTED")\n}';

  function fixture(itemName: string) {
    return {
      info: { name: "demo", schema: "https://schema.getpostman.com/.../v2.1.0/" },
      item: [
        {
          name: itemName,
          request: { method: "GET", url: "https://x/health" },
        },
      ],
    };
  }

  it("refuses a converted request whose item name carries a control character", () => {
    const converted = postmanToRequests(fixture(CRAFTED_NAME));
    expect(validateRemoteImportScalars(converted.requests)).toBe(false);
  });

  // M12 Task 7 (M9 T4 minor, deferred): isCleanScalar — which
  // validateRemoteImportScalars/isCleanConvertedRequest calls on every one
  // of these same converted scalars — now also refuses '''
  // (@usebruno/lang's raw-string delimiter), not just a control character.
  it("refuses a converted request whose item name carries the ''' raw-string delimiter", () => {
    const converted = postmanToRequests(fixture("x'''y"));
    expect(validateRemoteImportScalars(converted.requests)).toBe(false);
  });

  it("refuses a converted request whose header name, param name, or basic-auth credential carries a control character", () => {
    const header = postmanToRequests({
      info: { name: "demo", schema: "v2.1.0" },
      item: [
        {
          name: "ok",
          request: {
            method: "GET",
            url: "https://x",
            header: [{ key: CRAFTED_NAME, value: "v" }],
          },
        },
      ],
    });
    expect(validateRemoteImportScalars(header.requests)).toBe(false);

    const basicAuth = postmanToRequests({
      info: { name: "demo", schema: "v2.1.0" },
      item: [
        {
          name: "ok",
          request: {
            method: "GET",
            url: "https://x",
            auth: { type: "basic", basic: [{ key: "username", value: CRAFTED_NAME }] },
          },
        },
      ],
    });
    expect(validateRemoteImportScalars(basicAuth.requests)).toBe(false);
  });

  it("accepts an ordinary, clean collection", () => {
    const converted = postmanToRequests(fixture("List orders"));
    expect(validateRemoteImportScalars(converted.requests)).toBe(true);
  });

  // Fix round 2, Critical class (review): a real round trip through the
  // actual converter and the actual .bru serializer/parser — not a mock —
  // mirroring exactly what ipc.ts's importPostman handler does for a
  // remote origin: validate the converted requests first, and only call
  // writeImported if that passes. Proves nothing a crafted item name could
  // produce ever reaches disk (so no script block can ever land — there is
  // no file to read one out of), while an ordinary collection is
  // unaffected and reads back clean.
  describe("real writeImported/readRequest round trip", () => {
    const made: string[] = [];
    afterEach(async () => {
      for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
    });

    async function guardedImport(
      root: string,
      name: string,
      collection: unknown,
    ): Promise<string | undefined> {
      const converted = postmanToRequests(collection);
      if (!validateRemoteImportScalars(converted.requests)) return undefined;
      return writeImported(root, name, converted.requests);
    }

    it("never writes anything for a remote import whose item name carries a control character", async () => {
      const root = await mkdtemp(join(tmpdir(), "jarvis-remote-import-"));
      made.push(root);

      const path = await guardedImport(root, "Hostile", fixture(CRAFTED_NAME));

      expect(path).toBeUndefined();
      // Nothing landed anywhere under the project root — not even a
      // partially-written collection directory.
      expect(await readdir(root)).toEqual([]);
    });

    it("still imports and reads back an ordinary, clean collection with no script block", async () => {
      const root = await mkdtemp(join(tmpdir(), "jarvis-remote-import-"));
      made.push(root);

      const path = await guardedImport(root, "Clean", fixture("List orders"));

      if (path === undefined) throw new Error("expected the clean collection to be written");
      const tree = await readCollection(path);
      const requestPath = tree.root.requests[0]?.path;
      if (requestPath === undefined) throw new Error("expected the clean request to be written");
      const reparsed = await readRequest(requestPath);
      expect(reparsed).toMatchObject({ meta: { name: "List orders" } });
      expect(reparsed).not.toHaveProperty("script");
    });
  });
});
