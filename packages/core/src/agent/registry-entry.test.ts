import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRegistryEntry, parseRegistryList, parseRegistrySearch } from "./registry-entry.js";

/** Written by Go's TestRegistryListContract (os/go/internal/pkgtools). */
const GO_REGISTRY_LIST: unknown = JSON.parse(
  readFileSync(
    new URL("../../../../os/go/internal/pkgtools/testdata/registry-list.json", import.meta.url),
    "utf8",
  ),
);

describe("parseRegistryList (contracts §7 #8, Go registry.list)", () => {
  it("reads jarvis-pkg's real {installed, available} output", () => {
    const listed = parseRegistryList(GO_REGISTRY_LIST);
    expect(listed.available.map((e) => e.id)).toEqual(["weather", "jarvis-clock"]);
    // old-py is rebuilt from its registration (no artifact): dropped here.
    expect(listed.installed.map((e) => e.id)).toEqual(["notes"]);
    expect(parseRegistrySearch(GO_REGISTRY_LIST)).toEqual([]);
    expect(parseRegistryList(null)).toEqual({ installed: [], available: [] });
  });
});

const entry = {
  id: "jarvis-files",
  name: "Files",
  description: "Search and preview files",
  tier: "official",
  version: "1.0.0",
  artifact: { url: "https://x/files.tar.zst", sha256: "a".repeat(64), runtime: "go-static" },
  permissions: { network: false, paths: [] },
  tools: [{ name: "files.search", risk: "safe" }],
};

describe("parseRegistryEntry (contracts §3)", () => {
  it("keeps exactly the contract's fields", () => {
    expect(parseRegistryEntry({ ...entry, extra: 1 })).toEqual(entry);
  });

  it("refuses bad tiers, runtimes, hashes, risks and paths", () => {
    expect(parseRegistryEntry({ ...entry, tier: "trusted" })).toBeUndefined();
    expect(
      parseRegistryEntry({ ...entry, artifact: { ...entry.artifact, runtime: "ruby" } }),
    ).toBeUndefined();
    expect(
      parseRegistryEntry({ ...entry, artifact: { ...entry.artifact, sha256: "xyz" } }),
    ).toBeUndefined();
    expect(
      parseRegistryEntry({ ...entry, tools: [{ name: "a", risk: "password" }] }),
    ).toBeUndefined();
    expect(
      parseRegistryEntry({ ...entry, permissions: { network: false, paths: ["/etc"] } }),
    ).toBeUndefined();
  });

  it("parses registry.list results and index entries, dropping bad ones", () => {
    expect(parseRegistrySearch({ results: [entry, { id: 3 }] })).toEqual([entry]);
    expect(parseRegistrySearch({ version: 1, entries: [entry] })).toEqual([entry]);
    expect(parseRegistrySearch(null)).toEqual([]);
  });
});
