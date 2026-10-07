import { describe, expect, it } from "vitest";
import { createModelStateReader } from "./model-state-reader.js";

const PATH = "/var/lib/jarvis/model-state.json";
const good = JSON.stringify({
  modelId: "qwen3-8b",
  ollamaTag: "qwen3:8b",
  state: "ready",
  percent: 100,
  message: "",
  updatedAt: "2026-10-08T09:00:00Z",
});
const failure = (code: string) => Object.assign(new Error(code), { code });

function reader(answers: Array<string | Error>) {
  const lines: string[] = [];
  const read = createModelStateReader({
    path: PATH,
    readFile: async (path) => {
      expect(path).toBe(PATH);
      const next = answers.shift();
      if (next === undefined) throw new Error("unexpected read");
      if (next instanceof Error) throw next;
      return next;
    },
    log: (line) => lines.push(line),
  });
  return { read, lines };
}

describe("createModelStateReader", () => {
  it("returns the parsed state", async () => {
    const { read } = reader([good]);
    await expect(read()).resolves.toMatchObject({ ollamaTag: "qwen3:8b", state: "ready" });
  });

  it("is silently null when the file does not exist (cloud installs, M1 systems)", async () => {
    const { read, lines } = reader([failure("ENOENT"), failure("ENOTDIR")]);
    await expect(read()).resolves.toBeNull();
    await expect(read()).resolves.toBeNull();
    expect(lines).toEqual([]);
  });

  it("is null for a corrupt or unreadable file and logs each problem once, again after it recovers", async () => {
    const { read, lines } = reader(['{"modelId":', "garbage", failure("EACCES"), good, "garbage"]);
    await expect(read()).resolves.toBeNull();
    await expect(read()).resolves.toBeNull();
    await expect(read()).resolves.toBeNull();
    await expect(read()).resolves.not.toBeNull();
    await expect(read()).resolves.toBeNull();
    expect(lines).toEqual([
      `[model-state] ${PATH} is not a valid model state; ignored`,
      `[model-state] ${PATH} cannot be read (EACCES)`,
      `[model-state] ${PATH} is not a valid model state; ignored`,
    ]);
  });
});

describe("model-state reader failure boundaries", () => {
  it.each([null, undefined, "private error text", 42])(
    "handles a rejection without an error object: %s",
    async (error) => {
      const lines: string[] = [];
      const read = createModelStateReader({
        path: PATH,
        readFile: async () => {
          throw error;
        },
        log: (line) => lines.push(line),
      });
      await expect(read()).resolves.toBeNull();
      await expect(read()).resolves.toBeNull();
      expect(lines).toEqual([`[model-state] ${PATH} cannot be read (error)`]);
    },
  );

  it("still returns null and recovers if logging throws", async () => {
    const answers = ["garbage", good];
    const read = createModelStateReader({
      path: PATH,
      readFile: async () => answers.shift() ?? "garbage",
      log: () => {
        throw new Error("logger unavailable");
      },
    });
    await expect(read()).resolves.toBeNull();
    await expect(read()).resolves.toMatchObject({ state: "ready" });
  });
});
