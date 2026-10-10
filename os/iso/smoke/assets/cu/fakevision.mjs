#!/usr/bin/env node
// fakevision: a scripted vision model behind Ollama's HTTP API, for the
// computer-use GUI tests (v1.1 design §2 criterion 1; contracts §1, §2).
// jarvisd uses it as an ordinary `ollama` provider on loopback:
//  - the provider probe's `ping` tool and requests without tools get plain
//    answers; /api/show reports the "tools" and "vision" capabilities (gap G2);
//  - a prompt that contains a script turn's `expectPromptContains` plays that
//    turn's screen_* calls, one per chat request, resolving click targets from
//    the window list of the last capture jarvisd sent (gap G3);
//  - every screenshot is decoded and checked by the mask oracle (png.mjs);
//  - the JSON report (--report) is rewritten after every request.
//
//   node fakevision.mjs --script FILE --report FILE [--port 11500] [--host 127.0.0.1]
//
// Mask assertions: turn.mask defaults to {mode:"outside"}; step.mask overrides
// it for images returned by that call. {mode:"all-black"} asserts every pixel
// is black even with a fullscreen allowed rectangle or summary-only result.
// {mode:"fixture",pngBase64:"..."} compares decoded dimensions and RGB pixels
// before setting fullFrameChecked. Never set that flag from a script boolean.
// X10/X11 must treat vacuous:true + ok:false as missing privacy evidence, not
// a detected leak or a pass. Use controlled all-black captures or exact fixture
// evidence before asserting all images ok. Summary-only results cannot supply
// target geometry; outside targets then fail closed and record a problem.
// Strings in the script may use ${NAME} for environment variables (HOME, GIMP_APP).
// CU_DUMP_DIR=DIR writes every screenshot of a computer-use turn there as
// TURN-NN-SHA.png with the window list beside it (TURN-NN-SHA.json): the
// frames used to calibrate the script's click targets. Test runs only.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { checkMask, decodePng, foreignPoint } from "./png.mjs";

export const ERROR_CODES = ["outside", "excluded", "paused", "no-session", "unsupported", "failed"];
const DENIED = /\b(denied|declined|not approved|timed out)\b/i;
const DETAILS = {
  format: "gguf",
  family: "scripted",
  families: ["scripted"],
  parameter_size: "0B",
  quantization_level: "none",
};

export function substitute(value, env) {
  if (typeof value === "string")
    return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => env[name] ?? "");
  if (Array.isArray(value)) return value.map((v) => substitute(v, env));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, env)]));
  }
  return value;
}

/** A tool result's JSON body: without "ERROR: " and the <untrusted-data> fence (M1 §1). */
export function resultBody(content) {
  let text = String(content ?? "").replace(/^ERROR:\s*/, "");
  const fenced = text.match(/<untrusted-data[^>]*>\n?([\s\S]*?)\n?<\/untrusted-data>/);
  if (fenced) text = fenced[1];
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

// Merged V (packages/core/src/agent/cu-text.ts CU_MODEL_TEXT, screen-tools.ts) never
// passes the helper's code to the model: it rewrites each refusal into English. These
// map those texts back to the code they stand for; fakevision.test.mjs reads cu-text.ts
// so a reworded text fails the static tests instead of the container run.
const V_REFUSALS = [
  [
    /has ended for this request|could not start or went away|No computer-use session is running|stopped computer use/,
    "no-session",
  ],
  [/outside the allowed windows|is outside the \d+x\d+ screenshot/, "outside"],
  [/A protected window .* has focus/, "excluded"],
  [/took over the screen|paused and then resumed/, "paused"],
];

/** The contract §1 error code in a tool result, or null when it succeeded. */
export function errorCode(content) {
  const text = String(content ?? "");
  const body = resultBody(text);
  const code = body?.error?.code ?? body?.code;
  if (typeof code === "string" && ERROR_CODES.includes(code)) return code;
  if (!text.startsWith("ERROR:")) return null;
  const v = V_REFUSALS.find(([re]) => re.test(text));
  if (v !== undefined) return v[1];
  return ERROR_CODES.find((c) => new RegExp(`\\b${c}\\b`).test(text)) ?? "failed";
}

/** Capture data ({windows, ...}) from a tool result: the helper's shape, or merged V's
 *  screen.look result — a fenced array of the allowed windows only (no "allowed" field). */
export function captureOf(content) {
  const body = resultBody(content);
  if (body !== null && Array.isArray(body.windows)) return body;
  if (
    Array.isArray(body) &&
    body.every((w) => w !== null && typeof w === "object" && typeof w.appId === "string")
  ) {
    const size = String(content ?? "").match(/(\d+)x(\d+) pixels/);
    return {
      ...(size ? { width: Number(size[1]), height: Number(size[2]) } : {}),
      windows: body.map((w) => ({ ...w, allowed: true })),
    };
  }
  return null;
}

/** The user said no to a card (a window list mentioning "denied" is not that). */
export function isDenied(content) {
  if (captureOf(content) !== null) return false;
  return DENIED.test(String(content ?? ""));
}

/** The newest capture data ({width, height, scale, windows}) in the conversation. */
export function windowsIn(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "tool" && !(Array.isArray(m?.images) && m.images.length > 0)) continue;
    const body = captureOf(m.content);
    if (body !== null) return body;
    // Section 4 permits a text-only summary. Never reuse geometry from a
    // capture preceding that summary (or from before a new user turn).
    if (m?.tool_name === "screen_look") return null;
  }
  return null;
}

