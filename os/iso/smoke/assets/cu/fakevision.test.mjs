import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createFakeVision,
  createServerFor,
  errorCode,
  isDenied,
  resolveTarget,
  resultBody,
  substitute,
} from "./fakevision.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decodePng, encodePng } from "./png.mjs";

const GIMP = {
  windowId: "w1",
  appId: "org.gimp.GIMP",
  title: "beach.xcf – GIMP",
  x: 40,
  y: 0,
  w: 60,
  h: 60,
  focused: true,
  allowed: true,
};
const TERM = {
  windowId: "w2",
  appId: "foot",
  title: "cu-secret-terminal",
  x: 0,
  y: 0,
  w: 30,
  h: 30,
  focused: false,
  allowed: false,
};
const DIALOG = {
  windowId: "w3",
  appId: "org.gimp.GIMP",
  title: "Export Image as PNG",
  x: 50,
  y: 10,
  w: 40,
  h: 30,
  focused: true,
  allowed: true,
};
const SCREEN = ["screen_look", "screen_click", "screen_key", "screen_type", "screen_done"].map(
  (name) => ({ type: "function", function: { name } }),
);
const masked = (windows) =>
  encodePng(100, 60, (x, y) =>
    windows.some((w) => w.allowed && x >= w.x && x < w.x + w.w && y >= w.y && y < w.y + w.h)
      ? [180, 180, 180]
      : [0, 0, 0],
  );
const fenced = (tool, value) =>
  `<untrusted-data source="${tool}">\n${JSON.stringify(value)}\n</untrusted-data>`;
const lookResult = (windows, png = masked(windows)) => [
  {
    role: "tool",
    tool_name: "screen_look",
    content: fenced("screen.look", { width: 100, height: 60, scale: 1, windows }),
  },
  { role: "user", content: "Screenshot of the allowed windows.", images: [png.toString("base64")] },
];
const called = (name, args) => ({
  role: "assistant",
  content: "",
  tool_calls: [{ function: { name, arguments: args } }],
});

/** Drives a core the way jarvisd's tool loop does: one chat request per reply. */
function conversation(core, prompt, tools = SCREEN) {
  const messages = [
    { role: "system", content: "You are Jarvis." },
    { role: "user", content: prompt },
  ];
  return {
    ask: () => core.chat({ model: "scripted-vision:latest", messages, tools }),
    add: (...more) => messages.push(...more),
  };
}

test("answers the provider probe and tool-less side requests", () => {
  const core = createFakeVision({ turns: [] });
  assert.deepEqual(
    core.chat({
      messages: [{ role: "user", content: "Call the ping tool now." }],
      tools: [{ function: { name: "ping" } }],
    }),
    { call: { name: "ping", arguments: {} } },
  );
  assert.deepEqual(core.chat({ messages: [{ role: "user", content: "summarise" }] }), {
    text: "ok",
  });
});

test("records prompts it has no script for", () => {
  const core = createFakeVision({ turns: [] });
  assert.match(conversation(core, "hello").ask().text, /no script/);
  assert.deepEqual(core.report.unexpected, ["hello"]);
});

test("plays a turn: look, a refused click on the terminal, done; screenshots pass the mask", () => {
  const core = createFakeVision(
    {
      turns: [
        {
          name: "probe",
          expectPromptContains: "cu-probe",
          steps: [
            // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${...} placeholders are the data under test.
            { call: "screen_look", input: { goal: "g", apps: ["${GIMP_APP}"] } },
            {
              call: "screen_click",
              target: { outside: true },
              input: { button: "left" },
              expectError: "outside",
            },
            { text: "Probe finished." },
          ],
        },
      ],
    },
    { env: { GIMP_APP: "org.gimp.GIMP" } },
  );
  const c = conversation(core, "cu-probe: look");
  let r = c.ask();
  assert.deepEqual(r.call, {
    name: "screen_look",
    arguments: { goal: "g", apps: ["org.gimp.GIMP"] },
  });
  c.add(called("screen_look", r.call.arguments), ...lookResult([GIMP, TERM]));
  r = c.ask();
  assert.equal(r.call.name, "screen_click");
  assert.ok(r.call.arguments.x < 30 && r.call.arguments.y < 30, "the click lands on the terminal");
  c.add(called("screen_click", r.call.arguments), {
    role: "tool",
    tool_name: "screen_click",
    content: "ERROR: outside: (4, 4) is not inside an allowed window",
  });
  assert.deepEqual(c.ask(), { text: "Probe finished." });
  const turn = core.report.turns[0];
  assert.equal(turn.steps[1].pass, true);
  assert.equal(turn.images.length, 1);
  assert.equal(turn.images[0].ok, true);
  assert.ok(turn.images[0].foreignPixels > 0);
  assert.equal(turn.finished, true);
});

