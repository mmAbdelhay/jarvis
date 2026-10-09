import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  FrameReader, cardKind, encodeFrame, main, openSession, runComputerUse, setComputerUse, stopComputerUse,
} from "./jarvisctl.mjs";

const BUILD = "0.5.0+test.1";
const proof = (secret, label, a, b) => createHmac("sha256", secret).update(label).update(a).update(b).digest("hex");

/** jarvisd's control endpoint in miniature: the real handshake, scripted channels. */
async function fakeDaemon(handlers) {
  const runDir = mkdtempSync(join(tmpdir(), "jctl-cu-"));
  const secret = randomBytes(32);
  writeFileSync(join(runDir, "control.secret"), `${secret.toString("hex")}\n`);
  const calls = [];
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const reader = new FrameReader();
    const send = (v) => socket.write(encodeFrame(v));
    const push = (ch, p) => send({ t: "psh", ch, p, seq: 0 });
    let phase = "hello";
    let nonceC;
    let nonceS;
    socket.on("data", (chunk) => {
      reader.push(chunk);
      for (const m of reader.frames()) {
        if (phase === "hello") {
          nonceC = Buffer.from(m.nonceC, "hex");
          nonceS = randomBytes(32);
          send({ t: "challenge", nonceS: nonceS.toString("hex"), proof: proof(secret, "jarvisd-server", nonceC, nonceS) });
          phase = "auth";
        } else if (phase === "auth") {
          assert.equal(m.proof, proof(secret, "jarvisd-client", nonceS, nonceC));
          send({ t: "welcome", v: 1, capabilities: [] });
          phase = "open";
        } else {
          calls.push({ ch: m.ch, a: m.a });
          const reply = (v) => send({ t: "res", id: m.id, v });
          const handler = handlers[m.ch];
          if (handler) handler(m.a, { reply, push });
          else reply(null);
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(join(runDir, "jarvisd.sock"), resolve));
  return {
    runDir,
    calls,
    close() {
      for (const s of sockets) s.destroy();
      server.close();
      rmSync(runDir, { recursive: true, force: true });
    },
  };
}

const item = (itemId, tool, title) => ({ itemId, tool, title, detail: "", source: "system", risk: "confirm", secretFields: [] });
const card = (cardId, turnId, ...items) => ({ cardId, turnId, expiresAt: 0, items });

test("card kinds follow the v1.1 contract", () => {
  assert.equal(cardKind(card("a", "t", item("i", "cu.begin", "Let Jarvis use GIMP to: x"))), "begin");
  assert.equal(cardKind(card("b", "t", item("i", "screen.click", "Click Export"))), "consequential");
  assert.equal(cardKind(card("c", "t", item("i", "pkg.install", "Install"))), "other");
  assert.equal(cardKind(card("d", "t")), "other");
});

test("approves the session and consequential cards, denies anything else, logs cu:state", async () => {
  const confirmed = [];
  const daemon = await fakeDaemon({
    "agent:prompt": (args, { reply, push }) => {
      push("agent:events", { type: "turn-start", turnId: "t1", text: args[0].text });
      push("agent:events", { type: "card", card: card("c1", "t1", item("b", "cu.begin", "Let Jarvis use GIMP to: export")) });
      reply({ turnId: "t1" });
    },
    "agent:confirm": (args, { reply, push }) => {
      confirmed.push(args[0]);
      reply(null);
      if (args[0].cardId === "c1") {
        push("cu:state", { active: true, step: 1, maxSteps: 50, paused: null });
        push("agent:events", { type: "card", card: card("c2", "t1", item("s", "screen.click", "Click Export (save)")) });
      } else if (args[0].cardId === "c2") {
        push("agent:events", { type: "card", card: card("c3", "t1", item("p", "pkg.install", "Install hello")) });
      } else {
        push("agent:events", { type: "turn-end", turnId: "t1", reason: "done" });
      }
    },
  });
  const { session } = await openSession({ runDir: daemon.runDir, build: BUILD });
  const lines = [];
  let clock = 1000;
  const result = await runComputerUse(session, {
    text: "export", absentPath: "/nope/beach.png", timeoutMs: 5000, log: (e) => lines.push(e),
    wall: () => (clock += 10), exists: () => false,
  });
  assert.equal(result.code, 0);
  assert.deepEqual(confirmed.map((c) => [c.cardId, c.approve, c.ticked]), [["c1", true, ["b"]], ["c2", true, ["s"]], ["c3", false, []]]);
  assert.deepEqual(result.cards.map((c) => c.kind), ["begin", "consequential", "other"]);
  assert.equal(result.cards[1].pathExisted, false);
  const state = lines.find((l) => l.type === "cu-state");
  assert.equal(state.active, true);
  assert.equal(typeof state.wall, "number");
  session.close();
  daemon.close();
});

test("--consequential deny denies the save card; a begin card without a turn is still answered", async () => {
  const confirmed = [];
  const daemon = await fakeDaemon({
    "agent:prompt": (args, { reply, push }) => {
      push("agent:events", { type: "card", card: card("c1", null, item("b", "cu.begin", "Let Jarvis use GIMP to: x")) });
      push("agent:events", { type: "card", card: card("d1", null, item("w", "net.wifi_connect", "Doctor card")) });
      reply({ turnId: "t1" });
    },
    "agent:confirm": (args, { reply, push }) => {
      confirmed.push(args[0]);
      reply(null);
      if (args[0].cardId === "c1") push("agent:events", { type: "card", card: card("c2", "t1", item("s", "screen.click", "Save")) });
      else push("agent:events", { type: "turn-end", turnId: "t1", reason: "done" });
    },
  });
  const { session } = await openSession({ runDir: daemon.runDir, build: BUILD });
  const result = await runComputerUse(session, { text: "x", consequential: "deny", timeoutMs: 5000 });
  assert.equal(result.code, 0);
  assert.deepEqual(confirmed.map((c) => [c.cardId, c.approve]), [["c1", true], ["c2", false]]);
  session.close();
  daemon.close();
});

test("cu-enable sends setEnabled then consent; cu-stop sends cu:stop", async () => {
  const daemon = await fakeDaemon({});
  const { session } = await openSession({ runDir: daemon.runDir, build: BUILD });
  assert.equal((await setComputerUse(session, { providerId: "scripted", enabled: true, consent: true })).code, 0);
  assert.equal((await stopComputerUse(session)).code, 0);
  assert.deepEqual(daemon.calls, [
    { ch: "cu:setEnabled", a: [{ providerId: "scripted", enabled: true }] },
    { ch: "cu:consent", a: [{ providerId: "scripted" }] },
    { ch: "cu:stop", a: [] },
  ]);
  session.close();
  daemon.close();
});

test("usage errors exit 64", async () => {
  assert.equal(await main(["cu"]), 64);
  assert.equal(await main(["cu-enable"]), 64);
  assert.equal(await main(["cu", "--text", "x", "--begin", "maybe"]), 64);
});
