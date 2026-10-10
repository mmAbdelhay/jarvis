// A recorded account CLI for tests. Reads all of stdin first (like the real
// CLIs), records what it was given, then plays a JSONL fixture.
//   FAKE_CLI_SCRIPT   fixture file (one line per stdout line)
//   FAKE_CLI_RECORD   where to write {argv, stdinBytes, stdinSha256, envKeys}
//   FAKE_CLI_STDERR   text for stderr before exiting
//   FAKE_CLI_HANG=1   never exit after the script
//   FAKE_CLI_EXIT     exit code (default 0)
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const stdin = Buffer.concat(chunks);
if (process.env.FAKE_CLI_RECORD) {
  writeFileSync(
    process.env.FAKE_CLI_RECORD,
    JSON.stringify({
      argv: process.argv.slice(2),
      stdinBytes: stdin.length,
      stdinSha256: createHash("sha256").update(stdin).digest("hex"),
      envKeys: Object.keys(process.env).sort(),
    }),
  );
}
const script = process.env.FAKE_CLI_SCRIPT ? readFileSync(process.env.FAKE_CLI_SCRIPT, "utf8") : "";
for (const line of script.split("\n").filter(Boolean)) process.stdout.write(`${line}\n`);
if (process.env.FAKE_CLI_STDERR) process.stderr.write(process.env.FAKE_CLI_STDERR);
if (process.env.FAKE_CLI_HANG === "1") setInterval(() => {}, 1000);
else process.exitCode = Number(process.env.FAKE_CLI_EXIT ?? 0);
