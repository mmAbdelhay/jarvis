import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCollection,
  createFolder,
  createRequest,
  deleteEntry,
  listCollections,
  readCollection,
  readRequest,
  renameFolder,
  renameRequest,
  writeEnvironment,
  writeImported,
  writeRequest,
} from "./bruno.js";

// M12 Task 7 follow-up: writeRequest/writeEnvironment's own atomic-write
// bite-proof needs a real `rename` that can be made to fail on demand,
// without breaking every other real fs call this file (and bruno.ts's own
// writers) make — `node:fs/promises` is an ESM namespace vitest cannot
// vi.spyOn directly ("Module namespace is not configurable"), so this
// mocks the whole module through to the real implementation for
// everything, with `rename` alone routed through a mutable override that
// defaults to the real `rename` and is set only for the one test that
// needs it to throw.
const renameOverride: { impl?: (...args: unknown[]) => Promise<void> } = {};
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: (...args: unknown[]) =>
      renameOverride.impl
        ? renameOverride.impl(...args)
        : actual.rename(...(args as [never, never])),
  };
});

/**
 * Whether this process may create symlinks. On macOS and Linux always; on
 * Windows only with Developer Mode or the SeCreateSymbolicLink privilege,
 * without which symlink() fails with EPERM. The tests that need one are
 * skipped rather than failed there.
 */
const canSymlink = ((): boolean => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-bruno-symlink-probe-"));
  try {
    writeFileSync(join(dir, "target"), "");
    symlinkSync(join(dir, "target"), join(dir, "link"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

const made: string[] = [];

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-bruno-"));
  made.push(dir);
  return dir;
}

async function collection(root: string, name: string): Promise<string> {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "bruno.json"),
    JSON.stringify({ version: "1", name, type: "collection" }),
  );
  return path;
}

const REQUEST = `meta {
  name: List orders
  type: http
  seq: 1
}

get {
  url: {{base}}/api/orders
  body: none
  auth: none
}

headers {
  Accept: application/json
}
`;

afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("listCollections", () => {
  it("finds a directory holding a bruno.json, named from that file", async () => {
    const root = await project();
    await collection(root, "api");

    expect(await listCollections(root)).toEqual([{ name: "api", path: join(root, "api") }]);
  });

  it("ignores a directory without one", async () => {
    const root = await project();
    await mkdir(join(root, "src"), { recursive: true });

    expect(await listCollections(root)).toEqual([]);
  });

  it("counts the project root itself when it holds one", async () => {
    const root = await project();
    await writeFile(join(root, "bruno.json"), JSON.stringify({ name: "root-collection" }));

    expect(await listCollections(root)).toContainEqual({ name: "root-collection", path: root });
  });

  // A deeper scan is slow and surprising in a monorepo; one level is the
  // contract.
  it("does not descend past one level", async () => {
    const root = await project();
    await collection(join(root, "deep"), "api");

    expect(await listCollections(root)).toEqual([]);
  });

  it("skips node_modules", async () => {
    const root = await project();
    await collection(root, "node_modules");

    expect(await listCollections(root)).toEqual([]);
  });

  it("returns nothing for a project path that does not exist", async () => {
    expect(await listCollections("/no/such/project")).toEqual([]);
  });

  it("falls back to the directory name when bruno.json names nothing", async () => {
    const root = await project();
    const path = join(root, "requests");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "bruno.json"), "{}");

    expect(await listCollections(root)).toEqual([{ name: "requests", path }]);
  });
});