test("flags a screenshot that shows the terminal", () => {
  const core = createFakeVision({
    turns: [
      {
        name: "t",
        expectPromptContains: "cu-",
        steps: [{ call: "screen_look", input: {} }, { text: "done" }],
      },
    ],
  });
  const c = conversation(core, "cu-leak");
  const r = c.ask();
  c.add(
    called("screen_look", r.call.arguments),
    ...lookResult(
      [GIMP, TERM],
      encodePng(100, 60, () => [90, 90, 90]),
    ),
  );
  c.ask();
  assert.equal(core.report.turns[0].images[0].ok, false);
  assert.ok(core.report.turns[0].images[0].leakedPixels > 0);
});

test("clicks a dialog's bottom-right corner, and branches to onDenied when the user says no", () => {
  const core = createFakeVision({
    turns: [
      {
        name: "deny",
        expectPromptContains: "cu-deny",
        steps: [
          { call: "screen_look", input: {} },
          {
            call: "screen_click",
            target: { window: "Export Image as PNG", from: "bottom-right", inset: [4, 3] },
            input: { button: "left", intent: "save" },
          },
          { text: "Exported." },
        ],
        onDenied: [{ call: "screen_key", input: { combo: "Escape" } }, { text: "Stopped." }],
      },
    ],
  });
  const c = conversation(core, "cu-deny: export");
  let r = c.ask();
  c.add(called("screen_look", {}), ...lookResult([GIMP, DIALOG, TERM]));
  r = c.ask();
  assert.deepEqual(r.call, {
    name: "screen_click",
    arguments: { button: "left", intent: "save", x: 86, y: 37 },
  });
  c.add(called("screen_click", r.call.arguments), {
    role: "tool",
    tool_name: "screen_click",
    content: "The user denied this action.",
  });
  r = c.ask();
  assert.deepEqual(r.call, { name: "screen_key", arguments: { combo: "Escape" } });
  c.add(called("screen_key", r.call.arguments), {
    role: "tool",
    tool_name: "screen_key",
    content: "{}",
  });
  assert.deepEqual(c.ask(), { text: "Stopped." });
  assert.equal(core.report.turns[0].denied, true);
});

test("skips onlyIfWindow steps when no window title matches", () => {
  const core = createFakeVision({
    turns: [
      {
        name: "t",
        expectPromptContains: "cu-skip",
        steps: [
          { call: "screen_look", input: {} },
          { call: "screen_key", input: { combo: "Return" }, onlyIfWindow: "Export Image as PNG" },
          { text: "done" },
        ],
      },
    ],
  });
  const c = conversation(core, "cu-skip");
  c.ask();
  c.add(called("screen_look", {}), ...lookResult([GIMP]));
  assert.deepEqual(c.ask(), { text: "done" });
  assert.equal(core.report.turns[0].steps[1].skipped, true);
});

test("a new prompt starts its own turn", () => {
  const core = createFakeVision({
    turns: [
      { name: "a", expectPromptContains: "cu-a", steps: [{ text: "A" }] },
      { name: "b", expectPromptContains: "cu-b", steps: [{ text: "B" }] },
    ],
  });
  const messages = [{ role: "user", content: "cu-a" }];
  assert.deepEqual(core.chat({ messages, tools: SCREEN }), { text: "A" });
  messages.push({ role: "assistant", content: "A" }, { role: "user", content: "cu-b" });
  assert.deepEqual(core.chat({ messages, tools: SCREEN }), { text: "B" });
  assert.deepEqual(
    core.report.turns.map((t) => t.name),
    ["a", "b"],
  );
});

