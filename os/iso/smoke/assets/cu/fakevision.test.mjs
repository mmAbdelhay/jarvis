import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createFakeVision, createServerFor, errorCode, isDenied, resolveTarget, resultBody, substitute,
} from "./fakevision.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decodePng, encodePng } from "./png.mjs";

const GIMP = { windowId: "w1", appId: "org.gimp.GIMP", title: "beach.xcf – GIMP", x: 40, y: 0, w: 60, h: 60, focused: true, allowed: true };
const TERM = { windowId: "w2", appId: "foot", title: "cu-secret-terminal", x: 0, y: 0, w: 30, h: 30, focused: false, allowed: false };
const DIALOG = { windowId: "w3", appId: "org.gimp.GIMP", title: "Export Image as PNG", x: 50, y: 10, w: 40, h: 30, focused: true, allowed: true };
const SCREEN = ["screen_look", "screen_click", "screen_key", "screen_type", "screen_done"]
  .map((name) => ({ type: "function", function: { name } }));
const masked = (windows) => encodePng(100, 60, (x, y) =>
  windows.some((w) => w.allowed && x >= w.x && x < w.x + w.w && y >= w.y && y < w.y + w.h) ? [180, 180, 180] : [0, 0, 0]);
const fenced = (tool, value) => `<untrusted-data source="${tool}">\n${JSON.stringify(value)}\n</untrusted-data>`;
const lookResult = (windows, png = masked(windows)) => [
  { role: "tool", tool_name: "screen_look", content: fenced("screen.look", { width: 100, height: 60, scale: 1, windows }) },
  { role: "user", content: "Screenshot of the allowed windows.", images: [png.toString("base64")] },
];
const called = (name, args) => ({ role: "assistant", content: "", tool_calls: [{ function: { name, arguments: args } }] });

/** Drives a core the way jarvisd's tool loop does: one chat request per reply. */
function conversation(core, prompt, tools = SCREEN) {
  const messages = [{ role: "system", content: "You are Jarvis." }, { role: "user", content: prompt }];
  return {
    ask: () => core.chat({ model: "scripted-vision:latest", messages, tools }),
    add: (...more) => messages.push(...more),
  };
}

test("answers the provider probe and tool-less side requests", () => {
  const core = createFakeVision({ turns: [] });
  assert.deepEqual(
    core.chat({ messages: [{ role: "user", content: "Call the ping tool now." }], tools: [{ function: { name: "ping" } }] }),
    { call: { name: "ping", arguments: {} } },
  );
  assert.deepEqual(core.chat({ messages: [{ role: "user", content: "summarise" }] }), { text: "ok" });
});

test("records prompts it has no script for", () => {
  const core = createFakeVision({ turns: [] });
  assert.match(conversation(core, "hello").ask().text, /no script/);
  assert.deepEqual(core.report.unexpected, ["hello"]);
});

test("plays a turn: look, a refused click on the terminal, done; screenshots pass the mask", () => {
  const core = createFakeVision({ turns: [{ name: "probe", expectPromptContains: "cu-probe", steps: [
    { call: "screen_look", input: { goal: "g", apps: ["${GIMP_APP}"] } },
    { call: "screen_click", target: { outside: true }, input: { button: "left" }, expectError: "outside" },
    { text: "Probe finished." },
  ] }] }, { env: { GIMP_APP: "org.gimp.GIMP" } });
  const c = conversation(core, "cu-probe: look");
  let r = c.ask();
  assert.deepEqual(r.call, { name: "screen_look", arguments: { goal: "g", apps: ["org.gimp.GIMP"] } });
  c.add(called("screen_look", r.call.arguments), ...lookResult([GIMP, TERM]));
  r = c.ask();
  assert.equal(r.call.name, "screen_click");
  assert.ok(r.call.arguments.x < 30 && r.call.arguments.y < 30, "the click lands on the terminal");
  c.add(called("screen_click", r.call.arguments),
    { role: "tool", tool_name: "screen_click", content: "ERROR: outside: (4, 4) is not inside an allowed window" });
  assert.deepEqual(c.ask(), { text: "Probe finished." });
  const turn = core.report.turns[0];
  assert.equal(turn.steps[1].pass, true);
  assert.equal(turn.images.length, 1);
  assert.equal(turn.images[0].ok, true);
  assert.ok(turn.images[0].foreignPixels > 0);
  assert.equal(turn.finished, true);
});

