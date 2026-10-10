#!/usr/bin/env node
// jarvisctl: the QEMU smoke tests' scripted client for jarvisd's control
// socket (contracts §3). It runs inside the guest as user "jarvis" with the
// Node that ships in the jarvisd package, from the smoke-assets disk. It is
// never installed in the ISO.
//
//   jarvisctl wait   [--timeout S]
//   jarvisctl prompt --text TEXT [--approve-all | --deny-all] [--timeout S]
//   jarvisctl doctor [--approve-all | --deny-all] [--timeout S]
//   jarvisctl snapshot --locked true|false [--timeout S]
//   jarvisctl locked-confirm --text TEXT [--timeout S]
//   jarvisctl cu --text TEXT [--begin approve|deny] [--consequential approve|deny]
//                [--absent PATH] [--timeout S]          (v1.1 contracts §2)
//   jarvisctl cu-enable --provider ID [--off] [--consent]
//   jarvisctl cu-stop
//   (all take --run-dir DIR; default ~/.config/jarvis/run)
//
// Prints one JSON line per event. Exit status: 0 success, 1 the turn or the
// doctor ended badly, 2 timeout or connection failure, 64 usage.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const PROTOCOL_VERSION = 1;
const PROBE_BUILD = "jarvisctl-probe";
const DEFAULT_STAMP = "/usr/lib/jarvis/daemon/build-stamp.json";
const USAGE =
  "usage: jarvisctl wait|prompt|doctor|snapshot|locked-confirm|cu|cu-enable|cu-stop [--text T]" +
  " [--locked true|false] [--approve-all|--deny-all] [--begin approve|deny] [--consequential approve|deny]" +
  " [--absent PATH] [--provider ID] [--off] [--consent] [--timeout S] [--run-dir D] [--build-stamp F]\n";

export function encodeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(5);
  header.writeUInt32BE(payload.length, 0);
  header[4] = 0;
  return Buffer.concat([header, payload]);
}

export class FrameReader {
  #buffer = Buffer.alloc(0);

  push(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
  }

  *frames() {
    while (this.#buffer.length >= 5) {
      const length = this.#buffer.readUInt32BE(0);
      const kind = this.#buffer[4];
      if (this.#buffer.length < 5 + length) return;
      const payload = this.#buffer.subarray(5, 5 + length);
      this.#buffer = this.#buffer.subarray(5 + length);
      if (kind === 0) yield JSON.parse(payload.toString("utf8"));
    }
  }
}

function proof(secret, label, first, second) {
  return createHmac("sha256", secret).update(label).update(first).update(second).digest();
}

export function defaultRunDirectory(home = homedir()) {
  return join(home, ".config", "jarvis", "run");
}

/** One authenticated connection: resolves {session} or {restartRequired: build}. */
export function openSession({ runDir, build, timeoutMs = 5000 }) {
  const secretText = readFileSync(join(runDir, "control.secret"), "utf8").trim();
  const secret = Buffer.from(secretText, "hex");
  const nonceC = randomBytes(32);
  const socket = connect(join(runDir, "jarvisd.sock"));
  const reader = new FrameReader();
  const pending = new Map();
  const listeners = new Set();
  let nextId = 1;
  let phase = "hello";

  const session = {
    invoke(channel, args) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.write(encodeFrame({ t: "req", id, ch: channel, a: args }));
      });
    },
    onPush(listener) {
      listeners.add(listener);
    },
    close() {
      socket.destroy();
    },
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("the daemon did not finish the handshake"));
    }, timeoutMs);
    const fail = (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };

    socket.on("connect", () => {
      const hello = { t: "hello", v: PROTOCOL_VERSION, build, nonceC: nonceC.toString("hex") };
      socket.write(encodeFrame(hello));
    });
    socket.on("error", fail);
    socket.on("close", () => {
      for (const waiter of pending.values())
        waiter.reject(
          Object.assign(new Error("control connection closed"), { code: "ECONNRESET" }),
        );
      pending.clear();
    });
    socket.on("data", (chunk) => {
      reader.push(chunk);
      for (const message of reader.frames()) {
        if (phase === "hello") {
          if (message.t !== "challenge") {
            fail(new Error(`expected a challenge, got ${message.t}`));
            return;
          }
          const nonceS = Buffer.from(String(message.nonceS), "hex");
          const given = Buffer.from(String(message.proof), "hex");
          const expected = proof(secret, "jarvisd-server", nonceC, nonceS);
          if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
            fail(new Error("the control endpoint did not prove it is jarvisd"));
            return;
          }
          phase = "auth";
          const auth = proof(secret, "jarvisd-client", nonceS, nonceC).toString("hex");
          socket.write(encodeFrame({ t: "auth", proof: auth }));
        } else if (phase === "auth") {
          clearTimeout(timer);
          if (message.t === "welcome") {
            phase = "open";
            resolve({ session });
          } else if (message.t === "restart-required") {
            socket.destroy();
            resolve({ restartRequired: String(message.build) });
          } else {
            fail(new Error(`unexpected ${message.t} before welcome`));
          }
        } else if (message.t === "res" || message.t === "err") {
          const waiter = pending.get(message.id);
          if (waiter === undefined) continue;
          pending.delete(message.id);
          if (message.t === "res") waiter.resolve(message.v);
          else waiter.reject(Object.assign(new Error(message.text), { code: message.code }));
        } else if (message.t === "psh") {
          for (const listener of listeners) listener(message.ch, message.p);
        }
      }
    });
  });
}

