#!/usr/bin/env node
// cucheck: assertions over fakevision's report and jarvisctl's event log for
// the computer-use GUI tests (v1.1 design §2). Exit 0 when the claim holds,
// 1 with the reasons on stderr, 64 on bad usage.
//
//   cucheck turn REPORT NAME [--images] [--foreign]
//   cucheck no-screen-tools REPORT NAME
//   cucheck looks-below REPORT NAME N
//   cucheck no-leaks REPORT
//   cucheck card LOG begin|consequential [--absent] [--title-has TEXT]
//   cucheck active LOG
//   cucheck paused LOG REASON --since MS [--within MS]
//   cucheck png FILE WIDTH HEIGHT
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readPngInfo } from "./png.mjs";

const lastTurn = (report, name) => [...(report.turns ?? [])].reverse().find((t) => t.name === name);

export function turnProblems(report, name, { images = false, foreign = false } = {}) {
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
  for (const i of turn.images) if (!i.ok) p.push(`screenshot ${i.sha256}: ${i.problems.join("; ")}`);
  if (images && turn.images.length === 0) p.push("no screenshot reached the model");
  if (foreign && !turn.images.some((i) => (i.foreignPixels ?? 0) > 0)) {
    p.push("no screenshot had a non-allowed window in view; the mask was not exercised");
  }
  return p;
}

export function noScreenTools(report, name) {
  const turn = lastTurn(report, name);
  if (turn === undefined) return [`no turn "${name}" reached the model`];
  const screen = turn.toolsOffered.filter((n) => n.startsWith("screen_"));
  return screen.length === 0 ? [] : [`screen tools offered while computer use is off: ${screen.join(", ")}`];
}

export function looksBelow(report, name, n) {
  const turn = lastTurn(report, name);
  if (turn === undefined) return [`no turn "${name}" reached the model`];
  const looks = turn.steps.filter((s) => s.call === "screen_look" && s.result?.received).length;
  return looks < n ? [] : [`${looks} looks reached the model; the stuck loop was not stopped before ${n}`];
}

export function leaks(report) {
  const p = [];
  if ((report.imagesOutsideComputerUse ?? 0) > 0) {
    p.push(`${report.imagesOutsideComputerUse} screenshots reached the model in turns without screen tools`);
  }
  for (const t of report.turns ?? []) for (const i of t.images) if (!i.ok) p.push(`${t.name}: screenshot ${i.sha256}: ${i.problems.join("; ")}`);
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
      images: { type: "boolean" }, foreign: { type: "boolean" }, absent: { type: "boolean" },
      "title-has": { type: "string" }, since: { type: "string" }, within: { type: "string", default: "2000" },
    },
  });
  const [cmd, a, b, c] = positionals;
  const json = (path) => JSON.parse(readFileSync(path, "utf8"));
  const events = (path) => readLog(readFileSync(path, "utf8"));
  let problems;
  try {
    switch (cmd) {
      case "turn": problems = turnProblems(json(a), b, { images: values.images === true, foreign: values.foreign === true }); break;
      case "no-screen-tools": problems = noScreenTools(json(a), b); break;
      case "looks-below": problems = looksBelow(json(a), b, Number(c)); break;
      case "no-leaks": problems = leaks(json(a)); break;
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
