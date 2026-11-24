// The renderer's terminal:agentAttach request, on its way to the core. The
// file's bytes cannot cross a daemon's JSON frames, so main hands them to the
// core client's binary lane instead of forwarding the request as it came.
// Everything is checked here too (shape and the 25 MB limit) so a bad request
// never opens the lane; the core's own handler still applies its full checks.

import { AGENT_ATTACH_MAX_BYTES, type AgentAttachResult } from "./agent-attach.js";

export type AgentAttachClient = {
  attachAgentFile(paneKey: string, name: string, bytes: Uint8Array): Promise<unknown>;
};

function bytesOf(value: unknown): Uint8Array | undefined {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return undefined;
}

export async function attachFromRenderer(
  client: AgentAttachClient,
  args: readonly unknown[],
): Promise<AgentAttachResult | unknown> {
  const [paneKey, file] = args;
  if (typeof paneKey !== "string" || typeof file !== "object" || file === null) {
    return { ok: false, reason: "invalid" };
  }
  const { name, bytes: raw } = file as { name?: unknown; bytes?: unknown };
  const bytes = bytesOf(raw);
  if (typeof name !== "string" || bytes === undefined || bytes.byteLength === 0) {
    return { ok: false, reason: "invalid" };
  }
  if (bytes.byteLength > AGENT_ATTACH_MAX_BYTES) return { ok: false, reason: "toolarge" };
  try {
    return await client.attachAgentFile(paneKey, name, bytes);
  } catch {
    return { ok: false, reason: "failed" };
  }
}
