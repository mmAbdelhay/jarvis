#!/usr/bin/env node
// cucheck: assertions over fakevision's report and jarvisctl's event log for
// the computer-use GUI tests (v1.1 design §2). Exit 0 when the claim holds,
// 1 with the reasons on stderr, 64 on bad usage.
//
//   cucheck turn REPORT NAME [--images] [--evidence]
//   cucheck no-screen-tools REPORT NAME
//   cucheck looks-below REPORT NAME N
//   cucheck step REPORT NAME N
//   cucheck no-leaks REPORT [--min-verified N]
//   cucheck card LOG begin|consequential [--absent] [--title-has TEXT]
//   cucheck active LOG
//   cucheck paused LOG REASON --since MS [--within MS]
//   cucheck png FILE WIDTH HEIGHT
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readPngInfo } from "./png.mjs";

// Contracts U-1: an ordinary fullscreen capture has a frame-covering allowed rectangle,
// so the mask cannot see a leak. fakevision records that as vacuous:true, ok:false with
// no leaked pixels. That is missing privacy evidence: neither a leak nor a pass.
export const missingEvidence = (i) =>
  i.ok !== true && i.vacuous === true && (i.leakedPixels ?? 0) === 0 &&
  (i.problems ?? []).every((p) => /cannot detect a leak/.test(p));
// Evidence = the mask really ran: ok, and either not vacuous (all-black) or a verified fixture.
export const hasEvidence = (i) => i.ok === true && (i.vacuous !== true || i.maskMode === "fixture");

const lastTurn = (report, name) => [...(report.turns ?? [])].reverse().find((t) => t.name === name);

export function turnProblems(report, name, { images = false, evidence = false } = {}) {
  const turn = lastTurn(report, name);
  if (turn === undefined) return [`no turn "${name}" reached the model`];
  const p = [];
  for (const s of turn.steps) {
    if (s.problem) p.push(`step ${s.index} ${s.call}: ${s.problem}`);
    if (s.expectError && s.pass !== true) {
      const got = s.result?.error ?? (s.result?.received ? "success" : "no result");
      p.push(`step ${s.index} ${s.call}: expected ${s.expectError.join("|")}, got ${got}`);
    }
  }
  for (const i of turn.images) if (!i.ok && !missingEvidence(i)) p.push(`screenshot ${i.sha256}: ${i.problems.join("; ")}`);
  if (images && turn.images.length === 0) p.push("no screenshot reached the model");
  if (evidence && !turn.images.some(hasEvidence)) {
    p.push("no screenshot gave privacy evidence (every one was vacuous: the allowed window covered the frame); use an all-black or fixture capture");
  }
  return p;
}

export function noScreenTools(report, name) {
  const turn = lastTurn(report, name);
  if (turn === undefined) return [`no turn "${name}" reached the model`];
  const screen = turn.toolsOffered.filter((n) => n.startsWith("screen_"));
  return screen.length === 0 ? [] : [`screen tools offered while computer use is off: ${screen.join(", ")}`];
}

// A look "reached the model" when it came back without an error: merged V answers the
// stuck look and every later one with a refusal (no screenshot), which fakevision still
// records as received. The script must also issue at least n looks, or the bound is vacuous.
export function looksBelow(report, name, n) {
  const turn = lastTurn(report, name);
  if (turn === undefined) return [`no turn "${name}" reached the model`];
  const issued = turn.steps.filter((s) => s.call === "screen_look").length;
  const looks = turn.steps.filter((s) => s.call === "screen_look" && s.result?.received && s.result.error === null).length;
  const p = looks < n ? [] : [`${looks} looks reached the model; the stuck loop was not stopped before ${n}`];
  if (issued < n) p.push(`only ${issued} looks were issued; the script must try at least ${n}`);
  return p;
}

/** The model has issued step index n of the turn (fakevision saves the report before a held reply). */
export function stepIssued(report, name, n) {
  const turn = lastTurn(report, name);
  if (turn === undefined) return [`no turn "${name}" reached the model`];
  return turn.steps.length > n ? [] : [`turn "${name}" has issued ${turn.steps.length} steps, waiting for step ${n}`];
}

/** minVerified: at least that many screenshots must really have been checked (hasEvidence);
 * vacuous captures (U-1: the allowed rectangle is the whole frame) skip the leak test and do not count. */