test("flags a screenshot that shows the terminal", () => {
  const core = createFakeVision({ turns: [{ name: "t", expectPromptContains: "cu-", steps: [
    { call: "screen_look", input: {} }, { text: "done" },
  ] }] });
  const c = conversation(core, "cu-leak");
  const r = c.ask();
  c.add(called("screen_look", r.call.arguments), ...lookResult([GIMP, TERM], encodePng(100, 60, () => [90, 90, 90])));
  c.ask();
  assert.equal(core.report.turns[0].images[0].ok, false);
  assert.ok(core.report.turns[0].images[0].leakedPixels > 0);
});

test("clicks a dialog's bottom-right corner, and branches to onDenied when the user says no", () => {
  const core = createFakeVision({ turns: [{ name: "deny", expectPromptContains: "cu-deny", steps: [
    { call: "screen_look", input: {} },
    { call: "screen_click", target: { window: "Export Image as PNG", from: "bottom-right", inset: [4, 3] },
      input: { button: "left", intent: "save" } },
    { text: "Exported." },
  ], onDenied: [{ call: "screen_key", input: { combo: "Escape" } }, { text: "Stopped." }] }] });
  const c = conversation(core, "cu-deny: export");
  let r = c.ask();
  c.add(called("screen_look", {}), ...lookResult([GIMP, DIALOG, TERM]));
  r = c.ask();
  assert.deepEqual(r.call, { name: "screen_click", arguments: { button: "left", intent: "save", x: 86, y: 37 } });
  c.add(called("screen_click", r.call.arguments), { role: "tool", tool_name: "screen_click", content: "The user denied this action." });
  r = c.ask();
  assert.deepEqual(r.call, { name: "screen_key", arguments: { combo: "Escape" } });
  c.add(called("screen_key", r.call.arguments), { role: "tool", tool_name: "screen_key", content: "{}" });
  assert.deepEqual(c.ask(), { text: "Stopped." });
  assert.equal(core.report.turns[0].denied, true);
});

test("skips onlyIfWindow steps when no window title matches", () => {
  const core = createFakeVision({ turns: [{ name: "t", expectPromptContains: "cu-skip", steps: [
    { call: "screen_look", input: {} },
    { call: "screen_key", input: { combo: "Return" }, onlyIfWindow: "Export Image as PNG" },
    { text: "done" },
  ] }] });
  const c = conversation(core, "cu-skip");
  c.ask();
  c.add(called("screen_look", {}), ...lookResult([GIMP]));
  assert.deepEqual(c.ask(), { text: "done" });
  assert.equal(core.report.turns[0].steps[1].skipped, true);
});

test("a new prompt starts its own turn", () => {
  const core = createFakeVision({ turns: [
    { name: "a", expectPromptContains: "cu-a", steps: [{ text: "A" }] },
    { name: "b", expectPromptContains: "cu-b", steps: [{ text: "B" }] },
  ] });
  const messages = [{ role: "user", content: "cu-a" }];
  assert.deepEqual(core.chat({ messages, tools: SCREEN }), { text: "A" });
  messages.push({ role: "assistant", content: "A" }, { role: "user", content: "cu-b" });
  assert.deepEqual(core.chat({ messages, tools: SCREEN }), { text: "B" });
  assert.deepEqual(core.report.turns.map((t) => t.name), ["a", "b"]);
});

test("counts screenshots sent in a turn without screen tools", () => {
  const core = createFakeVision({ turns: [{ name: "off", expectPromptContains: "cu-off", steps: [{ text: "off" }] }] });
  core.chat({ messages: [{ role: "user", content: "cu-off" }, { role: "user", content: "x", images: [masked([GIMP]).toString("base64")] }],
    tools: [{ function: { name: "pkg_search" } }] });
  assert.equal(core.report.imagesOutsideComputerUse, 1);
  assert.deepEqual(core.report.turns[0].toolsOffered, ["pkg_search"]);
});

