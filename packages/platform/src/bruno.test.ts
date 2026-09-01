import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listCollections, readCollection, readRequest, writeRequest } from "./bruno.js";

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