export function leaks(report, { minVerified = 0 } = {}) {
  const p = [];
  const verified = (report.turns ?? []).reduce((n, t) => n + t.images.filter(hasEvidence).length, 0);
  if (verified < minVerified) {
    p.push(`${verified} screenshots were really checked for leaks, expected at least ${minVerified} (vacuous captures prove nothing)`);
  }
  if ((report.imagesOutsideComputerUse ?? 0) > 0) {
    p.push(`${report.imagesOutsideComputerUse} screenshots reached the model in turns without screen tools`);
  }
  for (const t of report.turns ?? []) for (const i of t.images) if (!i.ok && !missingEvidence(i)) p.push(`${t.name}: screenshot ${i.sha256}: ${i.problems.join("; ")}`);
  return p;
}

export function readLog(text) {
  return text.split("\n").flatMap((line) => {
    try {
      const v = JSON.parse(line);
      return v !== null && typeof v === "object" ? [v] : [];
    } catch {
      return [];
    }
  });
}

export function cardProblems(events, kind, { absent = false, titleHas } = {}) {
  const cards = events.filter((e) => e.type === "cu-card" && e.kind === kind);
  if (cards.length === 0) return [`no ${kind} card`];
  const p = [];
  if (kind === "begin") {
    if (cards.length !== 1) p.push(`${cards.length} session cards; criterion 4 wants exactly one`);
    if (!cards[0].titles.some((t) => t.startsWith("Let Jarvis use"))) {
      p.push(`session card title is not "Let Jarvis use …": ${cards[0].titles.join(" | ")}`);
    }
  }
  if (titleHas !== undefined && !cards.some((c) => c.titles.some((t) => t.includes(titleHas)))) {
    p.push(`no ${kind} card title contains "${titleHas}"`);
  }
  if (absent && !cards.some((c) => c.pathExisted === false)) p.push(`the ${kind} card came after the file already existed`);
  return p;
}

export const isActive = (events) => events.some((e) => e.type === "cu-state" && e.active === true);

export function pausedProblems(events, reason, since, within) {
  const hit = events.find((e) => e.type === "cu-state" && typeof e.wall === "number" && e.wall >= since &&
    (e.paused === reason || (reason === "locked" && e.active === false)));
  if (hit === undefined) return [`no cu:state with paused "${reason}" after ${since}`];
  return hit.wall - since <= within ? [] : [`paused after ${hit.wall - since} ms (limit ${within} ms)`];
}

export function pngProblems(buffer, width, height) {
  try {
    const info = readPngInfo(buffer);
    return info.width === width && info.height === height ? [] : [`PNG is ${info.width}x${info.height}, expected ${width}x${height}`];
  } catch (error) {
    return [error.message];
  }
}

export function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      images: { type: "boolean" }, evidence: { type: "boolean" }, absent: { type: "boolean" },
      "title-has": { type: "string" }, "min-verified": { type: "string", default: "0" }, since: { type: "string" }, within: { type: "string", default: "2000" },
    },
  });
  const [cmd, a, b, c] = positionals;
  const json = (path) => JSON.parse(readFileSync(path, "utf8"));
  const events = (path) => readLog(readFileSync(path, "utf8"));
  let problems;
  try {
    switch (cmd) {
      case "turn": problems = turnProblems(json(a), b, { images: values.images === true, evidence: values.evidence === true }); break;
      case "no-screen-tools": problems = noScreenTools(json(a), b); break;
      case "looks-below": problems = looksBelow(json(a), b, Number(c)); break;
      case "step": problems = stepIssued(json(a), b, Number(c)); break;
      case "no-leaks": problems = leaks(json(a), { minVerified: Number(values["min-verified"]) }); break;
      case "card": problems = cardProblems(events(a), b, { absent: values.absent === true, titleHas: values["title-has"] }); break;
      case "active": problems = isActive(events(a)) ? [] : ["no cu:state with active true"]; break;
      case "paused": problems = pausedProblems(events(a), b, Number(values.since), Number(values.within)); break;
      case "png": problems = pngProblems(readFileSync(a), Number(b), Number(c)); break;
      default:
        process.stderr.write("usage: see the header of cucheck.mjs\n");
        return 64;
    }
  } catch (error) {
    problems = [error.message];
  }
  for (const p of problems) process.stderr.write(`cucheck ${cmd}: ${p}\n`);
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2));