export function resolveTarget(target, windows) {
  if (target?.outside === true) {
    // U-1 redacts foreign rectangles and fills the capture with the allowed
    // window. In that case use a coordinate beyond every reported rectangle.
    const allowed = windows.filter(
      (w) =>
        w?.allowed === true && [w.x, w.y, w.w, w.h].every(Number.isFinite) && w.w > 0 && w.h > 0,
    );
    if (allowed.length === 0) return null;
    return (
      foreignPoint(windows) ?? {
        x: Math.max(0, ...allowed.map((w) => w.x + w.w)) + 4,
        y: Math.max(0, ...allowed.map((w) => w.y + w.h)) + 4,
      }
    );
  }
  if (typeof target?.window !== "string") return null;
  const pattern = new RegExp(target.window, "i");
  const w = windows.find((x) => x?.allowed === true && pattern.test(String(x.title ?? "")));
  if (w === undefined) return null;
  const [dx, dy] = Array.isArray(target.inset) ? target.inset : [0, 0];
  if (target.from === "top-left") return { x: Math.round(w.x + dx), y: Math.round(w.y + dy) };
  if (target.from === "top-right")
    return { x: Math.round(w.x + w.w - dx), y: Math.round(w.y + dy) };
  if (target.from === "bottom-left")
    return { x: Math.round(w.x + dx), y: Math.round(w.y + w.h - dy) };
  if (target.from === "bottom-right")
    return { x: Math.round(w.x + w.w - dx), y: Math.round(w.y + w.h - dy) };
  return { x: Math.round(w.x + w.w / 2 + dx), y: Math.round(w.y + w.h / 2 + dy) };
}

const isPrompt = (m) => m?.role === "user" && !(Array.isArray(m.images) && m.images.length > 0);

