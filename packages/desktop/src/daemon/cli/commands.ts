// The jarvisd CLI's commands, each a short conversation with a running
// daemon over the control socket. Every side effect is injected (CliDeps):
// the terminal, the connection, the QR encoder, the timers, and the
// daemon itself for `run`. runCli resolves to the exit code.
//
// Every request goes through the same desktop-only channels desktop
// Settings uses (the socket is the desktop's own door, binding.ts), so the
// daemon applies the same rules either way: the owner password rules, the
// pairing confirmation, the settings save path for `web on|off`.
//
// Passwords: read without echo from a terminal, or from stdin with
// --stdin, then passed to remote:setOwnerPassword and nowhere else — never
// printed, logged or put in an error message.
//
// Exit codes (DAEMON_EXIT): 0 done, 1 failed, 2 usage, 3 the daemon is not
// running — the same 3 daemon-main uses for "another one already is".
//
// No electron here (core/no-electron.test.ts).
import type {
  OwnerStatus,
  RemotePairingStatus,
  RemoteStatus,
  SetOwnerPasswordResult,
} from "@jarvis/remote";
import type { JarvisConfig } from "../../config.js";
import type { GitViewResult, SettingsSaveResult } from "../../ipc.js";
import { MESSAGES } from "../../messages.js";
import { remoteWebUrl } from "../../remote-web.js";
import { DAEMON_EXIT } from "../args.js";
import { ControlRestartRequired } from "../control/client.js";
import { errorCode } from "../control/deps.js";
import { ControlRequestError } from "../control/messages.js";
import { type CliCommand, parseCliArgs } from "./args.js";
import { formatDevices, formatStatus, terminalSafe } from "./format.js";
import { CLI_MESSAGES } from "./messages.js";
import { type QrMatrix, qrToBlocks } from "./qr-blocks.js";

type Language = "ar" | "en";

/** The terminal, as the commands see it. Prompts go to stderr, so stdout
 *  carries only a command's answer. */
export type CliIo = {
  out(line: string): void;
  err(line: string): void;
  /** Whether stdin is a terminal a password can be typed into. */
  readonly stdinIsTTY: boolean;
  /** Whether stdout is a terminal — the only place `pair` prints its
   *  secret-bearing link and QR. */
  readonly stdoutIsTTY: boolean;
  /** One line typed without echo; `undefined` on Ctrl-C or end of input. */
  readHidden(prompt: string): Promise<string | undefined>;
  /** The next line of stdin (echoed on a terminal); `undefined` at its end. */
  readLine(prompt?: string): Promise<string | undefined>;
  /** Ctrl-C while no line is being read hidden. Returns the unsubscribe. */
  onInterrupt(listener: () => void): () => void;
};