test("reads tool results the way jarvisd writes them", () => {
  assert.deepEqual(resultBody(`ERROR: ${fenced("screen.click", { error: { code: "paused" } })}`), { error: { code: "paused" } });
  assert.equal(errorCode("ERROR: excluded: a terminal has focus"), "excluded");
  assert.equal(errorCode(fenced("screen.key", { ok: false, error: { code: "no-session", message: "x" } })), "no-session");
  assert.equal(errorCode(fenced("screen.look", { windows: [] })), null);
  assert.equal(errorCode("ERROR: something odd"), "failed");
  assert.equal(isDenied(fenced("screen.look", { windows: [{ title: "Access denied – Firefox" }] })), false);
  assert.equal(isDenied("The user declined the action."), true);
  assert.deepEqual(substitute({ a: ["${HOME}/x", 3], b: "${NOPE}" }, { HOME: "/home/t" }), { a: ["/home/t/x", 3], b: "" });
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
    const res = await fetch(`${base}/api/chat`, { method: "POST", body: JSON.stringify({
      messages: [{ role: "user", content: "Call the ping tool now." }], tools: [{ type: "function", function: { name: "ping" } }] }) });
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
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
  const core = createFakeVision({ turns: ["a", "b"].map((name) => ({
    name, expectPromptContains: `cu-${name}`, steps: [{ call: "screen_look" }, { text: "done" }],
  })) });
  for (const name of ["a", "b"]) {
    const c = conversation(core, `cu-${name}`);
    c.ask();
    c.add(called("screen_look", {}), ...lookResult([GIMP, TERM]));
    c.ask();
  }
  assert.deepEqual(core.report.turns.map((t) => t.images.length), [1, 1]);
});

test("U-1: fullscreen images fail closed rather than claiming mask evidence", () => {
  const core = createFakeVision({ turns: [{ name: "full", expectPromptContains: "cu-full", steps: [
    { call: "screen_look" }, { text: "done" },
  ] }] });
  const c = conversation(core, "cu-full");
  c.ask();
  c.add(called("screen_look", {}), ...lookResult([{ ...GIMP, x: 0, y: 0, w: 100, h: 60 }]));
  c.ask();
  assert.equal(core.report.turns[0].images[0].vacuous, true);
  assert.equal(core.report.turns[0].images[0].ok, false);
});

test("fixture flows use cu.begin before capture, with explicit blocked export coverage", () => {
  const script = JSON.parse(readFileSync(new URL("./cu-gimp.json", import.meta.url), "utf8"));
  assert.deepEqual(script.turns.map((t) => t.name), ["off", "probe", "deny", "export", "excluded", "stuck", "lock", "physical"]);
  for (const turn of script.turns.filter((t) => t.name !== "off")) {
    assert.equal(turn.steps[0].call, "cu_begin", turn.name);
    assert.ok(turn.steps[0].input.goal);
    assert.deepEqual(turn.steps[0].input.apps, ["${GIMP_APP}"]);
    assert.equal(turn.steps[1].call, "screen_look", turn.name);
    assert.deepEqual(turn.steps[1].input, {});
  }
  assert.ok(script.turns.find((t) => t.name === "deny").steps.some((s) => s.call === "screen_done"));
  assert.match(script.turns.find((t) => t.name === "export").steps.at(-1).text, /blocked/);
});

