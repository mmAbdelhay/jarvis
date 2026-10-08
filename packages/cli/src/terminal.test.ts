import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { nodeTerminal } from "./terminal.js";

function fakeStdio(tty = true) {
  const raw: boolean[] = [];
  const input = Object.assign(new PassThrough(), {
    isTTY: tty,
    setRawMode: (on: boolean) => {
      raw.push(on);
    },
  });
  let written = "";
  const output = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        written += String(chunk);
        done();
      },
    }),
    { isTTY: tty },
  );
  return { input, output, raw, written: () => written };
}

describe("nodeTerminal", () => {
  it("reads a secret without echoing it, with backspace, and leaves raw mode", async () => {
    const io = fakeStdio();
    const term = nodeTerminal({ input: io.input, output: io.output, signals: false });
    expect(term.interactive).toBe(true);
    const pending = term.readSecret("Password: ");
    io.input.write("hunx\u007fter2\r");
    await expect(pending).resolves.toBe("hunter2");
    expect(io.written()).toBe("Password: \n");
    expect(io.raw).toEqual([true, false]);
  });

  it("skips arrow-key escape sequences inside a secret", async () => {
    const io = fakeStdio();
    const term = nodeTerminal({ input: io.input, output: io.output, signals: false });
    const pending = term.readSecret("Key: ");
    io.input.write("a\u001b[Db\r");
    await expect(pending).resolves.toBe("ab");
  });

  it("gives up a secret on Ctrl+C and when there is no terminal", async () => {
    const io = fakeStdio();
    const term = nodeTerminal({ input: io.input, output: io.output, signals: false });
    const pending = term.readSecret("Password: ");
    io.input.write("abc\u0003");
    await expect(pending).resolves.toBeNull();
    expect(io.raw).toEqual([true, false]);

    const piped = fakeStdio(false);
    const pipedTerm = nodeTerminal({ input: piped.input, output: piped.output, signals: false });
    expect(pipedTerm.interactive).toBe(false);
    piped.input.write("hunter2\n");
    await expect(pipedTerm.readSecret("Password: ")).resolves.toBeNull();
    expect(piped.written()).toBe("");
    expect(piped.raw).toEqual([]);
  });

  it("abandons a secret when its signal aborts", async () => {
    const io = fakeStdio();
    const term = nodeTerminal({ input: io.input, output: io.output, signals: false });
    const abort = new AbortController();
    const pending = term.readSecret("Password: ", abort.signal);
    abort.abort();
    await expect(pending).resolves.toBeNull();
    expect(io.raw).toEqual([true, false]);
  });

  it("reads a line, and null at end of input", async () => {
    const io = fakeStdio(false);
    const term = nodeTerminal({ input: io.input, output: io.output, signals: false });
    const first = term.readLine("› ");
    io.input.write("hello\n");
    await expect(first).resolves.toBe("hello");
    const second = term.readLine("› ");
    io.input.end();
    await expect(second).resolves.toBeNull();
  });

  it("keeps lines that arrive in one chunk for later reads", async () => {
    const io = fakeStdio(false);
    const term = nodeTerminal({ input: io.input, output: io.output, signals: false });
    const first = term.readLine("› ");
    io.input.write("one\ntwo\nthree\n");
    await expect(first).resolves.toBe("one");
    await expect(term.readLine("› ")).resolves.toBe("two");
    await expect(term.readLine("› ")).resolves.toBe("three");
    const last = term.readLine("› ");
    io.input.end();
    await expect(last).resolves.toBeNull();
    await expect(term.readLine("› ")).resolves.toBeNull();
  });

  it("returns null when a line read is aborted", async () => {
    const io = fakeStdio(false);
    const term = nodeTerminal({ input: io.input, output: io.output, signals: false });
    const abort = new AbortController();
    const pending = term.readLine("› ", abort.signal);
    abort.abort();
    await expect(pending).resolves.toBeNull();
  });
});
