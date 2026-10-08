import { describe, expect, it } from "vitest";
import { parseRegistryEntry, parseRegistrySearch } from "./registry-entry.js";

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