test("fixture creation accepts quotes in the output directory without evaluating them", () => {
  const root = mkdtempSync(join(tmpdir(), "fv-fixture-"));
  const bin = join(root, "bin");
  const dir = join(root, "beach'\" folder");
  mkdirSync(bin);
  for (const name of ["dirname", "mkdir"]) symlinkSync(name === "mkdir" ? "/bin/mkdir" : "/usr/bin/dirname", join(bin, name));
  try {
    // GIMP is deliberately unavailable; PNG generation must still finish safely.
    const run = spawnSync("/bin/sh", [fileURLToPath(new URL("./make-fixture.sh", import.meta.url)), dir], {
      env: { ...process.env, PATH: bin, JARVIS_NODE: process.execPath }, encoding: "utf8",
    });
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
  const core = createFakeVision({ turns: [{ name: "t", expectPromptContains: "cu-history", steps: [
    { call: "screen_look" }, { call: "screen_look" }, { text: "done" },
  ] }] });
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

test('outside target without an allowed rectangle records a problem instead of clicking', () => {
  assert.equal(resolveTarget({ outside: true }, []), null);
  assert.equal(resolveTarget({ outside: true }, [{ ...TERM, w: 0, h: 0 }]), null);
  const core = createFakeVision({ turns: [{ name: 't', expectPromptContains: 'cu-unknown', steps: [
    { call: 'screen_look' }, { call: 'screen_click', target: { outside: true } }, { text: 'done' },
  ] }] });
  const c = conversation(core, 'cu-unknown');
  c.ask();
  c.add(called('screen_look', {}), { role: 'tool', content: 'Fullscreen GIMP.' },
    { role: 'user', images: [masked([GIMP]).toString('base64')] });
  assert.deepEqual(c.ask(), { text: 'done' });
  assert.match(core.report.turns[0].steps[1].problem, /no click target/);
});

test('per-step all-black mode checks repeated bytes again and detects focus leaks', () => {
  const core = createFakeVision({ turns: [{ name: 't', expectPromptContains: 'cu-black', steps: [
    { call: 'screen_look' }, { call: 'screen_look', mask: { mode: 'all-black' } }, { text: 'done' },
  ] }] });
  const c = conversation(core, 'cu-black');
  const full = { ...GIMP, x: 0, y: 0, w: 100, h: 60 };
  c.ask(); c.add(called('screen_look', {}), ...lookResult([full]));
  c.ask(); c.add(called('screen_look', {}), ...lookResult([full])); c.ask();
  const images = core.report.turns[0].images;
  assert.equal(images.length, 2);
  assert.equal(images[1].ok, false);
  assert.ok(images[1].leakedPixels > 0);
});

test('turn all-black mode passes with summary-only screen.look', () => {
  const core = createFakeVision({ turns: [{ name: 't', expectPromptContains: 'cu-black', mask: { mode: 'all-black' },
    steps: [{ call: 'screen_look' }, { text: 'done' }] }] });
  const c = conversation(core, 'cu-black'); c.ask();
  c.add(called('screen_look', {}), { role: 'tool', content: 'Allowed window is not focused.' },
    { role: 'user', images: [encodePng(100, 60, () => [0, 0, 0]).toString('base64')] }); c.ask();
  assert.equal(core.report.turns[0].images[0].ok, true);
});

test('fixture mode proves full-frame pixels and rejects a changed fixture', () => {
  const fixture = masked([{ ...GIMP, x: 0, y: 0, w: 100, h: 60 }]).toString('base64');
  for (const [png, expected] of [[Buffer.from(fixture, 'base64'), true], [encodePng(100, 60, () => [1, 2, 3]), false]]) {
    const core = createFakeVision({ turns: [{ name: 't', expectPromptContains: 'cu-fixture',
      mask: { mode: 'fixture', pngBase64: fixture }, steps: [{ call: 'screen_look' }, { text: 'done' }] }] });
    const c = conversation(core, 'cu-fixture'); c.ask();
    c.add(called('screen_look', {}), ...lookResult([{ ...GIMP, x: 0, y: 0, w: 100, h: 60 }], png)); c.ask();
    assert.equal(core.report.turns[0].images[0].ok, expected);
  }
});

test('U-1 export fixtures explicitly escalate invisible dialogs without claiming an export', () => {
  const script = JSON.parse(readFileSync(new URL('./cu-gimp.json', import.meta.url), 'utf8'));
  assert.match(script.concerns.join('\n'), /U\/V/);
  for (const turn of script.turns.filter(t => ['deny', 'export'].includes(t.name))) {
    assert.ok(!turn.steps.some(s => s.onlyIfWindow || s.target?.window?.includes('Export Image')));
    assert.match(turn.steps.at(-1).text, /blocked/i);
  }
});