test("counts screenshots sent in a turn without screen tools", () => {
  const core = createFakeVision({
    turns: [{ name: "off", expectPromptContains: "cu-off", steps: [{ text: "off" }] }],
  });
  core.chat({
    messages: [
      { role: "user", content: "cu-off" },
      { role: "user", content: "x", images: [masked([GIMP]).toString("base64")] },
    ],
    tools: [{ function: { name: "pkg_search" } }],
  });
  assert.equal(core.report.imagesOutsideComputerUse, 1);
  assert.deepEqual(core.report.turns[0].toolsOffered, ["pkg_search"]);
});

test("counts historical screenshots resent without screen tools on each request", () => {
  const core = createFakeVision({
    turns: [
      {
        name: "probe",
        expectPromptContains: "cu-probe",
        steps: [{ call: "screen_look" }, { text: "done" }],
      },
      { name: "off", expectPromptContains: "cu-off", steps: [{ text: "off" }] },
    ],
  });
  const messages = [{ role: "user", content: "cu-probe: look" }];
  core.chat({ messages, tools: SCREEN });
  messages.push(called("screen_look", {}), ...lookResult([GIMP, TERM]));
  core.chat({ messages, tools: SCREEN });
  assert.equal(core.report.imagesOutsideComputerUse, 0);
  messages.push({ role: "assistant", content: "done" }, { role: "user", content: "cu-off: look" });
  core.chat({ messages, tools: [{ function: { name: "pkg_search" } }] });
  assert.equal(core.report.imagesOutsideComputerUse, 1);
  core.chat({ messages });
  assert.equal(core.report.imagesOutsideComputerUse, 2);
});

test("tool-less title requests quoting a call script leave the active turn intact", () => {
  const core = createFakeVision({
    turns: [
      {
        name: "x",
        expectPromptContains: "cu-x",
        steps: [
          { call: "screen_look" },
          { call: "screen_key", input: { combo: "Return" } },
          { text: "done" },
        ],
      },
    ],
  });
  assert.deepEqual(core.chat({ messages: [{ role: "user", content: "Title for: cu-x go" }] }), {
    text: "ok",
  });
  assert.equal(core.report.turns.length, 0);
  const c = conversation(core, "cu-x go");
  c.ask();
  assert.deepEqual(core.chat({ messages: [{ role: "user", content: "Title for: cu-x go" }] }), {
    text: "ok",
  });
  assert.equal(core.report.turns.length, 1);
  c.add(called("screen_look", {}), ...lookResult([GIMP]));
  assert.deepEqual(c.ask().call, { name: "screen_key", arguments: { combo: "Return" } });
  assert.equal(core.report.turns[0].steps[0].result.received, true);
});

test("a tool-less text-only script preserves an in-progress active turn", () => {
  const core = createFakeVision({
    turns: [
      {
        name: "x",
        expectPromptContains: "cu-x",
        steps: [{ call: "screen_look" }, { text: "done" }],
      },
      { name: "off", expectPromptContains: "cu-off", steps: [{ text: "off" }] },
    ],
  });
  const c = conversation(core, "cu-x go");
  c.ask();
  assert.deepEqual(core.chat({ messages: [{ role: "user", content: "cu-off" }] }), { text: "off" });
  c.add(called("screen_look", {}), ...lookResult([GIMP]));
  assert.deepEqual(c.ask(), { text: "done" });
  assert.deepEqual(
    core.report.turns.map((t) => t.name),
    ["x", "off"],
  );
  assert.equal(core.report.turns[0].steps[0].result.received, true);
});

test("reads tool results the way jarvisd writes them", () => {
  assert.deepEqual(resultBody(`ERROR: ${fenced("screen.click", { error: { code: "paused" } })}`), {
    error: { code: "paused" },
  });
  assert.equal(errorCode("ERROR: excluded: a terminal has focus"), "excluded");
  assert.equal(
    errorCode(fenced("screen.key", { ok: false, error: { code: "no-session", message: "x" } })),
    "no-session",
  );
  assert.equal(errorCode(fenced("screen.look", { windows: [] })), null);
  assert.equal(errorCode("ERROR: something odd"), "failed");
  assert.equal(
    isDenied(fenced("screen.look", { windows: [{ title: "Access denied – Firefox" }] })),
    false,
  );
  assert.equal(isDenied("The user declined the action."), true);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${...} placeholders are the data under test.
  assert.deepEqual(substitute({ a: ["${HOME}/x", 3], b: "${NOPE}" }, { HOME: "/home/t" }), {
    a: ["/home/t/x", 3],
    b: "",
  });
  assert.deepEqual(resolveTarget({ window: "beach", from: "center" }, [GIMP]), { x: 70, y: 30 });
  assert.equal(resolveTarget({ window: "beach" }, [{ ...GIMP, allowed: false }]), null);
});

