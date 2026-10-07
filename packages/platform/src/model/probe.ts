// probe() for every adapter (spec §4): list models, then one tiny tool-call
// request. A model that refuses tools with a 400 is retried without them; if
// that works it is saved with a warning ("can chat, can't control the OS").
import {
  type ModelChatRequest,
  type ModelEvent,
  type ModelToolSpec,
  type ProbeResult,
  ProviderError,
} from "@jarvis/core";
import { describeError } from "./http.js";

export const PROBE_TOOL: ModelToolSpec = {
  name: "ping",
  description: "Answer a connectivity check. Call it with no arguments.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

export async function probeProvider(options: {
  listModels(signal: AbortSignal): Promise<string[]>;
  chat(request: ModelChatRequest): AsyncIterable<ModelEvent>;
  timeoutMs?: number;
}): Promise<ProbeResult> {
  const timeout = () => AbortSignal.timeout(options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  let models: string[];
  try {
    models = await options.listModels(timeout());
  } catch (error) {
    return { ok: false, supportsTools: false, models: [], error: describeError(error) };
  }
  const ask = async (tools: ModelToolSpec[]): Promise<boolean> => {
    let called = false;
    for await (const event of options.chat({
      system: "You are answering a connectivity check.",
      messages: [
        {
          role: "user",
          text: tools.length > 0 ? "Call the ping tool now." : "Reply with the word pong.",
        },
      ],
      tools,
      signal: timeout(),
    })) {
      if (event.type === "tool_call") called = true;
    }
    return called;
  };
  try {
    return { ok: true, supportsTools: await ask([PROBE_TOOL]), models };
  } catch (error) {
    if (error instanceof ProviderError && error.kind === "http" && error.status === 400) {
      try {
        await ask([]);
        return { ok: true, supportsTools: false, models };
      } catch (second) {
        return { ok: false, supportsTools: false, models, error: describeError(second) };
      }
    }
    return { ok: false, supportsTools: false, models, error: describeError(error) };
  }
}
