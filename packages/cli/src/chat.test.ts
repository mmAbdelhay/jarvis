import { describe, expect, it } from "vitest";
import { ask, chat, describeOutcome, exitCode } from "./chat.js";
import { type TestDaemon, testDaemons } from "./testing/daemon.js";
import { FakeTerminal } from "./testing/fake-terminal.js";

const daemons = testDaemons();

function replying(d: () => TestDaemon, reason = "done", providers: unknown[] = []) {
  return (channel: string) => {
    if (channel === "provider:list")
      return { providers, activeId: null, allowCloudFallback: false };
    if (channel !== "agent:prompt") return null;
    setTimeout(() => {
      d().server.push("agent:events", { type: "text", turnId: "t1", delta: "Hi." });
      d().server.push("agent:events", { type: "turn-end", turnId: "t1", reason, error: "boom" });
    }, 5);
    return { turnId: "t1" };
  };
}

describe("chat", () => {
  it("runs one turn per line, hints at setup, and leaves at end of input", async () => {
    let d: TestDaemon | undefined;
    d = await daemons.start(replying(() => d as TestDaemon));
    const term = new FakeTerminal({ lines: ["hello", "   "] });
    expect(await chat(await daemons.connect(d), term)).toBe(0);
    expect(d.requests.filter((r) => r.channel === "agent:prompt")).toHaveLength(1);
    expect(term.output).toContain("No model provider yet. Run: jarvis setup");
    expect(term.output).toContain("Hi.");
  });

  it("leaves on /quit without sending it", async () => {
    let d: TestDaemon | undefined;
    d = await daemons.start(replying(() => d as TestDaemon, "done", [{ id: "local" }]));
    const term = new FakeTerminal({ lines: ["/quit"] });
    expect(await chat(await daemons.connect(d), term)).toBe(0);
    expect(d.requests.some((r) => r.channel === "agent:prompt")).toBe(false);
    expect(term.output).not.toContain("jarvis setup");
  });
});

describe("ask", () => {
  it("exits 0 on done and 1 on an error turn", async () => {
    let d: TestDaemon | undefined;
    d = await daemons.start(replying(() => d as TestDaemon));
    expect(await ask(await daemons.connect(d), new FakeTerminal(), "hi")).toBe(0);
    let e: TestDaemon | undefined;
    e = await daemons.start(replying(() => e as TestDaemon, "error"));
    const term = new FakeTerminal();
    expect(await ask(await daemons.connect(e), term, "hi")).toBe(1);
    expect(term.output).toContain("Something went wrong: boom");
  });
});

describe("outcomes", () => {
  it("map to text and exit codes", () => {
    expect(describeOutcome({ reason: "done" })).toBe("");
    expect(describeOutcome({ reason: "stopped" })).toBe("Stopped.\n");
    expect(exitCode({ reason: "done" })).toBe(0);
    expect(exitCode({ reason: "stopped" })).toBe(130);
    expect(exitCode({ reason: "disconnected" })).toBe(1);
    expect(describeOutcome({ reason: "refused", error: "busy\u001b[2K" })).toBe(
      "Jarvis couldn't take that message: busy\n",
    );
  });
});
