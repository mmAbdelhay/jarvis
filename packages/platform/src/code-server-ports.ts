import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";
import type { CodeServerPortStore } from "./code-server.js";

/**
 * A CodeServerPortStore kept in one small JSON file (`{ key: port }`).
 *
 * Read once, here, and held in memory; every change is written straight
 * back, to a temp file renamed into place so a crash mid-write cannot leave
 * half a file. Synchronous on purpose: the file is a few dozen bytes and is
 * written only when a root gets a port it did not have before.
 *
 * The file is a cache, never a source of truth. Missing, unreadable or
 * corrupt, the store simply starts empty, and a write that fails is
 * dropped — the cost of forgetting a port is one trust prompt and a reset
 * layout, which is exactly what happened before this existed, so neither is
 * worth failing the Editor button over.
 */
export function createCodeServerPortStore(filePath: string): CodeServerPortStore {
  const entries = load(filePath);

  return {
    get: (key) => entries.get(key),
    set(key, port) {
      entries.set(key, port);
      save(filePath, entries);
    },
    ports: () => new Set(entries.values()),
  };
}

function load(filePath: string): Map<string, number> {
  const entries = new Map<string, number>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return entries;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return entries;
  for (const [key, port] of Object.entries(parsed)) {
    if (isPort(port)) entries.set(key, port);
  }
  return entries;
}

function save(filePath: string, entries: Map<string, number>): void {
  const temp = `${filePath}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(temp, `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`);
    renameSync(temp, filePath);
  } catch {
    // A cache; see above.
  }
}

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536;
}

/** Whether `port` can be bound on loopback right now — the same address
 *  code-server binds. Something already listening there (another app, or
 *  code-server for a different root) makes it false. Freed again before
 *  returning, with the same narrow race findFreePort accepts. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}