/** The build named in build-stamp.json (contracts §6 #6), or null. */
export function readStampBuild(path) {
  try {
    const stamp = JSON.parse(readFileSync(path, "utf8"));
    return typeof stamp?.build === "string" && stamp.build !== "" ? stamp.build : null;
  } catch {
    return null;
  }
}

/** Hello with the stamped build (or a probe); on restart-required, reconnect once. */
export async function connectDaemon({
  runDir = defaultRunDirectory(),
  buildStamp = process.env.JARVIS_BUILD_STAMP ?? DEFAULT_STAMP,
  timeoutMs,
} = {}) {
  const build = readStampBuild(buildStamp) ?? PROBE_BUILD;
  const first = await openSession({ runDir, build, timeoutMs });
  if (first.session) return first.session;
  const second = await openSession({ runDir, build: first.restartRequired, timeoutMs });
  if (second.session) return second.session;
  throw new Error("jarvisd asked for a restart twice");
}

function confirmation(card, decision) {
  const approve = decision === "approve";
  const ticked = approve ? card.items.map((item) => item.itemId) : [];
  return { cardId: card.cardId, approve, ticked, secrets: {} };
}

/** Sends one prompt and answers its cards; resolves when the turn ends. */
export function runPrompt(session, { text, decision, timeoutMs, log = () => {} }) {
  return new Promise((resolve) => {
    let turnId = null;
    const early = [];
    const timer = setTimeout(() => resolve({ code: 2, reason: "timeout" }), timeoutMs);
    const handle = (event) => {
      if (event.type === "card" && event.card.turnId === turnId && decision !== undefined) {
        session
          .invoke("agent:confirm", [confirmation(event.card, decision)])
          .catch((error) => log({ type: "confirm-error", message: error.message }));
      }
      if (event.type === "turn-end" && event.turnId === turnId) {
        clearTimeout(timer);
        resolve({
          code: event.reason === "done" ? 0 : 1,
          reason: event.reason,
          error: event.error,
        });
      }
    };
    session.onPush((channel, payload) => {
      if (channel !== "agent:events") return;
      log(payload);
      if (turnId === null) early.push(payload);
      else handle(payload);
    });
    session.invoke("agent:prompt", [{ text }]).then(
      (result) => {
        turnId = result.turnId;
        for (const event of early.splice(0)) handle(event);
      },
      (error) => {
        clearTimeout(timer);
        resolve({ code: 1, reason: "error", error: error.message });
      },
    );
  });
}

/** Starts the Network doctor, answers its cards; resolves when it is done. */
export function runDoctor(session, { decision, timeoutMs, log = () => {} }) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ code: 2, reason: "timeout" }), timeoutMs);
    const finish = (state) => {
      if (state?.done == null) return;
      clearTimeout(timer);
      resolve({ code: state.done === "fixed" ? 0 : 1, reason: state.done });
    };
    session.onPush((channel, payload) => {
      if (channel === "doctor:state") {
        log({ type: "doctor", state: payload });
        finish(payload);
      } else if (channel === "agent:events") {
        log(payload);
        if (payload.type === "card" && payload.card.turnId === null && decision !== undefined) {
          session
            .invoke("agent:confirm", [confirmation(payload.card, decision)])
            .catch((error) => log({ type: "confirm-error", message: error.message }));
        }
      }
    });
    session.invoke("doctor:start", []).then(
      (state) => {
        log({ type: "doctor", state });
        finish(state);
      },
      (error) => {
        clearTimeout(timer);
        resolve({ code: 1, reason: "error", error: error.message });
      },
    );
  });
}

