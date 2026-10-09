import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  connectDaemon,
  encodeFrame,
  FrameReader,
  openSession,
  runDoctor,
  runLockedConfirm,
  runPrompt,
  waitSnapshot,
} from "./jarvisctl.mjs";

const BUILD = "0.1.0+test.1";

function proof(secret, label, first, second) {
  return createHmac("sha256", secret).update(label).update(first).update(second).digest("hex");
}

/** jarvisd's control server in miniature: the real handshake, scripted channels. */
async function fakeDaemon({ handlers = {}, proofSecret, onOpen } = {}) {
  const runDir = mkdtempSync(join(tmpdir(), "jctl-"));
  const secret = randomBytes(32);
  writeFileSync(join(runDir, "control.secret"), `${secret.toString("hex")}\n`);
  const hellos = [];
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const reader = new FrameReader();
    const send = (value) => socket.write(encodeFrame(value));
    const push = (ch, p) => send({ t: "psh", ch, p, seq: 0 });
    let phase = "hello";
    let nonceC;
    let nonceS;
    let build;
    socket.on("data", (chunk) => {
      reader.push(chunk);
      for (const message of reader.frames()) {
        if (phase === "hello") {
          hellos.push(message);
          build = message.build;
          nonceC = Buffer.from(message.nonceC, "hex");
          nonceS = randomBytes(32);
          const serverProof = proof(proofSecret ?? secret, "jarvisd-server", nonceC, nonceS);
          send({ t: "challenge", nonceS: nonceS.toString("hex"), proof: serverProof });
          phase = "auth";
        } else if (phase === "auth") {
          assert.equal(message.proof, proof(secret, "jarvisd-client", nonceS, nonceC));
          if (build !== BUILD) {
            send({ t: "restart-required", build: BUILD });
            socket.end();
            return;
          }
          send({ t: "welcome", v: 1, capabilities: [] });
          if (onOpen) setTimeout(() => onOpen(push), 50);
          phase = "open";
        } else {
          const reply = (v) => send({ t: "res", id: message.id, v });
          const fail = (code, text) => send({ t: "err", id: message.id, code, text });
          const handler = handlers[message.ch];
          if (handler) handler(message.a, { reply, push, fail });
          else reply(null);
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(join(runDir, "jarvisd.sock"), resolve));
  return {
    runDir,
    hellos,
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
      rmSync(runDir, { recursive: true, force: true });
    },
  };
}

const card = (cardId, turnId) => ({
  cardId,
  turnId,
  expiresAt: 0,
  items: [{ itemId: "i1" }, { itemId: "i2" }],
});

/** A prompt handler that pushes a card BEFORE replying, then ends the turn on confirm. */
function promptScript(confirmed, { reason = "done", extraCard } = {}) {
  return {
    "agent:prompt": (args, { reply, push }) => {
      push("agent:events", { type: "turn-start", turnId: "t1", text: args[0].text });
      if (extraCard) push("agent:events", { type: "card", card: extraCard });
      push("agent:events", { type: "card", card: card("c1", "t1") });
      reply({ turnId: "t1" });
    },
    "agent:confirm": (args, { reply, push }) => {
      confirmed.push(args[0]);
      reply(null);
      push("agent:events", { type: "turn-end", turnId: "t1", reason });
    },
  };
}

test("uses the build stamp beside the bundle when there is one", async () => {
  const daemon = await fakeDaemon();
  const buildStamp = join(daemon.runDir, "build-stamp.json");
  writeFileSync(buildStamp, JSON.stringify({ build: BUILD }));
  const session = await connectDaemon({ runDir: daemon.runDir, buildStamp });
  assert.deepEqual(
    daemon.hellos.map((hello) => hello.build),
    [BUILD],
  );
  session.close();
  daemon.close();
});

test("a stale stamp reconnects once with the build the daemon names", async () => {
  const daemon = await fakeDaemon();
  const buildStamp = join(daemon.runDir, "build-stamp.json");
  writeFileSync(buildStamp, JSON.stringify({ build: "old" }));
  const session = await connectDaemon({ runDir: daemon.runDir, buildStamp });
  assert.deepEqual(
    daemon.hellos.map((hello) => hello.build),
    ["old", BUILD],
  );
  session.close();
  daemon.close();
});

test("without a stamp, learns the build from restart-required", async () => {
  const daemon = await fakeDaemon();
  const session = await connectDaemon({ runDir: daemon.runDir, buildStamp: "/nonexistent" });
  assert.deepEqual(
    daemon.hellos.map((hello) => hello.build),
    ["jarvisctl-probe", BUILD],
  );
  session.close();
  daemon.close();
});

test("refuses an endpoint that cannot prove the secret", async () => {
  const daemon = await fakeDaemon({ proofSecret: randomBytes(32) });
  await assert.rejects(openSession({ runDir: daemon.runDir, build: BUILD }), /did not prove/);
  daemon.close();
});

test("approve-all ticks every item, even when the card beats the prompt's reply", async () => {
  const confirmed = [];
  const daemon = await fakeDaemon({ handlers: promptScript(confirmed) });
  const session = await connectDaemon({ runDir: daemon.runDir, buildStamp: "/nonexistent" });
  const result = await runPrompt(session, {
    text: "install hello",
    decision: "approve",
    timeoutMs: 5000,
  });
  assert.equal(result.code, 0);
  assert.deepEqual(confirmed, [{ cardId: "c1", approve: true, ticked: ["i1", "i2"], secrets: {} }]);
  session.close();
  daemon.close();
});

test("deny-all approves nothing", async () => {
  const confirmed = [];
  const daemon = await fakeDaemon({ handlers: promptScript(confirmed) });
  const session = await connectDaemon({ runDir: daemon.runDir, buildStamp: "/nonexistent" });
  await runPrompt(session, { text: "install hello", decision: "deny", timeoutMs: 5000 });
  assert.deepEqual(confirmed, [{ cardId: "c1", approve: false, ticked: [], secrets: {} }]);
  session.close();
  daemon.close();
});

test("ignores cards that belong to another turn", async () => {
  const confirmed = [];
  const handlers = promptScript(confirmed, { extraCard: card("doctor-card", null) });
  const daemon = await fakeDaemon({ handlers });
  const session = await connectDaemon({ runDir: daemon.runDir, buildStamp: "/nonexistent" });
  await runPrompt(session, { text: "x", decision: "approve", timeoutMs: 5000 });
  assert.deepEqual(
    confirmed.map((c) => c.cardId),
    ["c1"],
  );
  session.close();
  daemon.close();
});

test("a turn that hits the step limit is a failure", async () => {
  const daemon = await fakeDaemon({ handlers: promptScript([], { reason: "step-limit" }) });
  const session = await connectDaemon({ runDir: daemon.runDir, buildStamp: "/nonexistent" });
  const result = await runPrompt(session, { text: "x", decision: "approve", timeoutMs: 5000 });
  assert.equal(result.code, 1);
  assert.equal(result.reason, "step-limit");
  session.close();
  daemon.close();
});

test("a turn that never ends times out", async () => {
  const daemon = await fakeDaemon({
    handlers: { "agent:prompt": (_args, { reply }) => reply({ turnId: "t1" }) },
  });
  const session = await connectDaemon({ runDir: daemon.runDir, buildStamp: "/nonexistent" });
  const result = await runPrompt(session, { text: "x", decision: "approve", timeoutMs: 200 });
  assert.equal(result.code, 2);
  session.close();
  daemon.close();
});

test("doctor approves its null-turn card and succeeds when the doctor fixes it", async () => {
  const confirmed = [];
  const idle = { active: true, steps: [], networks: [], done: null };
  const daemon = await fakeDaemon({
    handlers: {
      "doctor:start": (_args, { reply, push }) => {
        reply(idle);
        push("agent:events", { type: "card", card: card("d1", null) });
      },
      "agent:confirm": (args, { reply, push }) => {
        confirmed.push(args[0]);
        reply(null);
        push("doctor:state", { ...idle, active: false, done: "fixed" });
      },
    },
  });
  const session = await connectDaemon({ runDir: daemon.runDir, buildStamp: "/nonexistent" });
  const result = await runDoctor(session, { decision: "approve", timeoutMs: 5000 });
  assert.equal(result.code, 0);
  assert.deepEqual(
    confirmed.map((c) => c.cardId),
    ["d1"],
  );
  session.close();
  daemon.close();
});

test("snapshot waits for the asked locked state", async () => {
  const daemon = await fakeDaemon({
    onOpen: (push) => {
      push("sys:snapshot", { locked: false });
      setTimeout(() => push("sys:snapshot", { locked: true }), 50);
    },
  });
  const session = await connectDaemon({ runDir: daemon.runDir, buildStamp: "/nonexistent" });
  const result = await waitSnapshot(session, { locked: true, timeoutMs: 3000 });
  assert.equal(result.code, 0);
  session.close();
  daemon.close();
});

test("snapshot times out when the state never comes", async () => {
  const daemon = await fakeDaemon({ onOpen: (push) => push("sys:snapshot", { locked: false }) });
  const session = await connectDaemon({ runDir: daemon.runDir, buildStamp: "/nonexistent" });
  const result = await waitSnapshot(session, { locked: true, timeoutMs: 500 });
  assert.equal(result.code, 2);
  session.close();
  daemon.close();
});

function lockedScript(confirmResult) {
  return {
    "agent:prompt": (_args, { reply, push }) => {
      push("agent:events", { type: "card", card: card("c1", "t1") });
      reply({ turnId: "t1" });
    },
    "agent:confirm": (_args, { reply, fail }) => {
      if (confirmResult === "locked") fail("locked", "Unlock the screen to approve");
      else reply(null);
    },
  };
}

test("locked-confirm passes only when jarvisd refuses with code locked", async () => {
  const daemon = await fakeDaemon({ handlers: lockedScript("locked") });
  const session = await connectDaemon({ runDir: daemon.runDir, buildStamp: "/nonexistent" });
  const result = await runLockedConfirm(session, { text: "install hello", timeoutMs: 3000 });
  assert.deepEqual([result.code, result.reason], [0, "locked"]);
  session.close();
  daemon.close();
});

test("locked-confirm fails when an approval goes through while locked", async () => {
  const daemon = await fakeDaemon({ handlers: lockedScript("accepted") });
  const session = await connectDaemon({ runDir: daemon.runDir, buildStamp: "/nonexistent" });
  const result = await runLockedConfirm(session, { text: "install hello", timeoutMs: 3000 });
  assert.deepEqual([result.code, result.reason], [1, "confirm-accepted-while-locked"]);
  session.close();
  daemon.close();
});
