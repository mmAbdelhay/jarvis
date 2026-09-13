import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import lang from "@usebruno/lang";
import type { ImportedRequest } from "./postman-import.js";

// Bruno collections, read and written where they live: in the project's own
// repository, as the .bru files Bruno desktop and `bru run` already use.
//
// @usebruno/lang is called from this module and nowhere else, so the
// dependency has exactly one seam. Its round-trip fidelity is what the whole
// file-format decision rests on — see the byte-identical test in
// bruno.test.ts, which is the one to look at if a version bump ever breaks
// something here.
const { bruToJsonV2, jsonToBruV2, bruToEnvJsonV2, envJsonToBruV2 } = lang;

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
  // A collection's bruno.json often sits at the root of an ordinary
  // repository, so a plain walk of its directories lists src/, config/,
  // __pycache__ and every other folder in the project as though they were
  // part of the collection. A folder belongs in the tree only if there is a
  // request somewhere inside it.
  folder.folders = folder.folders.filter(hasRequests).sort((a, b) => a.name.localeCompare(b.name));
  return folder;
}

function hasRequests(folder: BrunoFolder): boolean {
  return folder.requests.length > 0 || folder.folders.some(hasRequests);
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

/** A filename that cannot escape its directory or collide with the shell.
 *  A request is named by the user; the file it lands in is not. */
function safeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9 ._-]/g, "-").trim();
  return cleaned === "" ? "untitled" : cleaned;
}

/** Creates an empty GET request in `folderPath`, and returns its path. */
export async function createRequest(
  folderPath: string,
  name: string,
  seq: number,
): Promise<string> {
  const path = join(folderPath, `${safeFileName(name)}.bru`);
  await writeRequest(path, {
    meta: { name, type: "http", seq: String(seq) },
    http: { method: "get", url: "", body: "none", auth: "none" },
  });
  return path;
}

export async function createFolder(parentPath: string, name: string): Promise<string> {
  const path = join(parentPath, safeFileName(name));
  await mkdir(path, { recursive: true });
  return path;
}

/**
 * Renames a request. The file moves *and* the `meta.name` inside it changes:
 * Bruno shows the meta name, so renaming only the file would leave a request
 * that still calls itself by its old name everywhere it is displayed.
 */
export async function renameRequest(path: string, name: string): Promise<string> {
  const json = await readRequest(path);
  const meta = (json["meta"] ?? {}) as Record<string, unknown>;
  json["meta"] = { ...meta, name };

  const target = join(dirname(path), `${safeFileName(name)}.bru`);
  await writeRequest(path, json);
  if (target !== path) await rename(path, target);
  return target;
}

export async function renameFolder(path: string, name: string): Promise<string> {
  const target = join(dirname(path), safeFileName(name));
  if (target !== path) await rename(path, target);
  return target;
}

/** Removes a request or a folder. Recursive for a folder, since a collection
 *  folder is only ever the requests inside it. */
export async function deleteEntry(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/** Creates a collection directory with the bruno.json that marks it, so it
 *  is discoverable by listCollections and openable by Bruno desktop. */
export async function createCollection(projectPath: string, name: string): Promise<string> {
  const path = join(projectPath, safeFileName(name));
  await mkdir(join(path, ENVIRONMENTS_DIR), { recursive: true });
  await writeFile(
    join(path, MARKER),
    `${JSON.stringify({ version: "1", name, type: "collection" }, null, 2)}\n`,
    "utf8",
  );
  return path;
}

/** Writes one environment file. Variables marked secret keep their flag and
 *  their value here — this is the file the user chose to store them in; what
 *  Jarvis never does is move a secret into a request. */
export async function writeEnvironment(
  collectionPath: string,
  name: string,
  variables: BrunoVariable[],
): Promise<string> {
  const path = join(collectionPath, ENVIRONMENTS_DIR, `${safeFileName(name)}.bru`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, envJsonToBruV2({ variables }), "utf8");
  return path;
}

/** Writes an imported collection to disk, creating a folder per path segment
 *  so a Postman folder tree arrives as a folder tree. */
export async function writeImported(
  projectPath: string,
  name: string,
  requests: readonly ImportedRequest[],
): Promise<string> {
  const collectionPath = await createCollection(projectPath, name);

  let seq = 1;
  for (const request of requests) {
    const segments = [...request.segments];
    const fileName = segments.pop() ?? `request-${seq}`;
    const folder = segments.reduce(
      (path, segment) => join(path, safeFileName(segment)),
      collectionPath,
    );
    await mkdir(folder, { recursive: true });

    const json = { ...request.json };
    const meta = (json["meta"] ?? {}) as Record<string, unknown>;
    json["meta"] = { ...meta, seq: String(seq) };
    await writeRequest(join(folder, `${safeFileName(fileName)}.bru`), json);
    seq += 1;
  }

  return collectionPath;
}
