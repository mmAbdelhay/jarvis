import { describe, expect, it } from "vitest";
import { formatMemory, memoryCommand, parseMemoryItems } from "./memory.js";
import { type TestDaemon, testDaemons } from "./testing/daemon.js";
import { FakeTerminal } from "./testing/fake-terminal.js";

const daemons = testDaemons();
const items = [
  { id: "m2", kind: "fact", text: "prefers Flatpak\u001b[2K", createdAt: 1_760_000_000_000 },
  { id: "m1", kind: "summary", text: "Installed GIMP and VLC.", createdAt: 1_759_000_000_000 },
];

describe("memory items", () => {
  it("keep only well-formed items, newest first as sent", () => {
    const parsed = parseMemoryItems([
      ...items,
      { id: "", kind: "fact", text: "x", createdAt: 1 },
      { id: "m3", kind: "secret", text: "x", createdAt: 1 },
      { id: "m4", kind: "fact", text: 5, createdAt: 1 },
      "junk",
    ]);
    expect(parsed.map((item) => item.id)).toEqual(["m2", "m1"]);
    expect(parseMemoryItems(null)).toEqual([]);
  });

  it("format as date, kind and inert text", () => {
    const line = formatMemory({
      id: "m2",
      kind: "fact",
      text: "prefers Flatpak\u001b[2K",
      createdAt: 1_760_000_000_000,
    });
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} {2}fact {5}prefers Flatpak$/);
  });
});

describe("jarvis memory", () => {
  it("lists what Jarvis remembers", async () => {
    const d: TestDaemon = await daemons.start((channel) =>
      channel === "memory:list" ? items : null,
    );
    const term = new FakeTerminal();
    expect(await memoryCommand(await daemons.connect(d), term, "list", false)).toBe(0);
    expect(d.requests[0]).toEqual({ channel: "memory:list", args: [{ limit: 100 }] });
    expect(term.output).toContain("prefers Flatpak");
    expect(term.output).toContain("Installed GIMP and VLC.");
    expect(term.output).not.toContain("\u001b");
  });

  it("says so when there is nothing", async () => {
    const d: TestDaemon = await daemons.start(() => []);
    const term = new FakeTerminal();
    await memoryCommand(await daemons.connect(d), term, "list", false);
    expect(term.output).toBe("Jarvis hasn't remembered anything yet.\n");
  });

  it("clears only after a yes, or with --yes", async () => {
    const d: TestDaemon = await daemons.start(() => null);
    const client = await daemons.connect(d);
    const no = new FakeTerminal({ lines: ["n"] });
    expect(await memoryCommand(client, no, "clear", false)).toBe(0);
    expect(d.requests.some((r) => r.channel === "memory:clear")).toBe(false);
    const yes = new FakeTerminal({ lines: ["y"] });
    expect(await memoryCommand(client, yes, "clear", false)).toBe(0);
    expect(
      await memoryCommand(client, new FakeTerminal({ interactive: false }), "clear", true),
    ).toBe(0);
    expect(d.requests.filter((r) => r.channel === "memory:clear")).toHaveLength(2);
  });

  it("asks for --yes when there is no terminal", async () => {
    const d: TestDaemon = await daemons.start(() => null);
    const term = new FakeTerminal({ interactive: false });
    expect(await memoryCommand(await daemons.connect(d), term, "clear", false)).toBe(2);
    expect(term.output).toContain("jarvis memory clear --yes");
  });
});