/** Resolves once a sys:snapshot push has `locked === locked`. jarvisd pushes
 *  every 10 s and on change (M1 §6 #8), so a push missed while connecting is
 *  followed by another. */
export function waitSnapshot(session, { locked, timeoutMs, log = () => {} }) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ code: 2, reason: "timeout" }), timeoutMs);
    session.onPush((channel, payload) => {
      if (channel !== "sys:snapshot") return;
      log({ type: "snapshot", locked: payload?.locked, voice: payload?.voice });
      if (payload?.locked === locked) {
        clearTimeout(timer);
        resolve({ code: 0, reason: `locked=${locked}` });
      }
    });
  });
}

/** M3 contracts §2: while locked, jarvisd refuses agent:confirm with code
 *  "locked". Sends a prompt, approves its card, and passes only on that refusal. */
export function runLockedConfirm(session, { text, timeoutMs, log = () => {} }) {
  return new Promise((resolve) => {
    let turnId = null;
    const early = [];
    const timer = setTimeout(() => resolve({ code: 2, reason: "timeout" }), timeoutMs);
    const handle = (event) => {
      if (event.type !== "card" || event.card.turnId !== turnId) return;
      session.invoke("agent:confirm", [confirmation(event.card, "approve")]).then(
        () => {
          clearTimeout(timer);
          resolve({ code: 1, reason: "confirm-accepted-while-locked" });
        },
        (error) => {
          clearTimeout(timer);
          resolve(
            error.code === "locked"
              ? { code: 0, reason: "locked" }
              : { code: 1, reason: "error", error: `${error.code}: ${error.message}` },
          );
        },
      );
    };
    session.onPush((channel, payload) => {
      if (channel !== "agent:events") return;
      log(payload);
      if (turnId === null) early.push(payload);
      else handle(payload);
    });
    session.invoke("agent:prompt", [{ text }]).then(
      (result) => {
        turnId = result.turnId;
        for (const event of early.splice(0)) handle(event);
      },
      (error) => {
        clearTimeout(timer);
        resolve({ code: 1, reason: "error", error: error.message });
      },
    );
  });
}

/** v1.1 contracts §2: the session card carries a `cu.begin` item; a
 *  consequential card carries only screen.* items. */
export function cardKind(card) {
  const tools = (card.items ?? []).map((item) => String(item.tool ?? ""));
  if (tools.includes("cu.begin")) return "begin";
  if (tools.length > 0 && tools.every((tool) => tool.startsWith("screen."))) return "consequential";
  return "other";
}

/** One computer-use turn: answers the session card and consequential cards as
 *  told, denies any other card of the turn, and logs every cu:state push with
 *  the wall-clock time it arrived. With absentPath, records whether that file
 *  already existed when the consequential card arrived (Review Focus 4). */
export function runComputerUse(
  session,
  {
    text,
    begin = "approve",
    consequential = "approve",
    absentPath,
    timeoutMs,
    log = () => {},
    wall = () => Date.now(),
    exists = existsSync,
  },
) {
  const started = wall();
  return new Promise((resolve) => {
    let turnId = null;
    const early = [];
    const cards = [];
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ code: 2, reason: "timeout", cards }), timeoutMs);
    const handle = (event) => {
      if (finished) return;
      if (event.type === "card") {
        const kind = cardKind(event.card);
        const mine =
          event.card.turnId === turnId || (event.card.turnId === null && kind !== "other");
        if (!mine) return;
        const decision =
          kind === "begin" ? begin : kind === "consequential" ? consequential : "deny";
        const entry = {
          type: "cu-card",
          kind,
          decision,
          wall: wall(),
          titles: event.card.items.map((item) => item.title),
        };
        if (kind === "consequential" && absentPath !== undefined)
          entry.pathExisted = exists(absentPath);
        cards.push(entry);
        log(entry);
        session
          .invoke("agent:confirm", [confirmation(event.card, decision)])
          .catch((error) => log({ type: "confirm-error", message: error.message }));
      }
      if (event.type === "turn-end" && event.turnId === turnId) {
        finish({
          code: event.reason === "done" ? 0 : 1,
          reason: event.reason,
          error: event.error,
          cards,
        });
      }
    };
    session.onPush((channel, payload) => {
      if (finished) return;
      if (channel === "cu:state") {
        log({ type: "cu-state", wall: wall(), ...payload });
        return;
      }
      if (channel !== "agent:events") return;
      log(payload);
      if (turnId === null) early.push(payload);
      else handle(payload);
    });
    log({ type: "cu-start", wall: started });
    session.invoke("agent:prompt", [{ text }]).then(
      (result) => {
        if (finished) return;
        turnId = result.turnId;
        for (const event of early.splice(0)) handle(event);
      },
      (error) => {
        const disconnected = ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ENOTCONN"].includes(
          error.code,
        );
        finish({
          code: disconnected ? 2 : 1,
          reason: disconnected ? "connect" : "error",
          error: error.message,
          cards,
        });
      },
    );
  });
}