/** The part of ControlClient (control/client.ts) the commands use. */
export type CliClient = {
  invoke(channel: string, args: unknown[]): Promise<unknown>;
  onPush(listener: (channel: string, payload: unknown) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
};

export type CliDeps = {
  io: CliIo;
  language: Language;
  connect(): Promise<CliClient>;
  /** `jarvisd stop`: a hello with intent "stop" (control/client.ts
   *  requestControlStop), honoured by a daemon of any build. */
  requestStop(): Promise<void>;
  /** Whether a daemon still answers on the control endpoint. */
  daemonAnswers(): Promise<boolean>;
  /** `jarvisd run`: the daemon in this process (daemon-main.ts). */
  runDaemon(): Promise<number>;
  encodeQr(text: string): QrMatrix;
  now(): number;
  timers: {
    setInterval(callback: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
};

/** How often `pair` re-reads the status, besides the daemon's pushes. */
export const PAIR_POLL_MS = 1_000;
/** How long `stop` waits for the daemon to let go of its endpoint. */
export const STOP_WAIT_MS = 15_000;
const STOP_POLL_MS = 200;

const NOT_RUNNING_CODES = new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK"]);

class CommandFailed extends Error {
  constructor(
    readonly text: string,
    readonly exitCode: number = DAEMON_EXIT.failed,
  ) {
    super(text);
  }
}

function yes(answer: string | undefined): boolean {
  return answer !== undefined && /^\s*y(es)?\s*$/i.test(answer);
}

/** A failure the user can act on, with its exit code. Nothing a command
 *  was given (a password) is ever part of it: the transport's errors carry
 *  only its own words, and a daemon error only the daemon's. */
function explain(error: unknown, language: Language): { text: string; code: number } {
  if (error instanceof CommandFailed) return { text: error.text, code: error.exitCode };
  if (error instanceof ControlRestartRequired) {
    return { text: CLI_MESSAGES.restartRequired(language), code: DAEMON_EXIT.failed };
  }
  const code = errorCode(error);
  if (code !== undefined && NOT_RUNNING_CODES.has(code)) {
    return { text: CLI_MESSAGES.notRunning(language), code: DAEMON_EXIT.busy };
  }
  const detail =
    error instanceof ControlRequestError || error instanceof Error ? error.message : String(error);
  return { text: CLI_MESSAGES.failed(detail, language), code: DAEMON_EXIT.failed };
}

export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const { io, language } = deps;
  const args = parseCliArgs(argv);
  if (args.kind === "help") {
    io.out(CLI_MESSAGES.usage(language));
    return DAEMON_EXIT.ok;
  }
  if (args.kind === "usage-error") {
    io.err(CLI_MESSAGES.usageError(args.problem, language));
    io.err(CLI_MESSAGES.usage(language));
    return DAEMON_EXIT.usage;
  }
  if (args.kind === "run") return deps.runDaemon();
  // Checked before connecting: a script piping into a TTY-only prompt learns
  // it at once, whether or not the daemon runs.
  if (args.kind === "set-password" && !args.stdin && !io.stdinIsTTY) {
    io.err(CLI_MESSAGES.needsTerminal(language));
    return DAEMON_EXIT.usage;
  }
  // The other way round: a line read from a terminal is echoed, so the
  // password would land on screen — and, in a Jarvis terminal, in its
  // scrollback and on every device following it.
  if (args.kind === "set-password" && args.stdin && io.stdinIsTTY) {
    io.err(CLI_MESSAGES.stdinIsTerminal(language));
    return DAEMON_EXIT.usage;
  }
  // The pairing link and its QR carry the pairing secret: printed into a
  // pipe or a redirect they would outlive the window in a file or a log.
  if (args.kind === "pair" && !io.stdoutIsTTY) {
    io.err(CLI_MESSAGES.pairNeedsTerminal(language));
    return DAEMON_EXIT.usage;
  }

  if (args.kind === "stop") {
    try {
      return await stopDaemon(deps);
    } catch (error) {
      const { text, code } = explain(error, language);
      io.err(text);
      return code;
    }
  }

  let client: CliClient | undefined;
  try {
    client = await deps.connect();
    return await runCommand(args, client, deps);
  } catch (error) {
    const { text, code } = explain(error, language);
    io.err(text);
    return code;
  } finally {
    client?.close();
  }
}

async function runCommand(
  command: Exclude<CliCommand, { kind: "run" | "help" | "stop" }>,
  client: CliClient,
  deps: CliDeps,
): Promise<number> {
  const { io, language } = deps;
  switch (command.kind) {
    case "status": {
      const remote = (await client.invoke("remote:status", [])) as RemoteStatus;
      const owner = (await client.invoke("remote:ownerStatus", [])) as OwnerStatus;
      io.out(formatStatus(remote, owner, language));
      return DAEMON_EXIT.ok;
    }
    case "set-password":
      return setPassword(command.stdin, client, deps);
    case "pair":
      return pair(client, deps);
    case "devices": {
      const remote = (await client.invoke("remote:status", [])) as RemoteStatus;
      io.out(formatDevices(remote.devices, language));
      return DAEMON_EXIT.ok;
    }
    case "revoke": {
      const result = (await client.invoke("remote:revoke", [
        command.id,
      ])) as GitViewResult<undefined>;
      if (!result.ok) throw new CommandFailed(result.text);
      io.out(CLI_MESSAGES.revoked(language));
      return DAEMON_EXIT.ok;
    }
    case "sign-out-all": {
      if (!command.yes) {
        io.err(MESSAGES.remoteOwnerSignOutNote(language));
        const answer = await io.readLine(CLI_MESSAGES.signOutPrompt(language));
        if (!yes(answer)) throw new CommandFailed(CLI_MESSAGES.cancelled(language));
      }
      await client.invoke("remote:signOutEverywhere", []);
      io.out(MESSAGES.remoteOwnerSignedOut(language));
      return DAEMON_EXIT.ok;
    }
    case "web": {
      // Settings' own path: read the whole config, change one field, save
      // it back through settings:save, which validates and applies it.
      const config = (await client.invoke("settings:read", [])) as JarvisConfig;
      const draft: JarvisConfig = {
        ...config,
        remote: { ...config.remote, web: { ...config.remote.web, enabled: command.enabled } },
      };
      const result = (await client.invoke("settings:save", [draft])) as SettingsSaveResult;
      if (!result.ok) throw new CommandFailed(`${result.text} ${result.detail}`.trim());
      io.out(CLI_MESSAGES.webSaved(command.enabled, language));
      return DAEMON_EXIT.ok;
    }
  }
}

/** Asks with intent stop — no welcome needed, so a daemon of another build
 *  stops too — then waits for the endpoint to go. */
async function stopDaemon(deps: CliDeps): Promise<number> {
  const { io, language } = deps;
  await deps.requestStop();
  io.out(CLI_MESSAGES.stopping(language));
  const deadline = deps.now() + STOP_WAIT_MS;
  while (await deps.daemonAnswers()) {
    if (deps.now() >= deadline) throw new CommandFailed(CLI_MESSAGES.stillRunning(language));
    await new Promise<void>((resolve) => deps.timers.setTimeout(resolve, STOP_POLL_MS));
  }
  io.out(CLI_MESSAGES.stopped(language));
  return DAEMON_EXIT.ok;
}

async function setPassword(stdin: boolean, client: CliClient, deps: CliDeps): Promise<number> {
  const { io, language } = deps;
  const owner = (await client.invoke("remote:ownerStatus", [])) as OwnerStatus;
  let current: string | undefined;
  let next: string | undefined;
  if (stdin) {
    if (owner.hasPassword) current = await io.readLine();
    next = await io.readLine();
    if (next === undefined || (owner.hasPassword && current === undefined)) {
      throw new CommandFailed(CLI_MESSAGES.noPasswordOnStdin(language));
    }
  } else {
    const cancelled = () => new CommandFailed(CLI_MESSAGES.cancelled(language));
    if (owner.hasPassword) {
      current = await io.readHidden(`${MESSAGES.remoteOwnerCurrentLabel(language)}: `);
      if (current === undefined) throw cancelled();
    }
    io.err(MESSAGES.remoteOwnerLengthNote(language));
    next = await io.readHidden(`${MESSAGES.remoteOwnerNewLabel(language)}: `);
    if (next === undefined) throw cancelled();
    const confirm = await io.readHidden(`${MESSAGES.remoteOwnerConfirmLabel(language)}: `);
    if (confirm === undefined) throw cancelled();
    if (confirm !== next) throw new CommandFailed(MESSAGES.remoteOwnerError("mismatch", language));
  }
  const result = (await client.invoke("remote:setOwnerPassword", [
    current ?? null,
    next,
  ])) as SetOwnerPasswordResult;
  if (!result.ok) throw new CommandFailed(MESSAGES.remoteOwnerError(result.code, language));
  io.out(MESSAGES.remoteOwnerSaved(language));
  return DAEMON_EXIT.ok;
}

function fingerprintTail(uri: string): string | undefined {
  const query = uri.indexOf("?");
  if (query === -1) return undefined;
  const fingerprint = new URLSearchParams(uri.slice(query + 1)).get("fp");
  return fingerprint === null || fingerprint.length < 4 ? undefined : fingerprint.slice(-4);
}

function printPairing(status: RemoteStatus, deps: CliDeps): void {
  const { io, language } = deps;
  const pairing = status.pairing;
  if (pairing.kind !== "open") return;
  io.out(MESSAGES.remotePairInstructions(language));
  io.out("");
  for (const line of qrToBlocks(deps.encodeQr(pairing.uri))) io.out(line);
  io.out("");
  io.out(CLI_MESSAGES.pairAppLink(language));
  io.out(pairing.uri);
  const web = remoteWebUrl(status);
  if (web !== undefined && pairing.webUri !== undefined) {
    io.out("");
    io.out(`${CLI_MESSAGES.pairWebLink(language)} ${MESSAGES.remoteWebQrNote(true, language)}`);
    for (const line of qrToBlocks(deps.encodeQr(web))) io.out(line);
    io.out(web);
  }
  io.out("");
  const tail = fingerprintTail(pairing.uri);
  if (tail !== undefined) io.out(MESSAGES.remotePairFingerprintTail(tail, language));
  io.out(MESSAGES.remotePairExpires(Math.round((pairing.expiresAt - deps.now()) / 1000), language));
  io.err(CLI_MESSAGES.pairWaiting(language));
}

/**
 * Opens pairing, shows the link and its QR, then waits for a device to
 * ask. The request is shown (its name and address are the device's own
 * words, so terminalSafe) and answered y/N — remote:decidePair, exactly
 * the desktop dialog's decision. Ctrl-C cancels the pairing window.
 */
async function pair(client: CliClient, deps: CliDeps): Promise<number> {
  const { io, language } = deps;
  const opened = (await client.invoke("remote:pair", [])) as GitViewResult<undefined>;
  if (!opened.ok) throw new CommandFailed(opened.text);
  const first = (await client.invoke("remote:status", [])) as RemoteStatus;
  if (first.pairing.kind === "closed") throw new CommandFailed(CLI_MESSAGES.pairClosed(language));
  printPairing(first, deps);

  return new Promise<number>((resolve, reject) => {
    let settled = false;
    let asking: string | undefined;
    const cleanups: Array<() => void> = [];
    const finish = (code: number, error?: unknown) => {
      if (settled) return;
      settled = true;
      for (const cleanup of cleanups) cleanup();
      if (error === undefined) resolve(code);
      else reject(error);
    };

    const decide = async (request: Extract<RemotePairingStatus, { kind: "confirming" }>) => {
      io.out("");
      io.out(MESSAGES.remoteConfirmTitle(language));
      io.out(`${MESSAGES.remoteConfirmDeviceLabel(language)}: ${terminalSafe(request.deviceName)}`);
      io.out(`${MESSAGES.remoteConfirmFromLabel(language)}: ${terminalSafe(request.address)}`);
      const answer = await io.readLine(CLI_MESSAGES.pairApprovePrompt(language));
      if (settled) return;
      const approve = yes(answer);
      // The daemon says whether the answer reached the request: one that
      // expired (or was cancelled) while the prompt waited is reported as
      // such, never as approved or declined.
      const reached = await client.invoke("remote:decidePair", [request.requestId, approve]);
      if (reached !== true) {
        io.err(CLI_MESSAGES.pairRequestGone(language));
        finish(DAEMON_EXIT.failed);
      } else if (approve) {
        io.out(CLI_MESSAGES.pairApproved(language));
        finish(DAEMON_EXIT.ok);
      } else {
        io.err(CLI_MESSAGES.pairDeclined(language));
        finish(DAEMON_EXIT.failed);
      }
    };

    const consider = (status: RemoteStatus) => {
      if (settled || asking !== undefined) return;
      const pairing = status.pairing;
      if (pairing.kind === "confirming") {
        asking = pairing.requestId;
        decide(pairing).catch((error: unknown) => finish(DAEMON_EXIT.failed, error));
      } else if (pairing.kind === "closed") {
        io.err(CLI_MESSAGES.pairClosed(language));
        finish(DAEMON_EXIT.failed);
      }
    };

    cleanups.push(
      io.onInterrupt(() => {
        if (settled) return;
        const done = () => {
          io.err(CLI_MESSAGES.cancelled(language));
          finish(DAEMON_EXIT.failed);
        };
        client.invoke("remote:cancelPair", []).then(done, done);
      }),
    );
    cleanups.push(
      client.onPush((channel, payload) => {
        if (channel === "remote:update") consider(payload as RemoteStatus);
      }),
    );
    cleanups.push(
      client.onClose(() => {
        if (!settled)
          finish(DAEMON_EXIT.failed, new CommandFailed(CLI_MESSAGES.connectionLost(language)));
      }),
    );
    const poll = deps.timers.setInterval(() => {
      client.invoke("remote:status", []).then(
        (status) => consider(status as RemoteStatus),
        () => {},
      );
    }, PAIR_POLL_MS);
    cleanups.push(() => deps.timers.clearInterval(poll));
    consider(first);
  });
}
