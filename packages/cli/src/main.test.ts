import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ControlRequestError } from "../../desktop/src/daemon/control/messages.js";
import { NotRunningError } from "./connect.js";
import { main } from "./main.js";
import { type TestDaemon, testDaemons } from "./testing/daemon.js";
import { FakeTerminal } from "./testing/fake-terminal.js";

const daemons = testDaemons();
const never = () => Promise.reject(new Error("connect should not be called"));
const noStdin = () => Promise.resolve("");

describe("main", () => {
  it("prints usage for --help and for mistakes", async () => {
    const term = new FakeTerminal();
    expect(await main(["--help"], { term, env: {}, connect: never, readStdin: noStdin })).toBe(0);
    expect(term.output).toContain('jarvis ask "<question>"');
    const wrong = new FakeTerminal();
    expect(
      await main(["frobnicate"], { term: wrong, env: {}, connect: never, readStdin: noStdin }),
    ).toBe(2);
    expect(wrong.output).toContain("Unknown argument: frobnicate");
  });

  it("explains a daemon that is not running", async () => {
    const term = new FakeTerminal();
    const code = await main(["ask", "hi"], {
      term,
      env: {},
      connect: () => Promise.reject(new NotRunningError()),
      readStdin: noStdin,
    });
    expect(code).toBe(1);
    expect(term.output).toBe(
      "Jarvis isn't running. Start it with: systemctl --user start jarvisd\n",
    );
  });

  it("needs a terminal for setup", async () => {
    const term = new FakeTerminal({ interactive: false });
    expect(await main(["setup"], { term, env: {}, connect: never, readStdin: noStdin })).toBe(2);
  });

  it("reads a piped question as one turn", async () => {
    const d: TestDaemon = await daemons.start((channel) => {
      if (channel !== "agent:prompt") return null;
      setTimeout(
        () => d.server.push("agent:events", { type: "turn-end", turnId: "t1", reason: "done" }),
        5,
      );
      return { turnId: "t1" };
    });
    const term = new FakeTerminal({ interactive: false });
    const code = await main([], {
      term,
      env: {},
      connect: () => daemons.connect(d),
      readStdin: () => Promise.resolve("  why is my wifi slow?\n"),
    });
    expect(code).toBe(0);
    expect(d.requests.find((r) => r.channel === "agent:prompt")?.args).toEqual([
      { text: "why is my wifi slow?" },
    ]);
  });

  it("reports a channel error in plain words", async () => {
    const d: TestDaemon = await daemons.start(() => {
      throw new ControlRequestError("unsupported", "Memory is off: the keyring is locked.");
    });
    const term = new FakeTerminal();
    const code = await main(["memory"], {
      term,
      env: {},
      connect: () => daemons.connect(d),
      readStdin: noStdin,
    });
    expect(code).toBe(1);
    expect(term.output).toBe("Jarvis couldn't do that: Memory is off: the keyring is locked.\n");
  });
});

describe("terminal safety", () => {
  it("prints unknown arguments inert", async () => {
    const term = new FakeTerminal();
    expect(
      await main(["bad\u001b[2K"], { term, env: {}, connect: never, readStdin: noStdin }),
    ).toBe(2);
    expect(term.output).toContain("Unknown argument: bad\n");
    expect(term.output).not.toContain("\u001b");
  });

  it("prints the build stamp inert", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jcli-version-"));
    try {
      const path = join(dir, "build-stamp.json");
      await writeFile(path, JSON.stringify({ build: "build\u001b[2K\nspoof" }));
      const term = new FakeTerminal();
      expect(
        await main(["--version"], {
          term,
          env: { JARVIS_BUILD_STAMP: path },
          connect: never,
          readStdin: noStdin,
        }),
      ).toBe(0);
      expect(term.output).toBe("jarvis (jarvisd build build spoof)\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