export async function setComputerUse(session, { providerId, enabled, consent = false }) {
  await session.invoke("cu:setEnabled", [{ providerId, enabled }]);
  if (consent) await session.invoke("cu:consent", [{ providerId }]);
  return { code: 0, reason: enabled ? "enabled" : "disabled" };
}

export async function stopComputerUse(session) {
  await session.invoke("cu:stop", []);
  return { code: 0, reason: "stopped" };
}

/** Retries until the daemon answers provider:list. */
export async function waitForDaemon({ runDir, buildStamp, timeoutMs, log = () => {} }) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "never tried";
  while (Date.now() < deadline) {
    try {
      const session = await connectDaemon({ runDir, buildStamp });
      const providers = await session.invoke("provider:list", []);
      log({ type: "ready", providers });
      session.close();
      return { code: 0, reason: "ready" };
    } catch (error) {
      lastError = error.message;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return { code: 2, reason: "timeout", error: lastError };
}

export async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      text: { type: "string" },
      "approve-all": { type: "boolean" },
      "deny-all": { type: "boolean" },
      timeout: { type: "string", default: "300" },
      "run-dir": { type: "string" },
      "build-stamp": { type: "string" },
      locked: { type: "string" },
      begin: { type: "string", default: "approve" },
      consequential: { type: "string", default: "approve" },
      absent: { type: "string" },
      provider: { type: "string" },
      off: { type: "boolean" },
      consent: { type: "boolean" },
    },
  });
  const command = positionals[0];
  const timeoutMs = Number(values.timeout) * 1000;
  const runDir = values["run-dir"] ?? defaultRunDirectory();
  const buildStamp = values["build-stamp"];
  let decision;
  if (values["approve-all"]) decision = "approve";
  if (values["deny-all"]) decision = "deny";
  const log = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

  const known = [
    "wait",
    "prompt",
    "doctor",
    "snapshot",
    "locked-confirm",
    "cu",
    "cu-enable",
    "cu-stop",
  ].includes(command);
  const lockedArg = values.locked === "true" ? true : values.locked === "false" ? false : undefined;
  const answer = (v) => v === "approve" || v === "deny";
  if (
    !known ||
    !Number.isFinite(timeoutMs) ||
    ((command === "prompt" || command === "locked-confirm" || command === "cu") && !values.text) ||
    (command === "snapshot" && lockedArg === undefined) ||
    (command === "cu-enable" && !values.provider) ||
    (command === "cu" && (!answer(values.begin) || !answer(values.consequential)))
  ) {
    process.stderr.write(USAGE);
    return 64;
  }
  if (command === "wait") {
    const result = await waitForDaemon({ runDir, buildStamp, timeoutMs, log });
    log({ type: "result", ...result });
    return result.code;
  }
  let session;
  try {
    session = await connectDaemon({ runDir, buildStamp });
  } catch (error) {
    log({ type: "result", code: 2, reason: "connect", error: error.message });
    return 2;
  }
  let result;
  try {
    if (command === "cu") {
      result = await runComputerUse(session, {
        text: values.text,
        begin: values.begin,
        consequential: values.consequential,
        absentPath: values.absent,
        timeoutMs,
        log,
      });
    } else if (command === "cu-enable") {
      result = await setComputerUse(session, {
        providerId: values.provider,
        enabled: values.off !== true,
        consent: values.consent === true,
      });
    } else if (command === "cu-stop") {
      result = await stopComputerUse(session);
    } else if (command === "prompt") {
      result = await runPrompt(session, { text: values.text, decision, timeoutMs, log });
    } else if (command === "doctor") {
      result = await runDoctor(session, { decision, timeoutMs, log });
    } else if (command === "snapshot") {
      result = await waitSnapshot(session, { locked: lockedArg, timeoutMs, log });
    } else {
      result = await runLockedConfirm(session, { text: values.text, timeoutMs, log });
    }
  } catch (error) {
    result = { code: 1, reason: "error", error: `${error.code ?? ""} ${error.message}`.trim() };
  }
  log({ type: "result", ...result });
  session.close();
  return result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error.stack}\n`);
      process.exitCode = 2;
    },
  );
}
