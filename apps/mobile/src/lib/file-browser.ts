// The phone's file browser, read through `terminal:listDir` with paths
// relative to the pane's project root — the phone never learns the
// laptop's absolute paths. Parsed field by field; folders first, then by
// name.
import type { RpcClient } from "./rpc-client";

export type DirEntry = { name: string; directory: boolean };

const MAX_ENTRIES = 2000;

export function parseDirEntries(value: unknown): DirEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: DirEntry[] = [];
  for (const item of value.slice(0, MAX_ENTRIES)) {
    if (typeof item !== "object" || item === null) continue;
    const { name, directory } = item as Record<string, unknown>;
    // A name is one path segment: anything with a separator is not one.
    if (typeof name !== "string" || name === "" || /[/\\\0]/.test(name)) continue;
    if (name === "." || name === "..") continue;
    if (typeof directory !== "boolean") continue;
    entries.push({ name, directory });
  }
  return entries.sort((a, b) =>
    a.directory !== b.directory ? (a.directory ? -1 : 1) : a.name.localeCompare(b.name),
  );
}

/** `parent/name`, or `name` at the root. */
export function childPath(parent: string, name: string): string {
  return parent === "" ? name : `${parent}/${name}`;
}

/** The breadcrumb's steps: each segment with the path up to it. */
export function crumbs(path: string): { name: string; path: string }[] {
  const steps: { name: string; path: string }[] = [];
  let walked = "";
  for (const name of path.split("/").filter((part) => part !== "")) {
    walked = childPath(walked, name);
    steps.push({ name, path: walked });
  }
  return steps;
}

/**
 * A path as typed into a shell: left bare when it is plain, otherwise in
 * single quotes with any quote inside escaped — so a name with a space
 * or a `$` arrives as the name, never as shell syntax.
 */
export function shellQuote(path: string): string {
  if (/^[\w./@%+=:,-]+$/.test(path)) return path;
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

export async function listDir(
  client: Pick<RpcClient, "call">,
  paneKey: string,
  path: string,
): Promise<DirEntry[] | undefined> {
  const result = await client.call("terminal:listDir", [paneKey, path], { whenNotOpen: "reject" });
  return result.ok ? parseDirEntries(result.value) : undefined;
}