test("speaks Ollama's HTTP API on loopback and writes the report", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fv-"));
  const reportPath = join(dir, "report.json");
  const core = createFakeVision({ turns: [] });
  const server = createServerFor(core, { reportPath, model: "scripted-vision:latest" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const tags = await (await fetch(`${base}/api/tags`)).json();
    assert.equal(tags.models[0].name, "scripted-vision:latest");
    const show = await (await fetch(`${base}/api/show`, { method: "POST", body: "{}" })).json();
    assert.deepEqual(show.capabilities, ["completion", "tools", "vision"]);
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", content: "Call the ping tool now." }],
        tools: [{ type: "function", function: { name: "ping" } }],
      }),
    });
    const lines = (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].message.tool_calls[0].function.name, "ping");
    assert.equal(lines[1].done, true);
    assert.equal(JSON.parse(readFileSync(reportPath, "utf8")).requests, 1);
  } finally {
    server.close();
  }
});

test("U-1: outside targets work with redacted foreign rectangles", () => {
  const full = { ...GIMP, x: 0, y: 0, w: 100, h: 60 };
  const hidden = { ...TERM, title: "", x: 0, y: 0, w: 0, h: 0 };
  const point = resolveTarget({ outside: true }, [full, hidden]);
  assert.ok(point && (point.x < 0 || point.y < 0 || point.x >= 100 || point.y >= 60));
});

test("inspects identical screenshot bytes again in a new turn", () => {
  const core = createFakeVision({
    turns: ["a", "b"].map((name) => ({
      name,
      expectPromptContains: `cu-${name}`,
      steps: [{ call: "screen_look" }, { text: "done" }],
    })),
  });
  for (const name of ["a", "b"]) {
    const c = conversation(core, `cu-${name}`);
    c.ask();
    c.add(called("screen_look", {}), ...lookResult([GIMP, TERM]));
    c.ask();
  }
  assert.deepEqual(
    core.report.turns.map((t) => t.images.length),
    [1, 1],
  );
});

test("U-1: fullscreen images fail closed rather than claiming mask evidence", () => {
  const core = createFakeVision({
    turns: [
      {
        name: "full",
        expectPromptContains: "cu-full",
        steps: [{ call: "screen_look" }, { text: "done" }],
      },
    ],
  });
  const c = conversation(core, "cu-full");
  c.ask();
  c.add(called("screen_look", {}), ...lookResult([{ ...GIMP, x: 0, y: 0, w: 100, h: 60 }]));
  c.ask();
  assert.equal(core.report.turns[0].images[0].vacuous, true);
  assert.equal(core.report.turns[0].images[0].ok, false);
});

test("fixture flows begin the way merged V does: screen_look {goal, apps}, never cu_begin", () => {
  const script = JSON.parse(readFileSync(new URL("./cu-gimp.json", import.meta.url), "utf8"));
  assert.deepEqual(
    script.turns.map((t) => t.name),
    ["off", "probe", "deny", "export", "excluded", "stuck", "lock", "physical", "takeover"],
  );
  // V offers only the screen_* tools; cu.begin is the session card's hidden tool (screen-tools.ts).
  const modelTools = /^screen_(look|click|type|key|scroll|drag|done)$/;
  for (const turn of script.turns.filter((t) => t.name !== "off")) {
    assert.equal(turn.steps[0].call, "screen_look", turn.name);
    assert.ok(turn.steps[0].input.goal);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${...} placeholders are the data under test.
    assert.deepEqual(turn.steps[0].input.apps, ["${GIMP_APP}"]);
    for (const step of turn.steps.filter((s) => s.call !== undefined))
      assert.match(step.call, modelTools, turn.name);
  }
  assert.ok(
    script.turns.find((t) => t.name === "deny").steps.some((s) => s.call === "screen_done"),
  );
  assert.match(
    script.turns.find((t) => t.name === "export").steps.at(-1).text,
    /beach.png is in Pictures/,
  );
});

