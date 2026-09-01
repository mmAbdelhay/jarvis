import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

const made: string[] = [];

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-bruno-"));
  made.push(dir);
  return dir;
}

async function collection(root: string, name: string): Promise<string> {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "bruno.json"), JSON.stringify({ version: "1", name, type: "collection" }));
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
    await writeFile(join(path, "b.bru"), REQUEST.replace("seq: 1", "seq: 2").replace("List orders", "B"));
    await writeFile(join(path, "a.bru"), REQUEST.replace("List orders", "A"));
    await writeFile(join(path, "c.bru"), REQUEST.replace("seq: 1", "seq: 2").replace("List orders", "AA"));

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
    expect(file.startsWith(`${path}/`)).toBe(true);
    expect(file.slice(path.length + 1)).not.toContain("/");
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
      { segments: ["Health"], json: { meta: { name: "Health", type: "http", seq: "1" }, http: { method: "get", url: "http://h", body: "none", auth: "none" } } },
      { segments: ["Orders", "List"], json: { meta: { name: "List", type: "http", seq: "1" }, http: { method: "get", url: "http://o", body: "none", auth: "none" } } },
    ]);

    const tree = await readCollection(path);
    expect(tree.root.requests.map((request) => request.name)).toEqual(["Health"]);
    expect(tree.root.folders[0]?.name).toBe("Orders");
    expect(tree.root.folders[0]?.requests[0]?.name).toBe("List");
  });
});