export function createFakeVision(script, { env = process.env } = {}) {
  const report = {
    model: script.model ?? "scripted-vision:latest",
    requests: 0,
    unexpected: [],
    imagesOutsideComputerUse: 0,
    turns: [],
  };
  const seen = new Set();
  let active = null;

  let dumped = 0;
  function dump(record, id, b64, windows) {
    const dir = env.CU_DUMP_DIR;
    if (typeof dir !== "string" || dir === "") return;
    try {
      mkdirSync(dir, { recursive: true });
      const base = join(dir, `${record.name}-${String(dumped).padStart(3, "0")}-${id}`);
      dumped += 1;
      writeFileSync(`${base}.png`, Buffer.from(b64, "base64"));
      writeFileSync(`${base}.json`, `${JSON.stringify(windows ?? null, null, 2)}\n`);
    } catch (error) {
      record.dumpError = String(error?.message ?? error);
    }
  }

  function inspect(messages, record) {
    let info = null;
    for (const [messageIndex, m] of messages.entries()) {
      const data = captureOf(m?.content);
      if (m?.role === "tool" && m.tool_name === "screen_look") info = null;
      if ((m?.role === "tool" || Array.isArray(m?.images)) && data !== null) info = data;
      for (const b64 of Array.isArray(m?.images) ? m.images : []) {
        const digest = createHash("sha256").update(String(b64)).digest("hex");
        const key = JSON.stringify([
          record === null ? `off:${report.requests}` : report.turns.indexOf(record),
          messageIndex,
          digest,
          info?.windows,
        ]);
        if (seen.has(key)) continue;
        seen.add(key);
        if (record === null) {
          report.imagesOutsideComputerUse += 1;
          continue;
        }
        const id = digest.slice(0, 16);
        dump(record, id, String(b64), info?.windows);
        try {
          const image = decodePng(Buffer.from(String(b64), "base64"));
          const mask = substitute(
            active.last?.mask ?? active.turn.mask ?? { mode: "outside" },
            env,
          );
          const options = { maxEdge: script.maxEdge ?? 1280 };
          let fixtureMatches = null;
          if (mask.mode === "all-black") options.expectAllBlack = true;
          else if (mask.mode === "fixture") {
            const fixture = decodePng(Buffer.from(mask.pngBase64, "base64"));
            fixtureMatches =
              fixture.width === image.width &&
              fixture.height === image.height &&
              Buffer.from(fixture.pixels).equals(Buffer.from(image.pixels));
            options.fullFrameChecked = fixtureMatches;
          } else if (mask.mode !== "outside") throw new Error(`unknown mask mode: ${mask.mode}`);
          const checked = checkMask(image, info?.windows ?? [], options);
          // Full-frame assertions do not require window metadata from V's
          // text summary. Preserve all pixel/size failures; waive only the
          // metadata prerequisite after an independent full-frame assertion.
          if (mask.mode === "all-black" || fixtureMatches === true) {
            checked.problems = checked.problems.filter(
              (p) => p !== "the capture's window list has no allowed window",
            );
            checked.ok = checked.problems.length === 0;
          }
          if (fixtureMatches === false) {
            checked.ok = false;
            checked.problems.push("full-frame fixture mismatch");
          }
          record.images.push({ sha256: id, maskMode: mask.mode, ...checked });
        } catch (error) {
          record.images.push({
            sha256: id,
            ok: false,
            problems: [`undecodable screenshot: ${error.message}`],
          });
        }
      }
    }
  }

  function absorb(tail) {
    const step = active.last;
    if (step === null) return;
    active.last = null;
    const results = tail.filter((m) => m?.role === "tool").map((m) => String(m.content ?? ""));
    step.result = {
      received: results.length > 0,
      error: results.map(errorCode).find((c) => c !== null) ?? null,
      denied: results.some(isDenied),
      text: results.join("\n").slice(0, 300),
    };
    if (step.expectError !== undefined)
      step.pass = step.result.error !== null && step.expectError.includes(step.result.error);
    if (step.result.denied) {
      active.record.denied = true;
      if (Array.isArray(active.turn.onDenied) && !active.branched) {
        active.steps = active.turn.onDenied;
        active.cursor = 0;
        active.branched = true;
      }
    }
  }

  function next(windows) {
    while (active.cursor < active.steps.length) {
      const step = substitute(active.steps[active.cursor], env);
      active.cursor += 1;
      if (step.text !== undefined) {
        active.record.finished = true;
        return { text: step.text };
      }
      const record = { index: active.record.steps.length, call: step.call };
      active.record.steps.push(record);
      if (step.onlyIfWindow !== undefined) {
        const pattern = new RegExp(step.onlyIfWindow, "i");
        if (!windows.some((w) => pattern.test(String(w?.title ?? "")))) {
          record.skipped = true;
          continue;
        }
      }
      const input = { ...(step.input ?? {}) };
      if (step.target !== undefined) {
        const point = resolveTarget(step.target, windows);
        if (point === null) {
          record.problem = `no click target for ${JSON.stringify(step.target)} among ${windows.length} windows`;
          continue;
        }
        Object.assign(input, point);
      }
      record.input = input;
      if (step.mask !== undefined) record.mask = step.mask;
      if (step.expectError !== undefined) record.expectError = [step.expectError].flat();
      active.last = record;
      return {
        call: { name: step.call, arguments: input },
        holdMs: Math.round(Number(step.hold ?? 0) * 1000),
      };
    }
    active.record.finished = true;
    return { text: "Done." };
  }

  function chat(body) {
    report.requests += 1;
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const tools = (Array.isArray(body?.tools) ? body.tools : [])
      .map((t) => t?.function?.name)
      .filter((n) => typeof n === "string");
    if (tools.length === 1 && tools[0] === "ping") return { call: { name: "ping", arguments: {} } };
    const prompts = messages.filter(isPrompt);
    const prompt = String(prompts.at(-1)?.content ?? "");
    const turn = script.turns.find((t) => prompt.includes(t.expectPromptContains));
    const currentMessages = messages.slice(Math.max(0, messages.findLastIndex(isPrompt)));
    if (tools.length === 0) {
      inspect(messages, null);
      if (turn === undefined || turn.steps.some((step) => step.call !== undefined))
        return { text: "ok" };
      // Text-only scripts (the off turn) can answer without taking over an
      // in-progress screen turn, including its pending tool result.
      report.turns.push({
        name: turn.name,
        prompt: prompt.slice(0, 200),
        toolsOffered: tools,
        steps: [],
        images: [],
        denied: false,
        finished: true,
      });
      return {
        text: substitute(turn.steps.find((step) => step.text !== undefined)?.text ?? "Done.", env),
      };
    }
    // jarvisd may trim older history between requests of one turn, so the
    // number of prompts can change mid-turn: only a different prompt, or the
    // same prompt again after its turn finished, starts a new turn.
    const fresh =
      active === null ||
      active.prompt !== prompt ||
      (active.record.finished && active.promptCount !== prompts.length);
    if (fresh) {
      if (turn === undefined) {
        active = null;
        report.unexpected.push(prompt.slice(0, 200));
        inspect(messages, null);
        return { text: "fakevision: no script for this prompt" };
      }
      const record = {
        name: turn.name,
        prompt: prompt.slice(0, 200),
        toolsOffered: tools,
        steps: [],
        images: [],
        denied: false,
        finished: false,
      };
      report.turns.push(record);
      active = {
        turn,
        record,
        steps: turn.steps,
        cursor: 0,
        prompt,
        promptCount: prompts.length,
        last: null,
        branched: false,
      };
    }
    const screen = tools.some((n) => n.startsWith("screen_"));
    const info = windowsIn(currentMessages);
    inspect(screen ? currentMessages : messages, screen ? active.record : null);
    let lastAssistant = -1;
    currentMessages.forEach((m, i) => {
      if (m?.role === "assistant") lastAssistant = i;
    });
    absorb(currentMessages.slice(lastAssistant + 1));
    return next(Array.isArray(info?.windows) ? info.windows : []);
  }

  return { chat, report };
}

