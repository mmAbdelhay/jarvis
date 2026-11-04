import { describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodeServerPortStore, isPortFree } from "./code-server-ports.js";

async function tempFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "code-server-ports-")), "nested", "ports.json");
}

describe("createCodeServerPortStore", () => {
  it("knows nothing when the file does not exist", async () => {
    const store = createCodeServerPortStore(await tempFile());

    expect(store.get("a")).toBeUndefined();
    expect(store.ports()).toEqual(new Set());
  });

  it("keeps a port across a restart, by writing it to the file", async () => {
    const file = await tempFile();
    createCodeServerPortStore(file).set("/p/acme\u0000/p/acme", 40100);

    const reopened = createCodeServerPortStore(file);

    expect(reopened.get("/p/acme\u0000/p/acme")).toBe(40100);
    expect(reopened.ports()).toEqual(new Set([40100]));
  });

  // The file is only a cache: losing it costs one trust prompt, so a corrupt
  // one starts empty rather than breaking the Editor button.
  it("starts empty from a corrupt file, and drops entries that are not ports", async () => {
    const file = await tempFile();
    createCodeServerPortStore(file).set("x", 1);
    await writeFile(file, "{not json");
    expect(createCodeServerPortStore(file).get("x")).toBeUndefined();

    await writeFile(
      file,
      JSON.stringify({ good: 40100, text: "40100", zero: 0, big: 70000, frac: 1.5 }),
    );
    const store = createCodeServerPortStore(file);

    expect(store.ports()).toEqual(new Set([40100]));
  });

  it("does not throw when the file cannot be written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "code-server-ports-"));
    await writeFile(join(dir, "blocker"), "");
    // A directory path whose parent is a file: every write fails.
    const store = createCodeServerPortStore(join(dir, "blocker", "ports.json"));

    expect(() => store.set("a", 40100)).not.toThrow();
    expect(store.get("a")).toBe(40100);
  });

  it("writes plain JSON", async () => {
    const file = await tempFile();
    createCodeServerPortStore(file).set("a", 40100);

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ a: 40100 });
  });
});

describe("isPortFree", () => {
  it("is true for a port nothing is listening on, and false once something is", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");

    expect(await isPortFree(address.port)).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await isPortFree(address.port)).toBe(true);
  });
});
