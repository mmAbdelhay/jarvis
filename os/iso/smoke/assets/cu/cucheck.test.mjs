import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cardProblems, hasEvidence, isActive, leaks, missingEvidence, looksBelow, noScreenTools, pausedProblems, pngProblems, readLog, stepIssued, turnProblems,
} from "./cucheck.mjs";
import { encodePng } from "./png.mjs";

const okImage = { sha256: "a", ok: true, problems: [], leakedPixels: 0, foreignPixels: 0, vacuous: false, maskMode: "all-black" };
const vacuousImage = { sha256: "v", ok: false, vacuous: true, leakedPixels: 0, foreignPixels: 0, maskMode: "outside",
  problems: ["the allowed window covers the whole frame, so the mask cannot detect a leak; pass expectAllBlack"] };
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
      { call: "screen_look", result: { received: true, error: null } }, { call: "screen_look", result: { received: true, error: null } },
      { call: "screen_look", result: { received: true, error: "failed" } }, { call: "screen_look", result: { received: true, error: "no-session" } },
      { call: "screen_look", result: { received: false } },
    ] },
  ],
};

test("turn: a clean turn passes and every failure is named", () => {
  assert.deepEqual(turnProblems(report, "probe", { images: true, evidence: true }), []);
  assert.match(turnProblems(report, "nope").join(), /no turn "nope"/);
  const bad = structuredClone(report);
  bad.turns[0].steps[1].pass = false;
  bad.turns[0].steps[1].result.error = null;
  bad.turns[0].images[0] = { ...okImage, ok: false, problems: ["3 pixels outside"], leakedPixels: 3 };
  bad.turns[0].steps.push({ index: 2, call: "screen_click", problem: "no click target" });
  const p = turnProblems(bad, "probe", { images: true, evidence: true }).join("\n");
  assert.match(p, /expected outside, got success/);
  assert.match(p, /3 pixels outside/);
  assert.match(p, /no click target/);
  assert.match(p, /3 pixels outside/);
  assert.match(turnProblems(report, "off", { images: true }).join(), /no screenshot/);
});

test("no-screen-tools, looks-below and no-leaks", () => {
  assert.deepEqual(noScreenTools(report, "off"), []);
  assert.match(noScreenTools(report, "probe").join(), /screen_look, screen_click/);
  // Only looks that returned a screenshot count: merged V answers the stuck look and every
  // later one with a refusal, which fakevision still records as received.
  assert.deepEqual(looksBelow(report, "stuck", 5), []);
  assert.match(looksBelow(report, "stuck", 2).join(), /2 looks/);
  assert.match(looksBelow(report, "stuck", 7).join(), /only 5 looks were issued/);
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

test("vacuous screenshots are missing evidence: not a leak, not a pass", () => {
  assert.equal(missingEvidence(vacuousImage), true);
  assert.equal(missingEvidence({ ...vacuousImage, leakedPixels: 4 }), false);
  assert.equal(missingEvidence({ ...vacuousImage, problems: ["capture is 4000x3000"] }), false);
  assert.equal(hasEvidence(vacuousImage), false);
  assert.equal(hasEvidence(okImage), true);
  const r = { imagesOutsideComputerUse: 0, turns: [{ name: "t", toolsOffered: [], steps: [], images: [vacuousImage] }] };
  assert.deepEqual(turnProblems(r, "t", { images: true }), []);
  assert.deepEqual(leaks(r), []);
  assert.match(turnProblems(r, "t", { images: true, evidence: true }).join(), /no screenshot gave privacy evidence/);
  r.turns[0].images.push(okImage);
  assert.deepEqual(turnProblems(r, "t", { evidence: true }), []);
  r.turns[0].images.push({ ...okImage, ok: false, leakedPixels: 9, problems: ["9 pixels outside"] });
  assert.match(leaks(r).join(), /9 pixels outside/);
});

test("step: the model has issued a turn's step N (harness synchronisation)", () => {
  assert.deepEqual(stepIssued(report, "stuck", 4), []);
  assert.match(stepIssued(report, "stuck", 5).join(), /has issued 5 steps/);
  assert.match(stepIssued(report, "nope", 0).join(), /no turn "nope"/);
});