describe("readCollection", () => {
  it("reads folders, requests and environments", async () => {
    const root = await project();
    const path = await collection(root, "api");
    await mkdir(join(path, "orders"), { recursive: true });
    await writeFile(join(path, "orders", "list.bru"), REQUEST);
    await mkdir(join(path, "environments"), { recursive: true });
    await writeFile(
      join(path, "environments", "local.bru"),
      "vars {\n  base: http://localhost:8000\n}\n",
    );

    const tree = await readCollection(path);

    expect(tree.collection.name).toBe("api");
    expect(tree.root.folders[0]?.name).toBe("orders");
    expect(tree.root.folders[0]?.requests[0]).toMatchObject({
      name: "List orders",
      // Uppercased for the tree, where a method is a badge beside a name.
      method: "GET",
      url: "{{base}}/api/orders",
      seq: 1,
    });
    expect(tree.environments[0]).toMatchObject({ name: "local" });
    expect(tree.environments[0]?.variables[0]).toMatchObject({
      name: "base",
      value: "http://localhost:8000",
    });
  });

  it("orders requests by seq, then by name", async () => {
    const root = await project();
    const path = await collection(root, "api");
    await writeFile(
      join(path, "b.bru"),
      REQUEST.replace("seq: 1", "seq: 2").replace("List orders", "B"),
    );
    await writeFile(join(path, "a.bru"), REQUEST.replace("List orders", "A"));
    await writeFile(
      join(path, "c.bru"),
      REQUEST.replace("seq: 1", "seq: 2").replace("List orders", "AA"),
    );

    const tree = await readCollection(path);

    expect(tree.root.requests.map((request) => request.name)).toEqual(["A", "AA", "B"]);
  });

  // One unreadable file must not cost the user the whole collection.
  it("skips a malformed .bru and keeps the rest of the tree", async () => {
    const root = await project();
    const path = await collection(root, "api");
    await writeFile(join(path, "good.bru"), REQUEST);
    await writeFile(join(path, "bad.bru"), "this is not a bru file {{{");

    const tree = await readCollection(path);

    expect(tree.root.requests.map((request) => request.name)).toEqual(["List orders"]);
  });

  // A collection's bruno.json often sits at the root of an ordinary
  // repository. Walking every directory listed src/, config/ and __pycache__
  // as though they were part of the collection.
  it("leaves out a folder that holds no requests at any depth", async () => {
    const root = await project();
    const path = await collection(root, "api");
    await mkdir(join(path, "src", "__pycache__"), { recursive: true });
    await mkdir(join(path, "docs"), { recursive: true });
    await mkdir(join(path, "orders"), { recursive: true });
    await writeFile(join(path, "orders", "list.bru"), REQUEST);

    const tree = await readCollection(path);

    expect(tree.root.folders.map((folder) => folder.name)).toEqual(["orders"]);
  });

  it("keeps a folder whose only requests are further down", async () => {
    const root = await project();
    const path = await collection(root, "api");
    await mkdir(join(path, "v1", "orders"), { recursive: true });
    await writeFile(join(path, "v1", "orders", "list.bru"), REQUEST);

    const tree = await readCollection(path);

    expect(tree.root.folders[0]?.name).toBe("v1");
    expect(tree.root.folders[0]?.folders[0]?.requests[0]?.name).toBe("List orders");
  });

  it("ignores the environments directory as a folder", async () => {
    const root = await project();
    const path = await collection(root, "api");
    await mkdir(join(path, "environments"), { recursive: true });

    const tree = await readCollection(path);

    expect(tree.root.folders).toEqual([]);
  });
});

