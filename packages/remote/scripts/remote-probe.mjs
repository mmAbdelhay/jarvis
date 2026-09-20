#!/usr/bin/env node
// A manual-pass CLI around probe-client.ts's runProbe: paste a pairing URI
// from Settings, approve the device on the laptop, and this plays the whole
// phone side of the protocol — pairing, connecting, a call, a push, the two
// negative checks — and reports what happened. It imports the *built*
// probe-client.js (a `tsc -b` run is required first, same as any other
// consumer of this package's dist output); it is never packaged into the
// app (electron-builder.yml excludes it) and never imported by main.ts.
import { runProbe } from "../dist/probe-client.js";

function usage() {
  return "usage: remote-probe.mjs <uri> [--host ADDR] [--name NAME] [--terminal PANEKEY] [--allow-non-loopback] [--hold]";
}

function parseArgs(argv) {
  let uri;
  let host;
  let name = "Jarvis probe";
  let allowNonLoopback = false;
  let hold = false;
  let terminal;

  const rest = [...argv];
  while (rest.length > 0) {
    const arg = rest.shift();
    if (arg === "--host") {
      if (rest.length === 0) throw new Error(`--host requires a value\n${usage()}`);
      host = rest.shift();
    } else if (arg === "--name") {
      if (rest.length === 0) throw new Error(`--name requires a value\n${usage()}`);
      name = rest.shift();
    } else if (arg === "--terminal") {
      if (rest.length === 0) throw new Error(`--terminal requires a value\n${usage()}`);
      terminal = rest.shift();
    } else if (arg === "--allow-non-loopback") {
      allowNonLoopback = true;
    } else if (arg === "--hold") {
      hold = true;
    } else if (uri === undefined) {
      uri = arg;
    } else {
      throw new Error(`unrecognised argument: ${arg}\n${usage()}`);
    }
  }
  if (uri === undefined) throw new Error(usage());
  return { uri, host, name, allowNonLoopback, hold, terminal };
}

async function main() {
  const { uri, host, name, allowNonLoopback, hold, terminal } = parseArgs(process.argv.slice(2));
  await runProbe({
    uri,
    hostOverride: host,
    deviceName: name,
    allowNonLoopback,
    hold,
    terminal,
    log: (line) => {
      console.log(line);
    },
  });
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
