// "Is a daemon answering on this endpoint?" — asked by a starter that finds
// the pid lock held by a live pid, which after a crash and a reboot is as
// likely to be an unrelated process reusing the number (task 20 re-review).
//
// Unix: a connection is enough; only this user can bind in the 0700 run dir.
// Windows: any local user can hold a pipe under an old name, so the endpoint
// must also prove it knows the secret — the first half of the handshake.
// It never sends the client's proof, so the probe leaks nothing.
import { HANDSHAKE_TIMEOUT_MS } from "@jarvis/wire";
import type { ControlDeps } from "./deps.js";
import { errorCode } from "./deps.js";
import { controlPaths, endpointFor } from "./endpoint.js";
import {
  CONTROL_PROTOCOL_VERSION,
  encodeJsonFrame,
  FrameDecoder,
  MAX_HELLO_FRAME_BYTES,
} from "./frames.js";
import { HEX32_PATTERN, NONCE_BYTES, proofMatches, serverProof } from "./handshake.js";
import { parseServerMessage } from "./messages.js";

type LivenessDeps = Pick<ControlDeps, "fs" | "net" | "clock" | "randomBytes">;

/** True if something accepts a connection at `endpoint`. */
export function answersConnection(
  endpoint: string,
  deps: Pick<ControlDeps, "net">,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = deps.net.connect(endpoint);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error) => {
      socket.destroy();
      // Refused, missing or not a socket: nobody home. So is EINVAL, a path
      // too long for a socket (a deep HOME): listen fails on it the same way,
      // so no daemon can be there. Anything else (a full backlog, say) is
      // someone there — busy is the safe reading.
      const code = errorCode(error);
      resolve(
        !(code === "ECONNREFUSED" || code === "ENOENT" || code === "ENOTSOCK" || code === "EINVAL"),
      );
    });
  });
}

/** True only if the endpoint answers a hello with a valid server proof for the secret on disk. */
export async function answersWithProof(
  endpoint: string,
  secretPath: string,
  deps: LivenessDeps,
): Promise<boolean> {
  let secret: Buffer;
  try {
    const text = (await deps.fs.readFile(secretPath, "utf8")).trim();
    if (!HEX32_PATTERN.test(text)) return false;
    secret = Buffer.from(text, "hex");
  } catch {
    return false;
  }
  const nonceC = Buffer.from(deps.randomBytes(NONCE_BYTES));
  return new Promise((resolve) => {
    const socket = deps.net.connect(endpoint);
    const decoder = new FrameDecoder(MAX_HELLO_FRAME_BYTES);
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      deps.clock.clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = deps.clock.setTimeout(() => finish(false), HANDSHAKE_TIMEOUT_MS);
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
    socket.on("connect", () => {
      socket.write(
        encodeJsonFrame({
          t: "hello",
          v: CONTROL_PROTOCOL_VERSION,
          build: "",
          nonceC: nonceC.toString("hex"),
        }),
      );
    });
    socket.on("data", (chunk: Buffer) => {
      try {
        decoder.push(chunk);
        const frame = decoder.next();
        if (frame === undefined) return;
        const message = frame.kind === "json" ? parseServerMessage(frame.value) : undefined;
        if (message?.t !== "challenge") return finish(false);
        const nonceS = Buffer.from(message.nonceS, "hex");
        finish(proofMatches(serverProof(secret, nonceC, nonceS), message.proof));
      } catch {
        finish(false);
      }
    });
  });
}

/** Whether the daemon of this run dir is answering, by the platform's rule above. */
export async function daemonAnswers(
  platform: NodeJS.Platform,
  runDirectory: string,
  deps: LivenessDeps,
): Promise<boolean> {
  const paths = controlPaths(platform, runDirectory);
  if (platform !== "win32") return answersConnection(paths.socketPath, deps);
  let endpoint: string;
  try {
    endpoint = await endpointFor({ platform, runDirectory, fs: deps.fs });
  } catch {
    return false;
  }
  return answersWithProof(endpoint, paths.secretPath, deps);
}