// What merged V (computer-use.ts look()) actually sends: a header line, then the fenced
// array of the ALLOWED windows only (no "allowed" field), then the image as a user message.
const vLook = (windows, png) => [
  {
    role: "tool",
    tool_name: "screen_look",
    content: `Screenshot of the allowed windows, 100x60 pixels (everything else is black). The allowed windows are listed below.\n${fenced("screen.look", windows)}`,
  },
  { role: "user", content: "[screenshot from screen_look]", images: [png.toString("base64")] },
];
const vWindow = ({ allowed: _a, windowId: _w, ...rest }) => rest;

test("reads merged V's look result: a fenced array of allowed windows", () => {
  const core = createFakeVision({
    turns: [
      {
        name: "p",
        expectPromptContains: "cu-v",
        steps: [
          { call: "screen_look", input: {} },
          {
            call: "screen_click",
            target: { outside: true },
            input: { button: "left" },
            expectError: "outside",
          },
          { call: "screen_look", input: {}, mask: { mode: "all-black" } },
          { text: "done" },
        ],
      },
    ],
  });
  const full = vWindow({ ...GIMP, x: 0, y: 0, w: 100, h: 60 });
  const c = conversation(core, "cu-v");
  c.ask();
  c.add(
    called("screen_look", {}),
    ...vLook(
      [full],
      encodePng(100, 60, () => [120, 120, 120]),
    ),
  );
  const r = c.ask();
  assert.equal(r.call.name, "screen_click", JSON.stringify(core.report.turns[0].steps));
  assert.ok(r.call.arguments.x >= 100 || r.call.arguments.y >= 60, "a point beyond the screenshot");
  c.add(called("screen_click", r.call.arguments), {
    role: "tool",
    tool_name: "screen_click",
    content: `ERROR: (${r.call.arguments.x}, ${r.call.arguments.y}) is outside the 100x60 screenshot`,
  });
  c.ask();
  c.add(
    called("screen_look", {}),
    ...vLook(
      [full],
      encodePng(100, 60, () => [0, 0, 0]),
    ),
  );
  assert.deepEqual(c.ask(), { text: "done" });
  const turn = core.report.turns[0];
  assert.equal(turn.steps[1].pass, true);
  assert.equal(turn.images[0].vacuous, true, "the fullscreen window list was read");
  assert.ok(!turn.images[0].problems.some((p) => /no allowed window/.test(p)));
  assert.equal(turn.images[1].ok, true);
  assert.equal(turn.images[1].maskMode, "all-black");
});