describe("readRequest / writeRequest", () => {
  it("parses a request into its fields", async () => {
    const root = await project();
    const path = join(root, "list.bru");
    await writeFile(path, REQUEST);

    const json = await readRequest(path);

    expect(json["http"]).toMatchObject({ method: "get", url: "{{base}}/api/orders" });
  });

  // The property the whole file-format decision rests on: a request Jarvis
  // opened and saved without editing must produce no diff at all.
  it("round-trips an untouched request byte-identically", async () => {
    const root = await project();
    const path = join(root, "list.bru");
    await writeFile(path, REQUEST);

    await writeRequest(path, await readRequest(path));

    expect(await readFile(path, "utf8")).toBe(REQUEST);
  });

  // M12 Task 7 follow-up (controller ruling: wire writeAtomically into
  // every live .bru/environment write). [bite-proof: write in place — a
  // plain `writeFile(path, text)` instead of temp+rename would leave the
  // original truncated/replaced by whatever the failed write partially
  // wrote, rather than untouched]
  it("a write failing mid-way (a failing rename) leaves the original file byte-identical, with no temp file left behind", async () => {
    const root = await project();
    const path = join(root, "list.bru");
    await writeFile(path, REQUEST);

    renameOverride.impl = async () => {
      throw new Error("boom");
    };
    try {
      await expect(
        writeRequest(path, { meta: { name: "New", type: "http", seq: "1" } }),
      ).rejects.toThrow("boom");
    } finally {
      renameOverride.impl = undefined;
    }

    expect(await readFile(path, "utf8")).toBe(REQUEST);
    expect(await readdir(root)).toEqual(["list.bru"]);
  });

  it("preserves fields Jarvis does not edit", async () => {
    const root = await project();
    const path = join(root, "list.bru");
    await writeFile(path, `${REQUEST}\nassert {\n  res.status: eq 200\n}\n`);

    const json = await readRequest(path);
    await writeRequest(path, json);

    expect(await readFile(path, "utf8")).toContain("res.status: eq 200");
  });

  it("creates the parent directory of a new request", async () => {
    const root = await project();
    const path = join(root, "orders", "new.bru");

    await writeRequest(path, {
      meta: { name: "New", type: "http", seq: "1" },
      http: { method: "get", url: "http://x.test", body: "none", auth: "none" },
    });

    expect(await readFile(path, "utf8")).toContain("name: New");
  });

  // M9 Task 4 fix round, Critical 1 (review): writeRequest is the actual
  // sink desktop's remote-api.ts's `isCleanScalar` guard exists to protect
  // — @usebruno/lang's jsonToBruV2 writes every `meta` key straight into
  // the file with no quoting or escaping at all (`${key}: ${value}\n`), so
  // a `meta.name` carrying its own newline can close the `meta { ... }`
  // block and open a `script:pre-request { ... }` block of its own. This
  // documents the real exploit against the real serializer — the fixed
  // pipeline (ipc.ts's `save`/`createRequest`/`renameEntry` handlers)
  // never reaches this function with such a name in the first place,
  // because prepareRemoteApiRequest and guardedWrite both refuse one
  // containing a control character before either handler calls writeRequest
  // at all (see remote-api.test.ts and ipc.test.ts).
  it("demonstrates the real script-injection exploit a crafted meta.name produces via writeRequest/readRequest, and that an ordinary name never does", async () => {
    const root = await project();
    const hostilePath = join(root, "hostile.bru");
    const craftedName =
      'x\n}\n\nscript:pre-request {\n console.log("INJECTED")\n}\n\nmeta {\n name: y';

    // The exploit: an unguarded write of this name really does plant a
    // `script` block a later send would run (main.ts's sendApiRequest,
    // node:vm) — this is exactly why remote-api.ts's isCleanScalar exists.
    await writeRequest(hostilePath, {
      meta: { name: craftedName, type: "http", seq: "1" },
      http: { method: "get", url: "http://x.test", body: "none", auth: "none" },
    });
    const reparsedHostile = await readRequest(hostilePath);
    expect(reparsedHostile).toHaveProperty("script");
    expect((reparsedHostile as { script: { req: string } }).script.req).toContain("INJECTED");

    // The same round trip with an ordinary name — the shape every name
    // that passes isCleanScalar has — never carries a script, tests, or
    // vars block it was not given, because there is nothing in it for
    // jsonToBruV2 to misread as the start of a new block.
    const safePath = join(root, "safe.bru");
    await writeRequest(safePath, {
      meta: { name: "List orders", type: "http", seq: "1" },
      http: { method: "get", url: "http://x.test", body: "none", auth: "none" },
    });
    const reparsedSafe = await readRequest(safePath);
    expect(reparsedSafe).not.toHaveProperty("script");
    expect(reparsedSafe).not.toHaveProperty("tests");
    expect(reparsedSafe).not.toHaveProperty("vars");
  });

  // Fix round 1b (ruling): the same class of raw-write sink as meta.name,
  // for a header row's own name — jsonToBru.js's `getKeyString` only quotes
  // a name containing `:`/`"`/`{`/`}`/space, so a bare control character
  // sails through unquoted, and even a quoted name (this payload contains
  // `{`/`}`/space, so it is quoted) is written with the newline still
  // literally inside the quotes rather than escaped. Either way this must
  // never come back as a script block: the write either fails outright (the
  // file this particular payload produces does not reparse — @usebruno/lang's
  // v2 grammar does not accept a raw newline inside a quoted key) or, for a
  // payload getKeyString leaves unquoted, still must never round-trip into a
  // `script` property. remote-api.ts's `isCleanScalar` guard on every row
  // name (headers/params/formUrlEncoded/multipart/assertions,
  // remote-api.test.ts) is what keeps the real pipeline from ever handing
  // writeRequest a name shaped like this at all.
  it("never yields a script block from a header name carrying the crafted injection payload, whichever way the real serializer handles it", async () => {
    const root = await project();
    const path = join(root, "hostile-header.bru");
    const craftedName = 'x\n}\n\nscript:pre-request {\n console.log("INJECTED")\n}';

    await writeRequest(path, {
      meta: { name: "R", type: "http", seq: "1" },
      http: { method: "get", url: "http://x.test", body: "none", auth: "none" },
      headers: [{ name: craftedName, value: "v", enabled: true }],
    });

    let reparsed: Record<string, unknown> | undefined;
    try {
      reparsed = await readRequest(path);
    } catch {
      // @usebruno/lang's own grammar refusing to parse the file back is
      // itself a safe outcome here — the property under test is "never a
      // script block", and a thrown parse error carries no script block
      // either.
      reparsed = undefined;
    }
    expect(reparsed === undefined || !("script" in reparsed)).toBe(true);
  });
});

