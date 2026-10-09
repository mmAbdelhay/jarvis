import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cardProblems, isActive, leaks, looksBelow, noScreenTools, pausedProblems, pngProblems, readLog, turnProblems,
} from "./cucheck.mjs";
import { encodePng } from "./png.mjs";

const okImage = { sha256: "a", ok: true, problems: [], leakedPixels: 0, foreignPixels: 12 };
const report = {
  imagesOutsideComputerUse: 0,
  unexpected: [],
  turns: [
    { name: "probe", toolsOffered: ["screen_look", "screen_click"], images: [okImage], steps: [
      { index: 0, call: "screen_look", result: { received: true, error: null } },
      { index: 1, call: "screen_click", expectError: ["outside"], pass: true, result: { received: true, error: "outside" } },
    ] },
    { name: "off", toolsOffered: ["pkg_search"], images: [], steps: [] },
    { name: "stuck", toolsOffered: ["screen_look"], images: [], steps: [
      { call: "screen_look", result: { received: true } }, { call: "screen_look", result: { received: true } },
      { call: "screen_look", result: { received: false } },
    ] },
  ],
};

test("turn: a clean turn passes and every failure is named", () => {
  assert.deepEqual(turnProblems(report, "probe", { images: true, foreign: true }), []);
  assert.match(turnProblems(report, "nope").join(), /no turn "nope"/);
  const bad = structuredClone(report);
  bad.turns[0].steps[1].pass = false;
  bad.turns[0].steps[1].result.error = null;
  bad.turns[0].images[0] = { ...okImage, ok: false, problems: ["3 pixels outside"], foreignPixels: 0 };
  bad.turns[0].steps.push({ index: 2, call: "screen_click", problem: "no click target" });
  const p = turnProblems(bad, "probe", { images: true, foreign: true }).join("\n");
  assert.match(p, /expected outside, got success/);
  assert.match(p, /3 pixels outside/);
  assert.match(p, /no click target/);
  assert.match(p, /mask was not exercised/);
  assert.match(turnProblems(report, "off", { images: true }).join(), /no screenshot/);
});

test("no-screen-tools, looks-below and no-leaks", () => {
  assert.deepEqual(noScreenTools(report, "off"), []);
  assert.match(noScreenTools(report, "probe").join(), /screen_look, screen_click/);
  assert.deepEqual(looksBelow(report, "stuck", 7), []);
  assert.match(looksBelow(report, "stuck", 2).join(), /2 looks/);
  assert.deepEqual(leaks(report), []);
  assert.match(leaks({ ...report, imagesOutsideComputerUse: 1 }).join(), /without screen tools/);
});

test("card: one begin card titled 'Let Jarvis use', the consequential card before the file", () => {
  const log = [
    { type: "cu-card", kind: "begin", titles: ["Let Jarvis use GIMP to: cu-probe: look"] },
    { type: "cu-card", kind: "consequential", titles: ["Click Export"], pathExisted: false },
  ];
  assert.deepEqual(cardProblems(log, "begin", { titleHas: "cu-probe" }), []);
  assert.deepEqual(cardProblems(log, "consequential", { absent: true }), []);
  assert.match(cardProblems([log[0], log[0]], "begin").join(), /2 session cards/);
  assert.match(cardProblems([{ ...log[0], titles: ["Allow?"] }], "begin").join(), /Let Jarvis use/);
  assert.match(cardProblems([{ ...log[1], pathExisted: true }], "consequential", { absent: true }).join(), /already existed/);
  assert.match(cardProblems([], "consequential").join(), /no consequential card/);
});

test("paused: the right reason, after the event, within the limit", () => {
  const log = [
    { type: "cu-state", wall: 900, active: true, paused: null },
    { type: "cu-state", wall: 1500, active: true, paused: "physical-input" },
  ];
  assert.deepEqual(pausedProblems(log, "physical-input", 1000, 2000), []);
  assert.match(pausedProblems(log, "physical-input", 1000, 100).join(), /500 ms/);
  assert.match(pausedProblems(log, "locked", 1000, 2000).join(), /no cu:state/);
  assert.deepEqual(pausedProblems([{ type: "cu-state", wall: 1200, active: false, paused: null }], "locked", 1000, 2000), []);
  assert.equal(isActive(log), true);
  assert.equal(isActive([{ type: "cu-state", active: false }]), false);
});

test("readLog keeps JSON objects only", () => {
  assert.deepEqual(readLog('{"a":1}\nnoise\n3\nnull\n'), [{ a: 1 }]);
});

test("png: checks the exported size", () => {
  assert.deepEqual(pngProblems(encodePng(640, 480, () => [0, 0, 0]), 640, 480), []);
  assert.match(pngProblems(encodePng(2, 2, () => [0, 0, 0]), 640, 480).join(), /2x2/);
  assert.match(pngProblems(Buffer.from("x".repeat(40)), 1, 1).join(), /not a PNG/);
});
