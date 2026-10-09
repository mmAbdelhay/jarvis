// `jarvis` dispatch. Everything with side effects comes in through MainDeps
// so it is tested without a terminal or a daemon of its own.
import { MAX_PROMPT_CHARS } from "@jarvis/wire";
import type { ControlClient } from "../../desktop/src/daemon/control/client.js";
import { parseArgs, USAGE } from "./args.js";
import { ask, chat } from "./chat.js";
import {
  DEFAULT_BUILD_STAMP,
  NotRunningError,
  readBuildStamp,
  VersionMismatchError,
} from "./connect.js";
import { memoryCommand } from "./memory.js";
import { terminalLine } from "./sanitize.js";
import { setup } from "./setup.js";
import type { Terminal } from "./terminal.js";
import { messageOf } from "./turn.js";

export interface MainDeps {
  term: Terminal;
  env: NodeJS.ProcessEnv;
  connect(): Promise<ControlClient>;
  readStdin(): Promise<string>;
}

export async function main(argv: readonly string[], deps: MainDeps): Promise<number> {
  const { term } = deps;
  const parsed = parseArgs(argv);
  if (parsed.kind === "usage-error") {
    term.write(`${terminalLine(parsed.message)}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.kind === "help") {
    term.write(USAGE);
    return 0;
  }
  if (parsed.kind === "version") {
    const build = await readBuildStamp(deps.env.JARVIS_BUILD_STAMP ?? DEFAULT_BUILD_STAMP);
    term.write(`jarvis (jarvisd build ${terminalLine(build) || "unknown"})\n`);
    return 0;
  }
  if (parsed.kind === "setup" && !term.interactive) {
    term.write("jarvis setup needs an interactive terminal.\n");
    return 2;
  }
  let piped = "";
  if (parsed.kind === "chat" && !term.interactive) {
    piped = (await deps.readStdin()).trim();
    if (piped === "") {
      term.write(USAGE);
      return 2;
    }
    if (piped.length > MAX_PROMPT_CHARS) {
      term.write("That question is too long (8000 characters at most).\n");
      return 2;
    }
  }
  let client: ControlClient;
  try {
    client = await deps.connect();
  } catch (error) {
    const known = error instanceof NotRunningError || error instanceof VersionMismatchError;
    term.write(
      known
        ? `${messageOf(error)}\n`
        : `Couldn't reach Jarvis: ${terminalLine(messageOf(error))}\n`,
    );
    return 1;
  }
  try {
    switch (parsed.kind) {
      case "chat":
        return piped === "" ? await chat(client, term) : await ask(client, term, piped);
      case "ask":
        return await ask(client, term, parsed.text);
      case "setup":
        return await setup(client, term);
      case "memory":
        return await memoryCommand(client, term, parsed.action, parsed.yes);
    }
  } catch (error) {
    term.write(`Jarvis couldn't do that: ${terminalLine(messageOf(error))}\n`);
    return 1;
  } finally {
    client.close();
  }
}
