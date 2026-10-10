// Plan Y §2.3: an account CLI as a ModelProvider. Stateless like the other
// adapters: ToolLoop passes the whole history, rendered with the nonce-fenced
// text tool protocol; replies come back as text + tool_call events, so the
// registry, RiskGate, failover and caps apply unchanged. The first sign that
// the vendor answered becomes an empty text event: that is the failover's
// "first event" (M4 §6 #12: never switch mid-answer), so a missing login or a
// network failure before it still fails over.
import {
  lastImage,
  type ModelEvent,
  type ModelProvider,
  type ModelUsage,
  parseTextToolReply,
  ProviderError,
  redactSecrets,
  renderTextToolPrompt,
} from "@jarvis/core";
import { type CliSpawner, runCli } from "./runner.js";
import { ACCOUNT_LABELS, type AccountPaths, type AccountPin, turnInvocation } from "./specs.js";
import type { AccountErrorCode } from "./stream-types.js";
import { streamFor } from "./streams-index.js";

export type AccountReadiness = "ready" | "not-installed" | "signed-out" | "no-sandbox";
export type AccountProviderTexts = {
  notInstalled(label: string): string;
  signIn(label: string): string;
  rateLimited(label: string): string;
  unreachable(label: string): string;
  failed(label: string, detail: string): string;
  tripwire(label: string): string;
  sandboxOff(): string;
};

const PROBE_TIMEOUT_MS = 120_000;

export function createAccountProvider(options: {
  pin: AccountPin;
  model: string;
  paths: AccountPaths;
  spawn: CliSpawner;
  nonce(): string;
  texts: AccountProviderTexts;
  readiness(): Promise<AccountReadiness>;
}): ModelProvider {
  const { pin, texts } = options;
  const label = ACCOUNT_LABELS[pin.account];
  const models = pin.models.map((model) => model.id);
  let seq = 0;

  function notReady(state: AccountReadiness): ProviderError | undefined {
    switch (state) {
      case "ready":
        return undefined;
      case "not-installed":
        return new ProviderError("auth", texts.notInstalled(label));
      case "signed-out":
        return new ProviderError("auth", texts.signIn(label));
      case "no-sandbox":
        return new ProviderError("auth", texts.sandboxOff());
    }
  }

  function toError(code: AccountErrorCode, detail: string): ProviderError {
    switch (code) {
      case "not-signed-in":
        return new ProviderError("auth", texts.signIn(label));
      case "rate-limit":
        return new ProviderError("http", texts.rateLimited(label), 429);
      case "unavailable":
        return new ProviderError("network", texts.unreachable(label));
      case "failed":
        return new ProviderError(
          "bad-response",
          texts.failed(label, redactSecrets(detail).slice(0, 300)),
        );
    }
  }

  const provider: ModelProvider = {
    async *chat(request) {
      const blocked = notReady(await options.readiness());
      if (blocked !== undefined) throw blocked;
      const nonce = options.nonce();
      const tools = request.final === true ? [] : request.tools;
      const prompt = renderTextToolPrompt(
        { system: request.system, messages: request.messages, tools },
        nonce,
      );
      const image = pin.account === "claude" ? lastImage(request.messages) : undefined;
      const inv = turnInvocation(
        pin,
        options.paths,
        options.model,
        image === undefined ? { text: prompt } : { text: prompt, image },
      );
      let reply = "";
      let usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
      let started = false;
      for await (const event of runCli(
        inv,
        options.spawn,
        streamFor(pin.account),
        request.signal,
      )) {
        switch (event.kind) {
          case "progress":
            if (!started) {
              started = true;
              yield { type: "text", delta: "" } satisfies ModelEvent;
            }
            break;
          case "text":
            reply += event.text;
            break;
          case "usage":
            usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
            break;
          case "error":
            throw toError(event.code, event.detail);
          case "tripwire":
            throw new ProviderError("tripwire", texts.tripwire(label));
        }
      }
      const parsed = parseTextToolReply(reply, nonce, new Set(tools.map((tool) => tool.name)));
      if (parsed.text !== "") yield { type: "text", delta: parsed.text };
      for (const call of parsed.calls) {
        seq += 1;
        yield {
          type: "tool_call",
          id: `${pin.account}-${seq}`,
          name: call.name,
          input: call.input,
        };
      }
      yield { type: "done", usage };
    },
    async probe() {
      try {
        for await (const _event of provider.chat({
          system: "You are answering a connectivity check.",
          messages: [{ role: "user", text: "Reply with the word pong." }],
          tools: [],
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        })) {
          // Draining is the check.
        }
        return { ok: true, supportsTools: true, models };
      } catch (error) {
        return {
          ok: false,
          supportsTools: false,
          models,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async listModels() {
      return models;
    },
    async reachable() {
      const blocked = notReady(await options.readiness());
      return blocked === undefined ? { ok: true } : { ok: false, error: blocked.message };
    },
  };
  return provider;
}