describe("collection editing", () => {
  it("creates a request that reads back as an empty GET", async () => {
    const root = await project();
    const path = await collection(root, "api");

    const file = await createRequest(path, "New request", 3);

    const json = await readRequest(file);
    expect(json["meta"]).toMatchObject({ name: "New request", seq: "3" });
    expect(json["http"]).toMatchObject({ method: "get", url: "" });
  });

  // A request is named by the user; the file it lands in is not.
  it("keeps a hostile name out of the filename", async () => {
    const root = await project();
    const path = await collection(root, "api");

    const file = await createRequest(path, "../../etc/passwd", 1);

    // The property that matters is containment: no separator survives, so
    // the file cannot land anywhere but inside the collection.
    expect(file.startsWith(`${path}${sep}`)).toBe(true);
    expect(file.slice(path.length + 1)).not.toMatch(/[\\/]/);
    expect(file).toBe(join(path, "..-..-etc-passwd.bru"));
    // The displayed name is untouched — only the filename is sanitised.
    expect((await readRequest(file))["meta"]).toMatchObject({ name: "../../etc/passwd" });
  });

  it("creates a folder", async () => {
    const root = await project();
    const path = await collection(root, "api");

    await createFolder(path, "orders");
    await createRequest(join(path, "orders"), "List", 1);

    expect((await readCollection(path)).root.folders[0]?.requests[0]?.name).toBe("List");
  });

  // Bruno shows meta.name, so renaming only the file would leave a request
  // still calling itself by its old name everywhere it is displayed.
  it("renames a request in its file and in its meta", async () => {
    const root = await project();
    const path = await collection(root, "api");
    const file = await createRequest(path, "Old", 1);

    const moved = await renameRequest(file, "New");

    expect(moved).toBe(join(path, "New.bru"));
    expect((await readRequest(moved))["meta"]).toMatchObject({ name: "New" });
  });

  it("renames a folder", async () => {
    const root = await project();
    const path = await collection(root, "api");
    await createFolder(path, "old");
    // A folder with no requests is not shown at all, so it needs one to be
    // findable in the tree afterwards.
    await createRequest(join(path, "old"), "Inside", 1);

    const moved = await renameFolder(join(path, "old"), "new");

    expect((await readCollection(path)).root.folders[0]?.path).toBe(moved);
  });

  it("deletes a request and a folder", async () => {
    const root = await project();
    const path = await collection(root, "api");
    const file = await createRequest(path, "Doomed", 1);
    await createFolder(path, "gone");

    await deleteEntry(file);
    await deleteEntry(join(path, "gone"));

    const tree = await readCollection(path);
    expect(tree.root.requests).toEqual([]);
    expect(tree.root.folders).toEqual([]);
  });

  it("creates a collection that listCollections then finds", async () => {
    const root = await project();

    const path = await createCollection(root, "orders-api");

    expect(await listCollections(root)).toContainEqual({ name: "orders-api", path });
  });

  // I3: "." and ".." are legal individual characters in safeFileName's own
  // allowlist, but as a whole name they are a directory-traversal component
  // — join(root, "..") walks up a directory.
  it("keeps an all-dot collection name from escaping the project", async () => {
    const root = await project();

    const path = await createCollection(root, "..");

    expect(path).toBe(join(root, "untitled"));
    expect(path.startsWith(`${root}${sep}`)).toBe(true);
  });

  it("keeps an all-dot folder name contained", async () => {
    const root = await project();
    const path = await collection(root, "api");

    const folder = await createFolder(path, "...");

    expect(folder).toBe(join(path, "untitled"));
  });

  // Each segment is sanitised on its own (safeFileName), so a Postman
  // folder segment of ".." lands as a plainly-named "untitled" folder
  // rather than walking up a directory — the per-write containment check
  // (assertInside, checked for every planned path before any write starts)
  // is the second, whole-tree guard behind it.
  it("keeps a Postman import with a '..' folder segment contained, not escaped", async () => {
    const root = await project();

    const path = await writeImported(root, "Imported", [
      {
        segments: ["..", "..", "Escape"],
        json: {
          meta: { name: "Escape", type: "http", seq: "1" },
          http: { method: "get", url: "http://e", body: "none", auth: "none" },
        },
      },
    ]);

    expect(path.startsWith(`${root}${sep}`)).toBe(true);
    const tree = await readCollection(path);
    // Both ".." segments became the same "untitled" folder name, nested.
    expect(tree.root.folders[0]?.name).toBe("untitled");
    expect(tree.root.folders[0]?.folders[0]?.name).toBe("untitled");
    expect(tree.root.folders[0]?.folders[0]?.requests[0]?.name).toBe("Escape");
  });

  // Minor: a pre-existing symlink inside the project pointing outside it —
  // lexical containment (assertInside) sees only the string path and would
  // approve this; the realpath-aware check (assertRealInside) must not.
  it.skipIf(!canSymlink)(
    "refuses to create a collection whose own name is a pre-existing symlink pointing outside the project",
    async () => {
      const root = await project();
      const outside = await mkdtemp(join(tmpdir(), "jarvis-bruno-outside-"));
      made.push(outside);
      // A symlink named exactly like the collection safeFileName("escape-link")
      // would produce, already sitting in the project and pointing outside it.
      await symlink(outside, join(root, "escape-link"));

      await expect(createCollection(root, "escape-link")).rejects.toThrow();
      // Nothing landed in the real, outside directory the symlink points to.
      const outsideMarker = await readFile(join(outside, "bruno.json")).catch(() => undefined);
      expect(outsideMarker).toBeUndefined();
    },
  );

  it.skipIf(!canSymlink)(
    "refuses a Postman import whose folder segment is a pre-existing symlink pointing outside the project",
    async () => {
      const root = await project();
      const outside = await mkdtemp(join(tmpdir(), "jarvis-bruno-outside-"));
      made.push(outside);
      // The collection directory (and the symlinked folder inside it) must
      // already exist to prove the escape: writeImported would otherwise
      // create a plain, real "escape-link" directory itself, never
      // reaching a symlink at all.
      const collectionPath = await collection(root, "Imported");
      await symlink(outside, join(collectionPath, "escape-link"));

      await expect(
        writeImported(root, "Imported", [
          {
            segments: ["escape-link", "Escape"],
            json: {
              meta: { name: "Escape", type: "http", seq: "1" },
              http: { method: "get", url: "http://e", body: "none", auth: "none" },
            },
          },
        ]),
      ).rejects.toThrow();

      const outsideMarker = await readFile(join(outside, "Escape.bru")).catch(() => undefined);
      expect(outsideMarker).toBeUndefined();
    },
  );

  it("writes an environment that reads back with its secrets flagged", async () => {
    const root = await project();
    const path = await collection(root, "api");

    await writeEnvironment(path, "local", [
      { name: "base", value: "http://localhost", enabled: true, secret: false },
      { name: "token", value: "abc", enabled: true, secret: true },
    ]);

    const tree = await readCollection(path);
    expect(tree.environments[0]?.name).toBe("local");
    expect(tree.environments[0]?.variables).toHaveLength(2);
    expect(tree.environments[0]?.variables[1]).toMatchObject({ name: "token", secret: true });
  });

  it("writes an imported collection as a folder tree", async () => {
    const root = await project();

    const path = await writeImported(root, "Imported", [
      {
        segments: ["Health"],
        json: {
          meta: { name: "Health", type: "http", seq: "1" },
          http: { method: "get", url: "http://h", body: "none", auth: "none" },
        },
      },
      {
        segments: ["Orders", "List"],
        json: {
          meta: { name: "List", type: "http", seq: "1" },
          http: { method: "get", url: "http://o", body: "none", auth: "none" },
        },
      },
    ]);

    const tree = await readCollection(path);
    expect(tree.root.requests.map((request) => request.name)).toEqual(["Health"]);
    expect(tree.root.folders[0]?.name).toBe("Orders");
    expect(tree.root.folders[0]?.requests[0]?.name).toBe("List");
  });
});
