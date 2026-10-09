// Regenerates (or, with --check, verifies) the C++ shell's golden vectors
// from the TypeScript control implementation, so the C++ port can never
// drift from frames.ts / handshake.ts unnoticed. Run from the repo root after
// compiling the TypeScript (`pnpm exec tsc -b`, which emits packages/desktop/dist):
//   node os/shell/tests/tools/gen-vectors.mjs [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = process.env.JARVIS_REPO ?? resolve(here, "..", "..", "..", "..");
const out = process.env.VECTORS_OUT ?? resolve(here, "..", "vectors", "control-vectors.json");
const control = join(repo, "packages", "desktop", "dist", "src", "daemon", "control");
const load = (name) => import(pathToFileURL(join(control, name)).href);
const { serverProof, clientProof } = await load("handshake.js");
const frames = await load("frames.js");

const seq = (start) => Buffer.from(Array.from({ length: 32 }, (_, i) => (start + i) & 0xff));
const fill = (byte) => Buffer.alloc(32, byte);
const proofCases = [
  { name: "sequential", secret: seq(0x00), nonceC: seq(0x20), nonceS: seq(0x40) },
  { name: "filled", secret: fill(0xab), nonceC: fill(0x01), nonceS: fill(0xfe) },
].map(({ name, secret, nonceC, nonceS }) => ({
  name,
  secret: secret.toString("hex"),
  nonceC: nonceC.toString("hex"),
  nonceS: nonceS.toString("hex"),
  serverProof: serverProof(secret, nonceC, nonceS).toString("hex"),
  clientProof: clientProof(secret, nonceS, nonceC).toString("hex"),
}));

// The first two have keys in sorted order, which is how QJsonDocument writes
// them, so the C++ encoder must reproduce their bytes exactly.
const jsonFrames = [
  { a: [], ch: "provider:list", id: 1, t: "req" },
  { a: [{ text: "héllo" }], ch: "agent:prompt", id: 7, t: "req" },
  { t: "res", id: 7, v: { turnId: "t1" } },
].map((value) => ({ value, hex: frames.encodeJsonFrame(value).toString("hex") }));
const [head, body] = frames.encodeBinaryFrame(Uint8Array.from([1, 2, 3]));
const binaryFrames = [{ bytes: "010203", hex: Buffer.concat([head, body]).toString("hex") }];

const vectors = {
  generatedFrom: "packages/desktop/src/daemon/control/{handshake,frames}.ts",
  protocolVersion: frames.CONTROL_PROTOCOL_VERSION,
  maxFrameBytes: frames.MAX_CONTROL_FRAME_BYTES,
  maxHelloFrameBytes: frames.MAX_HELLO_FRAME_BYTES,
  proofs: proofCases,
  jsonFrames,
  binaryFrames,
};
const text = `${JSON.stringify(vectors, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(out, "utf8") !== text) {
    console.error(`${out} is stale: run node os/shell/tests/tools/gen-vectors.mjs`);
    process.exit(1);
  }
  console.log("control vectors match the TypeScript implementation");
} else {
  writeFileSync(out, text);
  console.log(`wrote ${out}`);
}
