// The real jarvisd control server (packages/desktop/src/daemon/control/server.ts)
// with scripted handlers, so the CLI is tested against the exact frames and
// handshake it meets in production. Run dirs live under /tmp because macOS
// caps Unix socket paths near 104 bytes.
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { ControlClient } from "../../../desktop/src/daemon/control/client.js";
import { nodeControlDeps } from "../../../desktop/src/daemon/control/deps.js";
import {
  type ControlServer,
  createControlServer,
} from "../../../desktop/src/daemon/control/server.js";
import { connectJarvis } from "../connect.js";

export const TEST_BUILD = "test-build-1";
export const MISSING_STAMP = "/nonexistent/jarvis/build-stamp.json";

export type Handler = (channel: string, args: unknown[]) => unknown;

export interface TestDaemon {
  readonly runDirectory: string;
  readonly server: ControlServer;
  readonly requests: { channel: string; args: unknown[] }[];
  handler: Handler;
  close(): Promise<void>;
}

export async function startTestDaemon(handler: Handler = () => null): Promise<TestDaemon> {
  const dir = await mkdtemp(join("/tmp", "jcli-"));
  const runDirectory = join(dir, "run");
  const requests: { channel: string; args: unknown[] }[] = [];
  const state = { handler, closed: false };
  const started = await createControlServer({
    platform: process.platform,
    runDirectory,
    build: TEST_BUILD,
    deps: nodeControlDeps(),
    handlers: {
      async invoke(channel, args) {
        requests.push({ channel, args });
        return state.handler(channel, args);
      },
      async upload() {
        throw new Error("The test daemon takes no uploads");
      },
      stop() {},
    },
  });
  if (started.kind !== "started") throw new Error("The test daemon could not start");
  const server = started.server;
  return {
    runDirectory,
    server,
    requests,
    get handler() {
      return state.handler;
    },
    set handler(next: Handler) {
      state.handler = next;
    },
    async close() {
      if (state.closed) return;
      state.closed = true;
      await server.close().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Call at the top level of a test file: daemons and clients are closed after each test. */
export function testDaemons() {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  return {
    async start(handler?: Handler): Promise<TestDaemon> {
      const daemon = await startTestDaemon(handler);
      cleanups.push(() => daemon.close());
      return daemon;
    },
    async connect(daemon: TestDaemon): Promise<ControlClient> {
      const client = await connectJarvis(
        {},
        { runDirectory: daemon.runDirectory, buildStampPath: MISSING_STAMP },
      );
      cleanups.push(() => client.close());
      return client;
    },
  };
}
