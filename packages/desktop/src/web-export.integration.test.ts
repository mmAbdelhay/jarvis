// End to end, on this machine: the export `pnpm build` copied into
// packages/desktop/web, read by the same loader main.ts uses (web-export.ts
// over the real filesystem), served by a real bridge's web listener over
// real TLS with a self-signed certificate for a test hostname — exactly the
// path a paired browser takes, minus Tailscale. Like
// dist-emit-resolution.test.ts it reads build output, so it is skipped on a
// tree that was never built (CI builds before it tests).
import { randomBytes, scryptSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Bridge, createBridge } from "@jarvis/remote";
import {
  buildWebManifest,
  listenTls,
  listenWeb,
  loadCertificate,
  nodeFs,
  nodeTimers,
} from "@jarvis/remote/listen";
import { createWebManifestLoader, nodeWebExportFs } from "./web-export.js";

const exportDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web");
const NAME = "jarvis.test";
const ENFORCE_FILE_MODES = process.platform !== "win32";

/** owner.json with a password set at a tiny scrypt cost — mirrors
 *  packages/remote/src/owner-double.ts, which @jarvis/remote does not
 *  export. The bridge never listens without an owner password. */
function ownerFile(): string {
  const salt = Buffer.alloc(16, 7);
  const N = 2 ** 4;
  const r = 8;
  const p = 1;
  const hash = scryptSync("owner test password", salt, 64, { N, r, p }).toString("hex");
  return `${JSON.stringify({
    version: 1,
    password: { hash, salt: salt.toString("hex"), N, r, p },
    passkeys: [],
    credentialsVersion: 1,
  })}\n`;
}

type Reply = { status: string; headers: Map<string, string>; body: Buffer };

/** One raw HTTP/1.1 GET over TLS, the way a browser at https://NAME:port sends it. */
function get(port: number, path: string): Promise<Reply> {
  return new Promise((resolvePromise, reject) => {
    const socket = tlsConnect(
      { host: "127.0.0.1", port, servername: NAME, rejectUnauthorized: false },
      () => {
        socket.write(`GET ${path} HTTP/1.1\r\nHost: ${NAME}:${port}\r\nConnection: close\r\n\r\n`);
      },
    );
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("close", () => {
      const raw = Buffer.concat(chunks);
      const split = raw.indexOf("\r\n\r\n");
      if (split < 0) {
        reject(new Error(`no response for ${path}`));
        return;
      }
      const [status = "", ...lines] = raw.subarray(0, split).toString("latin1").split("\r\n");
      const headers = new Map<string, string>();
      for (const line of lines) {
        const colon = line.indexOf(":");
        headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
      }
      resolvePromise({ status, headers, body: raw.subarray(split + 4) });
    });
  });
}

function csp(bridgePort: number, frameAncestors: string): string {
  return `default-src 'self'; script-src 'self'; connect-src wss://${NAME}:${bridgePort}; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; frame-src 'self'; frame-ancestors ${frameAncestors}; base-uri 'none'; form-action 'none'`;
}

describe("web export served by the bridge's web listener", () => {
  if (!existsSync(join(exportDir, "index.html"))) {
    it.skip("skipped: packages/desktop/web has not been built (run `pnpm build`)", () => {});
    return;
  }

  let dir: string;
  let bridge: Bridge;
  let webPort: number;
  let bridgePort: number;
  const logLines: string[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "jarvis-web-e2e-"));
    const random = (size: number) => randomBytes(size);
    await nodeFs.writeFile(join(dir, "owner.json"), ownerFile(), 0o600);
    bridge = await createBridge({
      dir,
      fs: nodeFs,
      random,
      now: Date.now,
      timers: nodeTimers,
      listen: listenTls,
      // The real self-signed certificate, relabelled "configured" with a
      // DNS name: the web gate needs one, and TLS here pins nothing by name.
      loadCertificate: async (certConfig) => ({
        ...(await loadCertificate(certConfig, {
          fs: nodeFs,
          dir,
          random,
          now: Date.now,
          enforceFileModes: ENFORCE_FILE_MODES,
        })),
        source: "configured",
        dnsNames: [NAME],
      }),
      createProxy: () => undefined,
      listenWeb,
      loadWebManifest: createWebManifestLoader({
        dir: () => exportDir,
        fs: nodeWebExportFs,
        build: buildWebManifest,
      }),
      handle: async () => ({ kind: "unknown-channel" }),
      policies: new Map(),
      authorizeKey: () => false,
      blobLimit: () => undefined,
      errorText: (code) => ({ text: `err:${code}`, language: "en" }),
      auditPolicy: () => "never",
      enforceFileModes: ENFORCE_FILE_MODES,
      log: (line) => logLines.push(line),
      onDeviceDisconnected: () => {},
      onStatus: () => {},
    });
    await bridge.apply({
      enabled: true,
      bindAddress: "127.0.0.1",
      port: 0,
      sidecarProxy: false,
      tls: {},
      web: { enabled: true, port: 0 },
    });
    // With no paired device the bridge only listens while pairing is open.
    expect(await bridge.openPairing()).toBe("opened");
    const web = bridge.status().web;
    if (web?.kind !== "on") {
      throw new Error(`expected web on, got ${JSON.stringify(web)}; log: ${logLines.join(" | ")}`);
    }
    webPort = web.port;
    bridgePort = bridge.status().listening?.port ?? 0;
  });

  afterAll(async () => {
    await bridge?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("GET / is index.html, no-cache, with the exact CSP", async () => {
    const reply = await get(webPort, "/");
    expect(reply.status).toBe("HTTP/1.1 200 OK");
    expect(reply.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(reply.headers.get("cache-control")).toBe("no-cache");
    expect(reply.headers.get("content-security-policy")).toBe(csp(bridgePort, "'none'"));
    expect(reply.body.toString("utf8")).toContain('<script src="/_expo/static/js/web/entry-');
  });

  it("GET /terminal.html may be framed by the app's own origin, and nothing else changes", async () => {
    const reply = await get(webPort, "/terminal.html");
    expect(reply.status).toBe("HTTP/1.1 200 OK");
    expect(reply.headers.get("content-security-policy")).toBe(csp(bridgePort, "'self'"));
  });

  it("the hashed entry bundle is immutable JavaScript", async () => {
    const index = (await get(webPort, "/")).body.toString("utf8");
    const entry = /src="(\/_expo\/static\/js\/web\/entry-[0-9a-f]+\.js)"/.exec(index)?.[1];
    expect(entry).toBeDefined();
    const reply = await get(webPort, entry ?? "");
    expect(reply.status).toBe("HTTP/1.1 200 OK");
    expect(reply.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(reply.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(reply.headers.get("content-security-policy")).toBe(csp(bridgePort, "'none'"));
  });
});