test("maps merged V's refusal texts (cu-text.ts) to the helper's error codes", () => {
  const src = readFileSync(
    new URL("../../../../../packages/core/src/agent/cu-text.ts", import.meta.url),
    "utf8",
  );
  const block = src.slice(src.indexOf("export const CU_MODEL_TEXT"));
  const text = (key) => {
    const m = block.match(new RegExp(`\\b${key}:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    assert.ok(m, `CU_MODEL_TEXT.${key} not found`);
    return m[1];
  };
  const expect = {
    outside: "outside",
    excluded: "excluded",
    pausedNow: "paused",
    resumedLookFirst: "paused",
    stoppedByUser: "no-session",
    closedThisTurn: "no-session",
    noSession: "no-session",
  };
  for (const [key, code] of Object.entries(expect))
    assert.equal(errorCode(`ERROR: ${text(key)}`), code, key);
  const begin = block.match(/beginFailed: \(message: string\) => `([^$]*)\$\{message\}`/);
  assert.ok(begin, "beginFailed not found");
  assert.equal(errorCode(`ERROR: ${begin[1]}a terminal is excluded`), "no-session");
  const tools = readFileSync(
    new URL("../../../../../packages/core/src/agent/screen-tools.ts", import.meta.url),
    "utf8",
  );
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${...} placeholders are the data under test.
  assert.ok(tools.includes("is outside the ${bounds.width}x${bounds.height} screenshot"));
  assert.equal(errorCode("ERROR: (1284, 804) is outside the 1280x800 screenshot"), "outside");
  assert.equal(errorCode(`ERROR: ${text("lookFirst")}`), "failed");
  assert.equal(
    isDenied(
      `Screenshot of the allowed windows.\n${fenced("screen.look", [{ appId: "firefox", title: "Access denied" }])}`,
    ),
    false,
  );
});

test("fixture creation accepts quotes in the output directory without evaluating them", () => {
  const root = mkdtempSync(join(tmpdir(), "fv-fixture-"));
  const bin = join(root, "bin");
  const dir = join(root, "beach'\" folder");
  mkdirSync(bin);
  for (const name of ["dirname", "mkdir"])
    symlinkSync(name === "mkdir" ? "/bin/mkdir" : "/usr/bin/dirname", join(bin, name));
  try {
    // GIMP is deliberately unavailable; PNG generation must still finish safely.
    const run = spawnSync(
      "/bin/sh",
      [fileURLToPath(new URL("./make-fixture.sh", import.meta.url)), dir],
      {
        env: { ...process.env, PATH: bin, JARVIS_NODE: process.execPath },
        encoding: "utf8",
      },
    );
    assert.equal(run.status, 1);
    assert.match(run.stderr, /gimp-console not found/);
    const image = decodePng(readFileSync(join(dir, "beach.png")));
    assert.equal(image.width, 640);
    assert.equal(image.height, 480);
    assert.deepEqual([...image.pixels.subarray(0, 3)], [80, 160, 230]);
    assert.deepEqual([...image.pixels.subarray(640 * 300 * 3, 640 * 300 * 3 + 3)], [230, 200, 140]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checks each screenshot against its own capture metadata", () => {
  const core = createFakeVision({
    turns: [
      {
        name: "t",
        expectPromptContains: "cu-history",
        steps: [{ call: "screen_look" }, { call: "screen_look" }, { text: "done" }],
      },
    ],
  });
  const c = conversation(core, "cu-history");
  c.ask();
  c.add(called("screen_look", {}), ...lookResult([GIMP, TERM]));
  c.ask();
  const left = { ...GIMP, x: 0, w: 30 };
  c.add(called("screen_look", {}), ...lookResult([left]));
  c.ask();
  assert.equal(core.report.turns[0].images.length, 2);
  assert.ok(core.report.turns[0].images.every((i) => i.ok));
});

test("outside target without an allowed rectangle records a problem instead of clicking", () => {
  assert.equal(resolveTarget({ outside: true }, []), null);
  assert.equal(resolveTarget({ outside: true }, [{ ...TERM, w: 0, h: 0 }]), null);
  const core = createFakeVision({
    turns: [
      {
        name: "t",
        expectPromptContains: "cu-unknown",
        steps: [
          { call: "screen_look" },
          { call: "screen_click", target: { outside: true } },
          { text: "done" },
        ],
      },
    ],
  });
  const c = conversation(core, "cu-unknown");
  c.ask();
  c.add(
    called("screen_look", {}),
    { role: "tool", content: "Fullscreen GIMP." },
    { role: "user", images: [masked([GIMP]).toString("base64")] },
  );
  assert.deepEqual(c.ask(), { text: "done" });
  assert.match(core.report.turns[0].steps[1].problem, /no click target/);
});

test("per-step all-black mode checks repeated bytes again and detects focus leaks", () => {
  const core = createFakeVision({
    turns: [
      {
        name: "t",
        expectPromptContains: "cu-black",
        steps: [
          { call: "screen_look" },
          { call: "screen_look", mask: { mode: "all-black" } },
          { text: "done" },
        ],
      },
    ],
  });
  const c = conversation(core, "cu-black");
  const full = { ...GIMP, x: 0, y: 0, w: 100, h: 60 };
  c.ask();
  c.add(called("screen_look", {}), ...lookResult([full]));
  c.ask();
  c.add(called("screen_look", {}), ...lookResult([full]));
  c.ask();
  const images = core.report.turns[0].images;
  assert.equal(images.length, 2);
  assert.equal(images[1].ok, false);
  assert.ok(images[1].leakedPixels > 0);
});

test("turn all-black mode passes with summary-only screen.look", () => {
  const core = createFakeVision({
    turns: [
      {
        name: "t",
        expectPromptContains: "cu-black",
        mask: { mode: "all-black" },
        steps: [{ call: "screen_look" }, { text: "done" }],
      },
    ],
  });
  const c = conversation(core, "cu-black");
  c.ask();
  c.add(
    called("screen_look", {}),
    { role: "tool", content: "Allowed window is not focused." },
    { role: "user", images: [encodePng(100, 60, () => [0, 0, 0]).toString("base64")] },
  );
  c.ask();
  assert.equal(core.report.turns[0].images[0].ok, true);
});

test("fixture mode proves full-frame pixels and rejects a changed fixture", () => {
  const fixture = masked([{ ...GIMP, x: 0, y: 0, w: 100, h: 60 }]).toString("base64");
  for (const [png, expected] of [
    [Buffer.from(fixture, "base64"), true],
    [encodePng(100, 60, () => [1, 2, 3]), false],
  ]) {
    const core = createFakeVision({
      turns: [
        {
          name: "t",
          expectPromptContains: "cu-fixture",
          mask: { mode: "fixture", pngBase64: fixture },
          steps: [{ call: "screen_look" }, { text: "done" }],
        },
      ],
    });
    const c = conversation(core, "cu-fixture");
    c.ask();
    c.add(called("screen_look", {}), ...lookResult([{ ...GIMP, x: 0, y: 0, w: 100, h: 60 }], png));
    c.ask();
    assert.equal(core.report.turns[0].images[0].ok, expected);
  }
});

test("the export turns click through both Export dialogs; the deny turn cancels after the card", () => {
  const script = JSON.parse(readFileSync(new URL("./cu-gimp.json", import.meta.url), "utf8"));
  const turn = (name) => script.turns.find((t) => t.name === name);
  for (const name of ["deny", "export"]) {
    const steps = turn(name).steps;
    // Mouse only: GTK3 (GIMP) ignores virtual-keyboard keys under headless labwc.
    assert.ok(!steps.some((s) => s.call === "screen_key" || s.call === "screen_type"));
    const clicks = steps.filter((s) => s.call === "screen_click").map((s) => s.input.target);
    assert.deepEqual(clicks, ["File menu", "Export As…", "Pictures", "Export", "Export"]);
    // Every click is preceded by a look at what it acts on.
    steps.forEach((s, i) => {
      if (s.call === "screen_click") assert.equal(steps[i - 1].call, "screen_look");
    });
  }
  const cancel = turn("deny").onDenied;
  assert.equal(cancel[0].input.target, "Cancel");
  assert.equal(cancel.at(-2).call, "screen_done");
  assert.ok(!script.concerns.join("\n").includes("U/V must"));
});

test("summary-only capture invalidates earlier target geometry", () => {
  const core = createFakeVision({
    turns: [
      {
        name: "t",
        expectPromptContains: "cu-summary",
        steps: [
          { call: "screen_look" },
          { call: "screen_look" },
          { call: "screen_click", target: { window: "beach" } },
          { text: "done" },
        ],
      },
    ],
  });
  const c = conversation(core, "cu-summary");
  c.ask();
  c.add(called("screen_look", {}), ...lookResult([GIMP]));
  c.ask();
  c.add(
    called("screen_look", {}),
    { role: "tool", tool_name: "screen_look", content: "Allowed window is not focused." },
    { role: "user", images: [encodePng(100, 60, () => [0, 0, 0]).toString("base64")] },
  );
  assert.deepEqual(c.ask(), { text: "done" });
  assert.match(core.report.turns[0].steps[2].problem, /no click target/);
});

test("scripted off turn runs even when no tools are offered", () => {
  const script = JSON.parse(readFileSync(new URL("./cu-gimp.json", import.meta.url), "utf8"));
  const core = createFakeVision(script);
  const reply = conversation(core, "cu-off: can you see my screen?", []).ask();
  assert.match(reply.text, /computer use is off/);
  assert.equal(core.report.turns[0].name, "off");
  assert.equal(core.report.turns[0].finished, true);
});

test("summary-only capture cannot pass a mask using earlier rectangles", () => {
  const core = createFakeVision({
    turns: [
      {
        name: "t",
        expectPromptContains: "cu-summary",
        steps: [{ call: "screen_look" }, { call: "screen_look" }, { text: "done" }],
      },
    ],
  });
  const c = conversation(core, "cu-summary");
  c.ask();
  c.add(called("screen_look", {}), ...lookResult([GIMP]));
  c.ask();
  c.add(
    called("screen_look", {}),
    { role: "tool", tool_name: "screen_look", content: "GIMP is visible." },
    { role: "user", images: [masked([GIMP]).toString("base64")] },
  );
  c.ask();
  assert.equal(core.report.turns[0].images[1].ok, false);
  assert.ok(core.report.turns[0].images[1].problems.some((p) => /no allowed window/.test(p)));
});

test("a new turn does not recheck historical images under its mask policy", () => {
  const core = createFakeVision({
    turns: [
      { name: "a", expectPromptContains: "cu-a", steps: [{ call: "screen_look" }, { text: "A" }] },
      {
        name: "b",
        expectPromptContains: "cu-b",
        mask: { mode: "all-black" },
        steps: [{ call: "screen_look" }, { text: "B" }],
      },
    ],
  });
  const c = conversation(core, "cu-a");
  c.ask();
  c.add(called("screen_look", {}), ...lookResult([GIMP, TERM]));
  c.ask();
  c.add({ role: "assistant", content: "A" }, { role: "user", content: "cu-b" });
  c.ask();
  c.add(
    called("screen_look", {}),
    ...lookResult(
      [GIMP, TERM],
      encodePng(100, 60, () => [0, 0, 0]),
    ),
  );
  c.ask();
  assert.equal(core.report.turns[1].images.length, 1);
  assert.equal(core.report.turns[1].images[0].ok, true);
});

test("CU_DUMP_DIR writes each screenshot of a turn with its window list", () => {
  const dir = mkdtempSync(join(tmpdir(), "fv-dump-"));
  try {
    const core = createFakeVision(
      {
        turns: [
          {
            name: "calib",
            expectPromptContains: "cu-calib",
            steps: [
              { call: "screen_look", input: { goal: "g", apps: ["org.gimp.GIMP"] } },
              { call: "screen_look", input: {} },
              { text: "Done." },
            ],
          },
        ],
      },
      { env: { CU_DUMP_DIR: dir } },
    );
    const c = conversation(core, "cu-calib: dump");
    let r = c.ask();
    c.add(called("screen_look", r.call.arguments), ...lookResult([GIMP]));
    r = c.ask();
    c.add(called("screen_look", r.call.arguments), ...lookResult([GIMP, DIALOG]));
    c.ask();
    const files = readdirSync(dir).sort();
    assert.equal(files.filter((f) => f.endsWith(".png")).length, 2);
    assert.ok(files.every((f) => f.startsWith("calib-")));
    const first = files.find((f) => f.endsWith(".png"));
    assert.equal(decodePng(readFileSync(join(dir, first))).width, 100);
    const windows = JSON.parse(readFileSync(join(dir, first.replace(/png$/, "json")), "utf8"));
    assert.equal(windows[0].title, GIMP.title);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolves targets from every corner of a window", () => {
  const w = { ...GIMP, x: 10, y: 20, w: 100, h: 50 };
  assert.deepEqual(resolveTarget({ window: "GIMP", from: "top-left", inset: [3, 4] }, [w]), {
    x: 13,
    y: 24,
  });
  assert.deepEqual(resolveTarget({ window: "GIMP", from: "top-right", inset: [3, 4] }, [w]), {
    x: 107,
    y: 24,
  });
  assert.deepEqual(resolveTarget({ window: "GIMP", from: "bottom-left", inset: [3, 4] }, [w]), {
    x: 13,
    y: 66,
  });
  assert.deepEqual(resolveTarget({ window: "GIMP", from: "bottom-right", inset: [3, 4] }, [w]), {
    x: 107,
    y: 66,
  });
});

test("a turn survives jarvisd trimming older prompts from the history mid-turn", () => {
  const core = createFakeVision({
    turns: [
      {
        name: "t",
        expectPromptContains: "cu-t",
        steps: [
          { call: "screen_look", input: { goal: "g", apps: ["org.gimp.GIMP"] } },
          { call: "screen_look", input: {} },
          { call: "screen_done", input: { summary: "s" } },
          { text: "Done." },
        ],
      },
    ],
  });
  const history = [
    { role: "user", content: "an earlier request" },
    { role: "assistant", content: "earlier answer" },
  ];
  const messages = [...history, { role: "user", content: "cu-t: go" }];
  const ask = () => core.chat({ messages, tools: SCREEN });
  let r = ask();
  assert.equal(r.call.arguments.goal, "g");
  messages.push(called("screen_look", r.call.arguments), ...lookResult([GIMP]));
  messages.splice(0, history.length); // trimmed
  r = ask();
  assert.deepEqual(r.call, { name: "screen_look", arguments: {} });
  messages.push(called("screen_look", {}), ...lookResult([GIMP]));
  assert.equal(ask().call.name, "screen_done");
  assert.equal(core.report.turns.length, 1);
});
