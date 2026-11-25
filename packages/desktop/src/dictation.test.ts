import { describe, expect, it, vi } from "vitest";
import {
  cleanDictation,
  createDictation,
  createDictationRecorder,
  DICTATION_CAP_MS,
  DICTATION_HOLD_MS,
  DICTATION_LEASE_MS,
  DICTATION_STOP_MS,
  type DictationRecorder,
} from "./dictation.js";

type Fake = DictationRecorder & {
  started: boolean;
  aborted: boolean;
  disposed: number;
  stopCalls: number;
  die(error?: string): void;
  stopResult: { resolve(path: string): void; reject(error: Error): void };
};

function fakeRecorder(): Fake {
  let settle: (result: { error?: string }) => void = () => undefined;
  const ended = new Promise<{ error?: string }>((resolve) => {
    settle = resolve;
  });
  let resolveStop: (path: string) => void = () => undefined;
  let rejectStop: (error: Error) => void = () => undefined;
  const fake: Fake = {
    started: false,
    aborted: false,
    disposed: 0,
    stopCalls: 0,
    ended,
    start() {
      fake.started = true;
    },
    stop() {
      fake.stopCalls += 1;
      return new Promise<string>((resolve, reject) => {
        resolveStop = resolve;
        rejectStop = reject;
      });
    },
    abort() {
      fake.aborted = true;
    },
    async dispose() {
      fake.disposed += 1;
    },
    die(error) {
      settle(error === undefined ? {} : { error });
    },
    stopResult: {
      resolve: (path) => resolveStop(path),
      reject: (error) => rejectStop(error),
    },
  };
  return fake;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(
  options: {
    busy?: boolean;
    agent?: boolean;
    transcript?: { text: string; language: string } | Error;
    hold?: boolean;
  } = {},
) {
  const recorders: Fake[] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const logs: string[] = [];
  let busy = options.busy ?? false;
  let release: (value: { text: string; language: string }) => void = () => undefined;
  const transcribe = vi.fn(async (_wav: string) => {
    if (options.hold === true) {
      return new Promise<{ text: string; language: string }>((resolve) => {
        release = resolve;
      });
    }
    const t = options.transcript ?? { text: "hello there", language: "en" };
    if (t instanceof Error) throw t;
    return t;
  });
  let n = 0;
  const dictation = createDictation({
    makeRecorder: async () => {
      const recorder = fakeRecorder();
      recorders.push(recorder);
      return recorder;
    },
    transcribe,
    schedule: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    busy: () => busy,
    hostsAgent: async (key) => key === "t1" && options.agent !== false,
    log: (token) => logs.push(token),
    randomId: () => {
      n += 1;
      return `id${n}`;
    },
  });
  const live = (ms: number) => timers.filter((t) => !t.cancelled && t.ms === ms);
  return {
    dictation,
    recorders,
    timers,
    logs,
    transcribe,
    live,
    setBusy: (value: boolean) => {
      busy = value;
    },
    release: (value: { text: string; language: string }) => release(value),
  };
}

async function begin(s: ReturnType<typeof setup>) {
  const started = await s.dictation.start("t1");
  if (!started.ok) throw new Error("start failed");
  return started.id;
}

describe("start", () => {
  it("records and answers an id", async () => {
    const s = setup();
    const result = await s.dictation.start("t1");
    expect(result).toEqual({ ok: true, id: "id1" });
    expect(s.recorders[0]?.started).toBe(true);
    expect(s.dictation.active()).toBe(true);
  });

  it("refuses a pane without an agent, or a non-string key", async () => {
    const s = setup({ agent: false });
    expect(await s.dictation.start("t1")).toEqual({ ok: false, reason: "failed" });
    expect(await s.dictation.start(42 as unknown)).toEqual({ ok: false, reason: "failed" });
    expect(s.recorders).toHaveLength(0);
    expect(s.dictation.active()).toBe(false);
  });

  it("is busy while the voice turn records, and starts no ffmpeg", async () => {
    const s = setup({ busy: true });
    expect(await s.dictation.start("t1")).toEqual({ ok: false, reason: "busy" });
    expect(s.recorders).toHaveLength(0);
  });

  it("is busy when a second dictation starts, while recording and while transcribing", async () => {
    const s = setup({ hold: true });
    const id = await begin(s);
    expect(await s.dictation.start("t1")).toEqual({ ok: false, reason: "busy" });
    const finishing = s.dictation.finish(id);
    await tick();
    s.recorders[0]?.stopResult.resolve("/tmp/d/a.wav");
    await tick();
    expect(s.dictation.active()).toBe(false);
    expect(await s.dictation.start("t1")).toEqual({ ok: false, reason: "busy" });
    s.release({ text: "x", language: "en" });
    await finishing;
  });

  it("answers failed when the recorder throws on start, and is free again", async () => {
    const s = setup();
    const dictation = createDictation({
      makeRecorder: async () => {
        const recorder = fakeRecorder();
        recorder.start = () => {
          throw new Error("no ffmpeg");
        };
        s.recorders.push(recorder);
        return recorder;
      },
      transcribe: s.transcribe,
      schedule: () => () => undefined,
      busy: () => false,
      hostsAgent: async () => true,
      log: () => undefined,
    });
    expect(await dictation.start("t1")).toEqual({ ok: false, reason: "failed" });
    expect(dictation.active()).toBe(false);
    expect(s.recorders[0]?.disposed).toBe(1);
  });

  it("ids differ and are long by default", async () => {
    const dictation = createDictation({
      makeRecorder: async () => fakeRecorder(),
      transcribe: async () => ({ text: "a", language: "en" }),
      schedule: () => () => undefined,
      busy: () => false,
      hostsAgent: async () => true,
      log: () => undefined,
    });
    const a = await dictation.start("t1");
    expect(a.ok && a.id.length >= 32).toBe(true);
  });
});

describe("id checks", () => {
  it("rejects a wrong id on every call and leaves the recording alone", async () => {
    const s = setup();
    await begin(s);
    expect(s.dictation.keep("nope")).toEqual({ ok: false, reason: "gone" });
    expect(await s.dictation.finish("nope")).toEqual({ ok: false, reason: "gone" });
    expect(s.dictation.cancel("nope")).toEqual({ ok: false });
    expect(s.dictation.keep(7 as unknown)).toEqual({ ok: false, reason: "gone" });
    expect(s.dictation.active()).toBe(true);
    expect(s.recorders[0]?.aborted).toBe(false);
  });
});

describe("finish", () => {
  it("stops, transcribes, cleans and answers the text", async () => {
    const s = setup();
    const id = await begin(s);
    const finishing = s.dictation.finish(id);
    await tick();
    s.recorders[0]?.stopResult.resolve("/tmp/d/a.wav");
    expect(await finishing).toEqual({ ok: true, text: "hello there", language: "en" });
    expect(s.transcribe).toHaveBeenCalledWith("/tmp/d/a.wav");
    expect(s.recorders[0]?.disposed).toBeGreaterThanOrEqual(1);
    expect(s.dictation.active()).toBe(false);
    // The id is spent.
    expect(await s.dictation.finish(id)).toEqual({ ok: false, reason: "gone" });
    expect(await s.dictation.start("t1")).toMatchObject({ ok: true });
  });

  it("answers silence for empty text and for whole-text non-speech marks", async () => {
    for (const text of [
      "",
      "  ",
      "[BLANK_AUDIO]",
      "(music)",
      "[Music] (Music)",
      "\n[ Silence ]\n",
    ]) {
      const s = setup({ transcript: { text, language: "en" } });
      const id = await begin(s);
      const finishing = s.dictation.finish(id);
      await tick();
      s.recorders[0]?.stopResult.resolve("/w.wav");
      expect(await finishing).toEqual({ ok: false, reason: "silence" });
      expect(s.recorders[0]?.disposed).toBeGreaterThanOrEqual(1);
      expect(s.dictation.active()).toBe(false);
    }
  });

  it("answers failed when the transcriber throws, and cleans up, without logging text", async () => {
    const s = setup({ transcript: new Error("whisper broke: secret words") });
    const id = await begin(s);
    const finishing = s.dictation.finish(id);
    await tick();
    s.recorders[0]?.stopResult.resolve("/w.wav");
    expect(await finishing).toEqual({ ok: false, reason: "failed" });
    expect(s.recorders[0]?.disposed).toBeGreaterThanOrEqual(1);
    expect(s.logs.join(" ")).not.toContain("secret");
    expect(await s.dictation.start("t1")).toMatchObject({ ok: true });
  });

  it("answers failed when stop rejects and never leaves it active", async () => {
    const s = setup();
    const id = await begin(s);
    const finishing = s.dictation.finish(id);
    await tick();
    s.recorders[0]?.stopResult.reject(new Error("Could not start the microphone recorder"));
    expect(await finishing).toEqual({ ok: false, reason: "failed" });
    expect(s.dictation.active()).toBe(false);
    expect(s.recorders[0]?.disposed).toBeGreaterThanOrEqual(1);
    expect(s.transcribe).not.toHaveBeenCalled();
  });

  it("answers failed from finish when the recorder died at once", async () => {
    const s = setup();
    const id = await begin(s);
    s.recorders[0]?.die("spawn ffmpeg ENOENT");
    await tick();
    expect(await s.dictation.finish(id)).toEqual({ ok: false, reason: "failed" });
    expect(s.dictation.active()).toBe(false);
    expect(s.recorders[0]?.disposed).toBeGreaterThanOrEqual(1);
  });

  it("a second finish while transcribing is gone", async () => {
    const s = setup({ hold: true });
    const id = await begin(s);
    const first = s.dictation.finish(id);
    await tick();
    s.recorders[0]?.stopResult.resolve("/w.wav");
    await tick();
    expect(await s.dictation.finish(id)).toEqual({ ok: false, reason: "gone" });
    s.release({ text: "ok", language: "en" });
    expect(await first).toMatchObject({ ok: true, text: "ok" });
  });
});

describe("keep and the lease", () => {
  it("the lease aborts a recording nobody keeps", async () => {
    const s = setup();
    await begin(s);
    const lease = s.live(DICTATION_LEASE_MS);
    expect(lease).toHaveLength(1);
    lease[0]?.fn();
    await tick();
    expect(s.recorders[0]?.aborted).toBe(true);
    expect(s.recorders[0]?.disposed).toBeGreaterThanOrEqual(1);
    expect(s.dictation.active()).toBe(false);
    expect(await s.dictation.start("t1")).toMatchObject({ ok: true });
  });

  it("keep renews the lease", async () => {
    const s = setup();
    const id = await begin(s);
    const first = s.live(DICTATION_LEASE_MS)[0];
    expect(s.dictation.keep(id)).toEqual({ ok: true });
    expect(first?.cancelled).toBe(true);
    expect(s.live(DICTATION_LEASE_MS)).toHaveLength(1);
  });

  it("keep tells the renderer the recorder settled early, once, then frees it", async () => {
    const s = setup();
    const id = await begin(s);
    s.recorders[0]?.die("gone");
    await tick();
    expect(s.dictation.keep(id)).toEqual({ ok: false, reason: "failed" });
    expect(s.dictation.active()).toBe(false);
    expect(s.dictation.keep(id)).toEqual({ ok: false, reason: "gone" });
    expect(s.recorders[0]?.disposed).toBeGreaterThanOrEqual(1);
  });
});

describe("the five minute cap", () => {
  it("stops recording, keeps the file for finish, then finish works once", async () => {
    const s = setup();
    const id = await begin(s);
    s.live(DICTATION_CAP_MS)[0]?.fn();
    await tick();
    expect(s.recorders[0]?.stopCalls).toBe(1);
    s.recorders[0]?.stopResult.resolve("/w.wav");
    await tick();
    expect(s.dictation.active()).toBe(false);
    expect(s.dictation.keep(id)).toEqual({ ok: true, capped: true });
    expect(s.live(DICTATION_HOLD_MS)).toHaveLength(1);
    expect(await s.dictation.finish(id)).toEqual({ ok: true, text: "hello there", language: "en" });
    expect(s.recorders[0]?.stopCalls).toBe(1);
    expect(await s.dictation.finish(id)).toEqual({ ok: false, reason: "gone" });
  });

  it("deletes the file when nobody finishes within the hold", async () => {
    const s = setup();
    const id = await begin(s);
    s.live(DICTATION_CAP_MS)[0]?.fn();
    await tick();
    s.recorders[0]?.stopResult.resolve("/w.wav");
    await tick();
    s.live(DICTATION_HOLD_MS)[0]?.fn();
    await tick();
    expect(s.recorders[0]?.disposed).toBeGreaterThanOrEqual(1);
    expect(await s.dictation.finish(id)).toEqual({ ok: false, reason: "gone" });
    expect(await s.dictation.start("t1")).toMatchObject({ ok: true });
  });

  it("a finish that arrives while the cap is still stopping shares that stop", async () => {
    const s = setup();
    const id = await begin(s);
    s.live(DICTATION_CAP_MS)[0]?.fn();
    const finishing = s.dictation.finish(id);
    await tick();
    expect(s.recorders[0]?.stopCalls).toBe(1);
    s.recorders[0]?.stopResult.resolve("/w.wav");
    expect(await finishing).toMatchObject({ ok: true });
  });
});

describe("cancel", () => {
  it("aborts the recording and removes the files", async () => {
    const s = setup();
    const id = await begin(s);
    expect(s.dictation.cancel(id)).toEqual({ ok: true });
    expect(s.recorders[0]?.aborted).toBe(true);
    await tick();
    expect(s.recorders[0]?.disposed).toBeGreaterThanOrEqual(1);
    expect(s.dictation.active()).toBe(false);
  });

  it("during transcribing the result is dropped", async () => {
    const s = setup({ hold: true });
    const id = await begin(s);
    const finishing = s.dictation.finish(id);
    await tick();
    s.recorders[0]?.stopResult.resolve("/w.wav");
    await tick();
    expect(s.dictation.cancel(id)).toEqual({ ok: true });
    s.release({ text: "late words", language: "en" });
    expect(await finishing).toEqual({ ok: false, reason: "gone" });
    expect(s.recorders[0]?.disposed).toBeGreaterThanOrEqual(1);
    expect(await s.dictation.start("t1")).toMatchObject({ ok: true });
  });

  it("during the stop in finish, nothing is transcribed", async () => {
    const s = setup();
    const id = await begin(s);
    const finishing = s.dictation.finish(id);
    await tick();
    expect(s.dictation.cancel(id)).toEqual({ ok: true });
    s.recorders[0]?.stopResult.resolve("/w.wav");
    expect(await finishing).toEqual({ ok: false, reason: "gone" });
    expect(s.transcribe).not.toHaveBeenCalled();
    expect(s.recorders[0]?.disposed).toBeGreaterThanOrEqual(1);
  });
});

describe("dispose", () => {
  it("aborts a live recording and removes its files", async () => {
    const s = setup();
    await begin(s);
    s.dictation.dispose();
    await tick();
    expect(s.recorders[0]?.aborted).toBe(true);
    expect(s.recorders[0]?.disposed).toBeGreaterThanOrEqual(1);
    expect(s.dictation.active()).toBe(false);
  });

  it("a start answered after dispose releases what it made and fails", async () => {
    const s = setup();
    const starting = s.dictation.start("t1");
    s.dictation.dispose();
    expect(await starting).toEqual({ ok: false, reason: "failed" });
    expect(s.recorders.every((r) => r.disposed >= 1 && (!r.started || r.aborted))).toBe(true);
    expect(s.dictation.active()).toBe(false);
  });
});

describe("busy re-check", () => {
  it("does not start ffmpeg if the voice turn began during the agent check", async () => {
    const s = setup();
    const starting = s.dictation.start("t1");
    s.setBusy(true);
    expect(await starting).toEqual({ ok: false, reason: "busy" });
    expect(s.recorders.every((r) => !r.started)).toBe(true);
    expect(s.dictation.active()).toBe(false);
  });
});

describe("cleanDictation", () => {
  it("strips control characters and escapes, turns newlines into spaces", () => {
    expect(cleanDictation("a\u0007b\u001b[31mred\u001b[0m\nline two\r\n\tend\u0000")).toBe(
      "ab" + "red line two end",
    );
  });

  it("removes non-speech marks only when they are the whole text", () => {
    expect(cleanDictation("[BLANK_AUDIO]")).toBe("");
    expect(cleanDictation("(music) [Music]")).toBe("");
    expect(cleanDictation("hello (music) there")).toBe("hello (music) there");
    expect(cleanDictation("(please call me)")).toBe("(please call me)");
  });

  it("caps at 20000 characters without splitting a surrogate pair", () => {
    const out = cleanDictation(`${"a".repeat(19_999)}😀tail`);
    expect(out.length).toBeLessThanOrEqual(20_000);
    expect(out).toBe("a".repeat(19_999));
    expect(cleanDictation("b".repeat(30_000))).toHaveLength(20_000);
  });
});

describe("createDictationRecorder", () => {
  function deps() {
    const calls: string[] = [];
    let settle: (r: { error?: string }) => void = () => undefined;
    const base = {
      tmpDir: "/unused",
      deleteFile: async (p: string) => void calls.push(`rm-file ${p}`),
      spawnRecorder: (p: string) => {
        calls.push(`spawn ${p}`);
        return {
          kill: () => void calls.push("kill"),
          done: new Promise<{ error?: string }>((resolve) => {
            settle = resolve;
          }),
        };
      },
    };
    return {
      calls,
      settle: (r: { error?: string }) => settle(r),
      options: {
        recorder: base,
        makeDir: async () => "/tmp/jarvis-dictation-x",
        removeDir: async (d: string) => void calls.push(`rm-dir ${d}`),
      },
    };
  }

  it("records into the fresh directory and removes it on dispose", async () => {
    const d = deps();
    const rec = await createDictationRecorder(d.options);
    rec.start();
    expect(d.calls[0]).toMatch(/^spawn [\\/]tmp[\\/]jarvis-dictation-x[\\/]jarvis-.*\.wav$/);
    const stopping = rec.stop();
    d.settle({});
    expect(await stopping).toMatch(/^[\\/]tmp[\\/]jarvis-dictation-x/);
    await rec.dispose();
    await rec.dispose();
    expect(d.calls.filter((c) => c === "rm-dir /tmp/jarvis-dictation-x")).toHaveLength(2);
  });

  it("ended settles when the process dies by itself", async () => {
    const d = deps();
    const rec = await createDictationRecorder(d.options);
    rec.start();
    d.settle({ error: "no ffmpeg" });
    expect(await rec.ended).toEqual({ error: "no ffmpeg" });
  });

  it("abort kills and dispose still removes the directory", async () => {
    const d = deps();
    const rec = await createDictationRecorder(d.options);
    rec.start();
    rec.abort();
    d.settle({});
    await rec.dispose();
    expect(d.calls).toContain("kill");
    expect(d.calls).toContain("rm-dir /tmp/jarvis-dictation-x");
  });
});

describe("a recorder whose stop never settles", () => {
  it("fails the finish after 5 seconds, kills the process, and frees the slot", async () => {
    const s = setup();
    const id = await begin(s);
    const finishing = s.dictation.finish(id);
    await tick();
    const timer = s.live(DICTATION_STOP_MS)[0];
    expect(timer).toBeDefined();
    timer?.fn();
    expect(await finishing).toEqual({ ok: false, reason: "failed" });
    expect(s.recorders[0]?.aborted).toBe(true);
    expect(s.recorders[0]?.disposed).toBe(1);
    expect(s.dictation.active()).toBe(false);
    expect(await s.dictation.start("t1")).toMatchObject({ ok: true });
  });

  it("also frees the microphone when the cap's stop hangs", async () => {
    const s = setup();
    await begin(s);
    s.live(DICTATION_CAP_MS)[0]?.fn();
    await tick();
    s.live(DICTATION_STOP_MS)[0]?.fn();
    await tick();
    expect(s.recorders[0]?.aborted).toBe(true);
    expect(s.dictation.active()).toBe(false);
  });

  it("does not time out a stop that settles", async () => {
    const s = setup();
    const id = await begin(s);
    const finishing = s.dictation.finish(id);
    await tick();
    s.recorders[0]?.stopResult.resolve("/x.wav");
    await tick();
    expect(s.live(DICTATION_STOP_MS)).toHaveLength(0);
    expect(await finishing).toMatchObject({ ok: true });
  });
});

describe("createDictationRecorder disposal", () => {
  function hungDeps() {
    const calls: string[] = [];
    let settle: (r: { error?: string }) => void = () => undefined;
    let wake: () => void = () => undefined;
    return {
      calls,
      settle: (r: { error?: string }) => settle(r),
      wake: () => wake(),
      options: {
        recorder: {
          tmpDir: "/unused",
          deleteFile: async () => undefined,
          spawnRecorder: () => ({
            kill: () => void calls.push("kill"),
            done: new Promise<{ error?: string }>((resolve) => {
              settle = resolve;
            }),
          }),
        },
        makeDir: async () => "/tmp/jarvis-dictation-y",
        removeDir: async (d: string) => void calls.push(`rm-dir ${d}`),
        delay: (ms: number) => {
          calls.push(`delay ${ms}`);
          return new Promise<void>((resolve) => {
            wake = resolve;
          });
        },
      },
    };
  }

  it("waits for the process to end before it removes the directory", async () => {
    const d = hungDeps();
    const rec = await createDictationRecorder(d.options);
    rec.start();
    const disposing = rec.dispose();
    await tick();
    expect(d.calls.some((c) => c.startsWith("rm-dir"))).toBe(false);
    d.settle({});
    await disposing;
    expect(d.calls).toContain("rm-dir /tmp/jarvis-dictation-y");
  });

  it("gives up waiting after 4 seconds", async () => {
    const d = hungDeps();
    const rec = await createDictationRecorder(d.options);
    rec.start();
    const disposing = rec.dispose();
    await tick();
    expect(d.calls).toContain("delay 4000");
    d.wake();
    await disposing;
    expect(d.calls).toContain("rm-dir /tmp/jarvis-dictation-y");
  });
});