export function createServerFor(core, { reportPath, model }) {
  const save = () => {
    if (reportPath) writeFileSync(reportPath, `${JSON.stringify(core.report, null, 2)}\n`);
  };
  return createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (d) => {
      raw += d;
    });
    req.on("end", async () => {
      const path = new URL(req.url ?? "/", "http://fakevision").pathname;
      const now = new Date().toISOString();
      const json = (status, value) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      try {
        if (path === "/" || path === "/api/version") return json(200, { version: "0.12.6" });
        if (path === "/api/tags") {
          return json(200, {
            models: [
              {
                name: model,
                model,
                modified_at: now,
                size: 1,
                digest: "0".repeat(64),
                details: DETAILS,
              },
            ],
          });
        }
        if (path === "/api/ps") return json(200, { models: [] });
        if (path === "/api/show") {
          return json(200, {
            modelfile: "",
            parameters: "",
            template: "",
            details: DETAILS,
            model_info: {},
            capabilities: ["completion", "tools", "vision"],
          });
        }
        if (path === "/api/chat" && req.method === "POST") {
          const body = raw === "" ? {} : JSON.parse(raw);
          const reply = core.chat(body);
          save();
          if (reply.holdMs > 0) await new Promise((resolve) => setTimeout(resolve, reply.holdMs));
          const message =
            reply.text !== undefined
              ? { role: "assistant", content: reply.text }
              : { role: "assistant", content: "", tool_calls: [{ function: reply.call }] };
          const done = {
            model,
            created_at: now,
            message: { role: "assistant", content: "" },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 1,
            eval_count: 1,
          };
          if (body.stream === false) return json(200, { ...done, message });
          res.writeHead(200, { "content-type": "application/x-ndjson" });
          res.write(`${JSON.stringify({ model, created_at: now, message, done: false })}\n`);
          res.end(`${JSON.stringify(done)}\n`);
          return;
        }
        json(404, { error: `fakevision: no route ${req.method} ${path}` });
      } catch (error) {
        json(500, { error: `fakevision: ${error.message}` });
      } finally {
        save();
      }
    });
  });
}

export async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      script: { type: "string" },
      report: { type: "string" },
      port: { type: "string", default: "11500" },
      host: { type: "string", default: "127.0.0.1" },
    },
  });
  if (!values.script || !values.report) {
    process.stderr.write(
      "usage: fakevision.mjs --script FILE --report FILE [--port 11500] [--host 127.0.0.1]\n",
    );
    return 64;
  }
  const script = JSON.parse(readFileSync(values.script, "utf8"));
  const core = createFakeVision(script);
  const server = createServerFor(core, { reportPath: values.report, model: core.report.model });
  writeFileSync(values.report, `${JSON.stringify(core.report, null, 2)}\n`);
  await new Promise((resolve) => server.listen(Number(values.port), values.host, resolve));
  process.stdout.write(`fakevision listening on ${values.host}:${values.port}\n`);
  await new Promise((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
  });
  server.close();
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
