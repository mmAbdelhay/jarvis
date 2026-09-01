import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import lang from "@usebruno/lang";

// Bruno collections, read and written where they live: in the project's own
// repository, as the .bru files Bruno desktop and `bru run` already use.
//
// @usebruno/lang is called from this module and nowhere else, so the
// dependency has exactly one seam. Its round-trip fidelity is what the whole
// file-format decision rests on — see the byte-identical test in
// bruno.test.ts, which is the one to look at if a version bump ever breaks
// something here.
const { bruToJsonV2, jsonToBruV2, bruToEnvJsonV2 } = lang;

export type BrunoCollection = { name: string; path: string };

export type BrunoRequestFile = {
  name: string;
  path: string;
  seq: number;
  method: string;
  url: string;
};

export type BrunoFolder = {
  name: string;
  path: string;
  requests: BrunoRequestFile[];
  folders: BrunoFolder[];
};

export type BrunoVariable = { name: string; value: string; enabled: boolean; secret: boolean };

export type BrunoEnvironment = { name: string; path: string; variables: BrunoVariable[] };

export type BrunoTree = {
  collection: BrunoCollection;
  root: BrunoFolder;
  environments: BrunoEnvironment[];
};

/** Bruno's own marker for "this directory is a collection". */
const MARKER = "bruno.json";

/** Environments are a collection's own directory, not a folder of requests. */
const ENVIRONMENTS_DIR = "environments";

const SKIPPED = new Set(["node_modules", ".git"]);

/**
 * Finds the project's collections: any directory holding a `bruno.json`,
 * plus the project root itself if it holds one.
 *
 * One level deep on purpose. A deeper scan of a monorepo — and every project
 * in this config is one — is slow and surprising, and a collection buried
 * three directories down is better named explicitly than discovered.
 */
export async function listCollections(projectPath: string): Promise<BrunoCollection[]> {
  const found: BrunoCollection[] = [];

  const own = await collectionAt(projectPath);
  if (own !== undefined) found.push(own);

  let entries;
  try {
    entries = await readdir(projectPath, { withFileTypes: true });
  } catch {
    // A project path that does not exist is not an error here: the Workspace
    // shows an empty state, and the config is where a wrong path is reported.
    return found;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || SKIPPED.has(entry.name) || entry.name.startsWith(".")) continue;
    const child = await collectionAt(join(projectPath, entry.name));
    if (child !== undefined) found.push(child);
  }

  return found;
}

async function collectionAt(path: string): Promise<BrunoCollection | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(path, MARKER), "utf8");
  } catch {
    return undefined;
  }
  let name = basename(path);
  try {
    const parsed = JSON.parse(raw) as { name?: unknown };
    if (typeof parsed.name === "string" && parsed.name !== "") name = parsed.name;
  } catch {
    // A malformed bruno.json still marks a collection; only its name is lost.
  }
  return { name, path };
}

/** Reads a whole collection: its folder tree, its requests' headline fields,
 *  and its environments. Request bodies are read on demand by readRequest —
 *  a tree is drawn from names, not from every file's contents. */
export async function readCollection(collectionPath: string): Promise<BrunoTree> {
  const collection = (await collectionAt(collectionPath)) ?? {
    name: basename(collectionPath),
    path: collectionPath,
  };
  return {
    collection,
    root: await readFolder(collectionPath, collection.name, true),
    environments: await readEnvironments(join(collectionPath, ENVIRONMENTS_DIR)),
  };
}

async function readFolder(path: string, name: string, isRoot = false): Promise<BrunoFolder> {
  const folder: BrunoFolder = { name, path, requests: [], folders: [] };

  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return folder;
  }

  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED.has(entry.name) || entry.name.startsWith(".")) continue;
      // The environments directory belongs to the collection, not to the
      // request tree; showing it as a folder of "requests" would be a lie.
      if (isRoot && entry.name === ENVIRONMENTS_DIR) continue;
      folder.folders.push(await readFolder(child, entry.name));
      continue;
    }
    if (!entry.name.endsWith(".bru")) continue;
    const request = await readRequestFile(child);
    if (request !== undefined) folder.requests.push(request);
  }

  // Bruno orders by `seq`; ties fall back to the name so the tree is stable
  // rather than dependent on readdir's order.
  folder.requests.sort((a, b) => a.seq - b.seq || a.name.localeCompare(b.name));
  folder.folders.sort((a, b) => a.name.localeCompare(b.name));
  return folder;
}

async function readRequestFile(path: string): Promise<BrunoRequestFile | undefined> {
  let json: Record<string, unknown>;
  try {
    json = await readRequest(path);
  } catch {
    // One unreadable file must not cost the user the whole collection.
    return undefined;
  }
  const meta = (json["meta"] ?? {}) as { name?: string; seq?: string };
  const http = (json["http"] ?? {}) as { method?: string; url?: string };
  const seq = Number(meta.seq);
  return {
    name: meta.name ?? basename(path, ".bru"),
    path,
    seq: Number.isFinite(seq) ? seq : Number.MAX_SAFE_INTEGER,
    method: (http.method ?? "get").toUpperCase(),
    url: http.url ?? "",
  };
}

async function readEnvironments(path: string): Promise<BrunoEnvironment[]> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }

  const environments: BrunoEnvironment[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".bru")) continue;
    const file = join(path, entry.name);
    try {
      const parsed = bruToEnvJsonV2(await readFile(file, "utf8")) as {
        variables?: BrunoVariable[];
      };
      environments.push({
        name: basename(entry.name, ".bru"),
        path: file,
        variables: parsed.variables ?? [],
      });
    } catch {
      // Same reasoning as a malformed request: skip it, keep the rest.
    }
  }
  return environments.sort((a, b) => a.name.localeCompare(b.name));
}

/** Parses one .bru file. The only reader of the format. */
export async function readRequest(path: string): Promise<Record<string, unknown>> {
  return bruToJsonV2(await readFile(path, "utf8")) as Record<string, unknown>;
}

/** Serialises one request back to .bru. The only writer of the format —
 *  and the reason an untouched request produces no diff. */
export async function writeRequest(path: string, json: Record<string, unknown>): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, jsonToBruV2(json), "utf8");
}
