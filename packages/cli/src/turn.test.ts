import { describe, expect, it, vi } from "vitest";
import { ControlRequestError } from "../../desktop/src/daemon/control/messages.js";
import { makeCard } from "./testing/cards.js";
import { type TestDaemon, testDaemons } from "./testing/daemon.js";
import { FakeTerminal } from "./testing/fake-terminal.js";
import { runTurn } from "./turn.js";

const daemons = testDaemons();
const later = (fn: () => void) => setTimeout(fn, 5);

describe("runTurn", () => {
  it("holds events that arrive before agent:prompt answers and ignores other turns", async () => {
    const d: TestDaemon = await daemons.start((channel) => {
      if (channel !== "agent:prompt") return null;
      d.server.push("agent:events", { type: "text", turnId: "t0", delta: "the shell's turn" });
      d.server.push("agent:events", { type: "turn-start", turnId: "t1", text: "hi" });
      d.server.push("agent:events", { type: "text", turnId: "t1", delta: "Hello" });
      later(() => {
        d.server.push("agent:events", { type: "text", turnId: "t1", delta: " there." });
        d.server.push("agent:events", { type: "turn-end", turnId: "t0", reason: "done" });
        d.server.push("agent:events", { type: "turn-end", turnId: "t1", reason: "done" });
      });
      return { turnId: "t1" };
    });
    const term = new FakeTerminal();
    const outcome = await runTurn(await daemons.connect(d), term, "hi");
    expect(outcome).toEqual({ reason: "done" });
    expect(term.output).toBe("Hello there.\n");
    expect(d.requests[0]).toEqual({ channel: "agent:prompt", args: [{ text: "hi" }] });
  });

  it("answers its own card once and reports the decision", async () => {
    const d: TestDaemon = await daemons.start((channel) => {
      if (channel === "agent:prompt") {
        later(() => d.server.push("agent:events", { type: "card", card: makeCard("c1", "t1") }));
        return { turnId: "t1" };
      }
      if (channel === "agent:confirm") {
        later(() => {
          d.server.push("agent:events", {
            type: "card-closed",
            cardId: "c1",
            decision: "approved",
          });
          d.server.push("agent:events", { type: "text", turnId: "t1", delta: "Installed GIMP." });
          d.server.push("agent:events", { type: "turn-end", turnId: "t1", reason: "done" });
        });
      }
      return null;
    });
    const term = new FakeTerminal({ lines: ["a"] });
    const outcome = await runTurn(await daemons.connect(d), term, "install gimp");
    expect(outcome.reason).toBe("done");
    const confirms = d.requests.filter((r) => r.channel === "agent:confirm");
    expect(confirms).toEqual([
      {
        channel: "agent:confirm",
        args: [{ cardId: "c1", approve: true, ticked: ["i1"], secrets: {} }],
      },
    ]);
    expect(term.output).toContain("Approved.");
    expect(term.output).toContain("Installed GIMP.");
  });

  it("stops prompting when the card is closed elsewhere and sends nothing", async () => {
    const d: TestDaemon = await daemons.start((channel) => {
      if (channel !== "agent:prompt") return null;
      later(() => d.server.push("agent:events", { type: "card", card: makeCard("c1", "t1") }));
      return { turnId: "t1" };
    });
    const term = new FakeTerminal();
    const running = runTurn(await daemons.connect(d), term, "install gimp");
    await vi.waitFor(() => expect(term.prompts).toContain("approve? › "));
    d.server.push("agent:events", { type: "card-closed", cardId: "c1", decision: "approved" });
    d.server.push("agent:events", { type: "turn-end", turnId: "t1", reason: "done" });
    expect((await running).reason).toBe("done");
    expect(d.requests.filter((r) => r.channel === "agent:confirm")).toEqual([]);
    expect(term.output).toContain("Approved.");
  });

  it("ignores cards of other turns and doctor cards", async () => {
    const d: TestDaemon = await daemons.start((channel) => {
      if (channel !== "agent:prompt") return null;
      later(() => {
        d.server.push("agent:events", { type: "card", card: makeCard("c0", "t0") });
        d.server.push("agent:events", { type: "card", card: makeCard("c9", null) });
        d.server.push("agent:events", { type: "card-closed", cardId: "c0", decision: "denied" });
        d.server.push("agent:events", { type: "turn-end", turnId: "t1", reason: "done" });
      });
      return { turnId: "t1" };
    });
    const term = new FakeTerminal({ lines: ["a"] });
    await runTurn(await daemons.connect(d), term, "hello");
    expect(term.prompts).toEqual([]);
    expect(term.output).toBe("");
  });

  it("sends agent:stop for the running turn on Ctrl+C", async () => {
    const d: TestDaemon = await daemons.start((channel) => {
      if (channel === "agent:prompt") {
        later(() =>
          d.server.push("agent:events", { type: "text", turnId: "t1", delta: "Working" }),
        );
        return { turnId: "t1" };
      }
      if (channel === "agent:stop") {
        later(() =>
          d.server.push("agent:events", { type: "turn-end", turnId: "t1", reason: "stopped" }),
        );
      }
      return null;
    });
    const term = new FakeTerminal();
    const running = runTurn(await daemons.connect(d), term, "scan my disk");
    await vi.waitFor(() => expect(term.output).toContain("Working"));
    term.interrupt();
    expect(await running).toEqual({ reason: "stopped" });
    expect(d.requests.find((r) => r.channel === "agent:stop")?.args).toEqual([{ turnId: "t1" }]);
  });

  it("reports a refused prompt", async () => {
    const d: TestDaemon = await daemons.start(() => {
      throw new ControlRequestError("forbidden", "Jarvis is already answering another message.");
    });
    const outcome = await runTurn(await daemons.connect(d), new FakeTerminal(), "hi");
    expect(outcome).toEqual({
      reason: "refused",
      error: "Jarvis is already answering another message.",
    });
  });

  it("ends as disconnected when jarvisd goes away", async () => {
    const d: TestDaemon = await daemons.start((channel) => {
      if (channel === "agent:prompt") later(() => void d.close());
      return channel === "agent:prompt" ? { turnId: "t1" } : null;
    });
    const outcome = await runTurn(await daemons.connect(d), new FakeTerminal(), "hi");
    expect(outcome.reason).toBe("disconnected");
  });

  it("prints hostile model text inert and shows tool progress", async () => {
    const d: TestDaemon = await daemons.start((channel) => {
      if (channel !== "agent:prompt") return null;
      later(() => {
        d.server.push("agent:events", {
          type: "tool",
          turnId: "t1",
          callId: "k1",
          name: "pkg.search",
          status: "running",
          summary: "",
        });
        d.server.push("agent:events", {
          type: "tool",
          turnId: "t1",
          callId: "k1",
          name: "pkg.search",
          status: "ok",
          summary: "Found 3 apps\u001b[2K",
        });
        d.server.push("agent:events", {
          type: "text",
          turnId: "t1",
          delta: "\u001b]0;owned\u0007Done\r",
        });
        d.server.push("agent:events", { type: "turn-end", turnId: "t1", reason: "done" });
      });
      return { turnId: "t1" };
    });
    const term = new FakeTerminal();
    await runTurn(await daemons.connect(d), term, "find an editor");
    expect(term.output).toBe("  · pkg.search…\n  ✓ Found 3 apps\nDone\n");
  });
});
