// A tiny stdio MCP server for tests (newline-delimited JSON-RPC 2.0).
// Usage: node fake-mcp-server.mjs <serverName>
// Env: FAKE_MCP_PROTOCOL overrides the protocol version it answers with.
import { createInterface } from "node:readline";

const serverName = process.argv[2] ?? "jarvis-pkg";
const protocol = process.env.FAKE_MCP_PROTOCOL ?? "2025-06-18";
const meta = (risk, extra = {}) => ({ jarvis: { risk, hidden: false, secrets: [], ...extra } });
const object = (properties = {}, required = []) => ({ type: "object", properties, required });

const TOOLS = [
  {
    name: "pkg.search",
    description: "Search apps",
    inputSchema: object({ query: { type: "string" } }, ["query"]),
    _meta: meta("safe"),
  },
  {
    name: "pkg.install",
    description: "Install apps",
    inputSchema: object({ items: { type: "array" } }, ["items"]),
    // Contracts §6 #1: one card item per element of `items`.
    _meta: meta("confirm", { batch: "items" }),
  },
  {
    name: "net.wifi_connect",
    description: "Join a Wi-Fi network",
    inputSchema: object(
      { ssid: { type: "string" }, password: { type: "string", title: "Wi-Fi password" } },
      ["ssid"],
    ),
    _meta: meta("confirm", { secrets: ["password"] }),
  },
  { name: "test.crash", description: "Exit", inputSchema: object(), _meta: meta("safe") },
  { name: "updates.list", description: "List updates", inputSchema: object(), _meta: meta("safe") },
  {
    name: "updates.apply",
    description: "Apply updates",
    inputSchema: object({ items: { type: "array", maxItems: 200 } }, ["items"]),
    _meta: meta("confirm", { batch: "items" }),
  },
  {
    name: "jarvis.describe",
    description: "Describe a call",
    inputSchema: object({ tool: { type: "string" }, input: { type: "object" } }, ["tool", "input"]),
    _meta: meta("safe", { hidden: true }),
  },
];

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const result = (data) => ({
  structuredContent: data,
  content: [{ type: "text", text: JSON.stringify(data) }],
});

function call(name, args) {
  switch (name) {
    case "pkg.search":
      return result({
        results: [
          { source: "apt", id: args.query, name: args.query, version: "1.0", summary: "x" },
        ],
      });
    case "pkg.install":
      return result({
        installed: (args.items ?? []).map((i) => ({ ...i, version: "1.0" })),
        failed: [],
      });
    case "net.wifi_connect":
      // Deliberately echoes the password so jarvisd's scrubbing is exercised.
      return result({ ssid: args.ssid, state: "activated", note: `used ${args.password ?? ""}` });
    case "updates.list":
      return result({
        items: [
          { source: "apt", id: "jarvis-shell", from: "0.1.0", to: "0.2.0", security: false },
          { source: "apt", id: "openssl", from: "3.5.1-1", to: "3.5.1-1+deb13u1", security: true },
        ],
        checkedAt: "2026-10-08T09:00:00Z",
      });
    case "updates.apply":
      return result({
        upgraded: (args.items ?? []).map((i) => ({ ...i, version: "2.0" })),
        failed: [],
      });
    case "jarvis.describe":
      return result({
        title: `${args.tool} on ${serverName}`,
        detail: JSON.stringify(args.input),
        source: args.input?.items?.[0]?.source === "flatpak" ? "flathub" : "debian",
      });
    case "test.crash":
      process.exit(3);
      return undefined;
    default:
      return {
        isError: true,
        structuredContent: { code: "not_found", message: `no tool ${name}` },
        content: [{ type: "text", text: `no tool ${name}` }],
      };
  }
}

process.stderr.write(`${serverName} starting\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "") return;
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  switch (message.method) {
    case "initialize":
      send({
        id: message.id,
        result: {
          protocolVersion: protocol,
          capabilities: { tools: {} },
          serverInfo: { name: serverName, version: "0" },
        },
      });
      break;
    case "tools/list":
      if (message.params?.cursor === "p2")
        send({ id: message.id, result: { tools: TOOLS.slice(2) } });
      else send({ id: message.id, result: { tools: TOOLS.slice(0, 2), nextCursor: "p2" } });
      break;
    case "tools/call":
      send({ id: message.id, result: call(message.params.name, message.params.arguments ?? {}) });
      break;
    default:
      send({ id: message.id, error: { code: -32601, message: "Method not found" } });
  }
});
