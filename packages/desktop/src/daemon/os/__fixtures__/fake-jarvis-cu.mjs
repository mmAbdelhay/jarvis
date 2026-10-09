// packages/desktop/src/daemon/os/__fixtures__/fake-jarvis-cu.mjs
// A protocol-faithful stand-in for jarvis-cu (Rafiq v1.1 contracts §4) for
// e2e tests: listens on argv[2], answers NDJSON requests, and appends each
// op name (never a payload) to argv[3]. One allowed window, fullscreen at (0,0)
// of a 1280x800 capture; clicks outside it are refused with "outside".
// A private overlay surface at (300,20) is excluded even inside that window.
import { appendFileSync, chmodSync } from "node:fs";
import { createServer } from "node:net";

const [socketPath, opsLog] = process.argv.slice(2);
const PNG_PREFIX = "iVBORw0KGgo";
let session = null;
let captures = 0;
const windowOf = (allowed) => ({
  windowId: 1,
  appId: "org.gimp.GIMP",
  title: allowed ? "beach.xcf – GIMP" : "",
  x: 0,
  y: 0,
  w: allowed ? 1280 : 0,
  h: allowed ? 800 : 0,
  focused: true,
  allowed,
});
const refuse = (code, message) => ({ ok: false, error: { code, message } });

function answer(request) {
  appendFileSync(opsLog, `${request.op}\n`);
  switch (request.op) {
    case "apps":
      return { ok: true, data: [{ appId: "org.gimp.GIMP", name: "GIMP" }] };
    case "describeAt":
      return {
        ok: true,
        data: request.x === 40 ? { role: "push button", name: "Export" } : { role: "unknown" },
      };
    case "begin":
      session = request.sessionId;
      return { ok: true, data: null };
    case "windows":
      return { ok: true, data: [windowOf(session !== null)] };
    case "capture":
      if (session === null) return refuse("no-session", "begin first");
      captures++;
      return {
        ok: true,
        data: {
          pngBase64: `${PNG_PREFIX}${"A".repeat(captures * 4)}`,
          width: 1280,
          height: 800,
          scale: 1,
          windows: [windowOf(true)],
        },
      };
    case "click":
      if (session === null) return refuse("no-session", "begin first");
      if (request.x < 0 || request.y < 0 || request.x >= 1280 || request.y >= 800)
        return refuse("outside", "not in an allowed window");
      if (request.x === 300 && request.y === 20) return refuse("excluded", "excluded surface");
      return { ok: true, data: null };
    case "type":
    case "key":
    case "scroll":
    case "drag":
      return session === null ? refuse("no-session", "begin first") : { ok: true, data: null };
    case "end":
      session = null;
      return { ok: true, data: null };
    default:
      return refuse("failed", "unknown op");
  }
}

createServer((socket) => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim() === "") continue;
      const request = JSON.parse(line);
      socket.write(`${JSON.stringify({ id: request.id, ...answer(request) })}\n`);
    }
  });
}).listen(socketPath, () => {
  chmodSync(socketPath, 0o600);
  process.stdout.write("ready\n");
});
