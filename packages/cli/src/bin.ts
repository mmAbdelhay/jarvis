// The bundle's entry point: /usr/bin/jarvis runs this with jarvisd's bundled Node.
import { connectJarvis } from "./connect.js";
import { main } from "./main.js";
import { nodeTerminal } from "./terminal.js";

const MAX_STDIN_BYTES = 64_000;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk as Buffer);
    size += bytes.byteLength;
    chunks.push(bytes);
    if (size > MAX_STDIN_BYTES) break;
  }
  return Buffer.concat(chunks).toString("utf8");
}

process.exitCode = await main(process.argv.slice(2), {
  term: nodeTerminal(),
  env: process.env,
  connect: () => connectJarvis(process.env),
  readStdin,
});
