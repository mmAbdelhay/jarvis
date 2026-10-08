// One prompt, start to finish (spec §5): model -> tool calls -> results ->
// model, until the model answers, the user stops, or 20 steps pass. Safe
// calls run at once; the step's confirm/password calls go on ONE card. Every
// result — data, error, denial, timeout, stop — goes back to the model as a
// tool result, fenced when it carries tool output. A running tool is never
// interrupted: Stop takes effect between calls. Never throws.
import { fenceToolOutput } from "./fence.js";
import { DEFAULT_CONTEXT_TOKENS, fitHistory, historyBudget } from "./context-fit.js";
import { AGENT_TEXT, SYSTEM_PROMPT, toolActivity } from "./messages.js";
import { buildSystemPrompt } from "./safety.js";
import type { AgentEvent } from "./contract.js";
import type { GateCall, GateItemStatus, RiskGate } from "./risk-gate.js";
import type { RegisteredTool, ToolRegistry } from "./tool-registry.js";
import {
  type ModelMessage,
  type ModelProvider,
  type ModelToolCall,
  type ModelToolResult,
  type ModelToolSpec,
  ProviderError,
  type ProviderErrorKind,
  type ToolOutcome,
} from "./types.js";

export const MAX_STEPS = 20;
export const MAX_HISTORY_MESSAGES = 60;
const CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type ToolLoopDeps = {
  provider: ModelProvider;
  registry: ToolRegistry;
  gate: RiskGate;
  toolsEnabled: boolean;
  emit(event: AgentEvent): void;
  newId(): string;
  /** The provider's context size in tokens (context-fit.ts CONTEXT_TOKENS). */
  contextTokens?: number;
};

export type TurnRequest = {
  turnId: string;
  history: readonly ModelMessage[];
  text: string;
  /** Prepended to the model's copy of the prompt only (the doctor's note). */
  context?: string;
  /** Fenced memory notes (memory.ts); placed before the safety rules. */
  notes?: readonly string[];
  signal: AbortSignal;
};

export type TurnEndReason = "done" | "stopped" | "step-limit" | "error";
export type TurnResult = {
  reason: TurnEndReason;
  error?: string;
  errorKind?: ProviderErrorKind;
  messages: ModelMessage[];
};

const STATUS_TEXT: Record<Exclude<GateItemStatus, "ran">, string> = {
  unticked: AGENT_TEXT.unticked,
  denied: AGENT_TEXT.denied,
  timeout: AGENT_TEXT.timeout,
  stopped: AGENT_TEXT.stopped,
};

export function trimHistory(
  messages: readonly ModelMessage[],
  max = MAX_HISTORY_MESSAGES,
): ModelMessage[] {
  if (messages.length <= max) return [...messages];
  let start = messages.length - max;
  while (start < messages.length && messages[start]?.role !== "user") start++;
  return messages.slice(start);
}

function withUsableIds(calls: readonly ModelToolCall[], newId: () => string): ModelToolCall[] {
  const seen = new Set<string>();
  return calls.map((call) => {
    const id = CALL_ID.test(call.id) && !seen.has(call.id) ? call.id : newId();
    seen.add(id);
    return { ...call, id };
  });
}

const note = (call: ModelToolCall, content: string, isError = false): ModelToolResult => ({
  callId: call.id,
  name: call.name,
  content,
  isError,
});

const fenced = (
  call: ModelToolCall,
  tool: RegisteredTool,
  outcome: ToolOutcome,
): ModelToolResult => ({
  callId: call.id,
  name: call.name,
  content: fenceToolOutput(tool.name, outcome.text),
  isError: !outcome.ok,
});

async function streamReply(
  deps: ToolLoopDeps,
  request: {
    system: string;
    messages: ModelMessage[];
    tools: ModelToolSpec[];
    signal: AbortSignal;
  },
  turnId: string,
): Promise<{ text: string; calls: ModelToolCall[] }> {
  let text = "";
  const calls: ModelToolCall[] = [];
  for await (const event of deps.provider.chat(request)) {
    if (event.type === "text") {
      if (event.delta === "") continue;
      text += event.delta;
      deps.emit({ type: "text", turnId, delta: event.delta });
    } else if (event.type === "tool_call") {
      calls.push({ id: event.id, name: event.name, input: event.input });
    } else {
      break;
    }
  }
  return { text, calls };
}

async function runCalls(
  deps: ToolLoopDeps,
  context: { turnId: string; calls: ModelToolCall[]; signal: AbortSignal; ran: string[] },
): Promise<ModelToolResult[]> {
  const { turnId, signal } = context;
  const results = new Map<string, ModelToolResult>();
  const gated: { call: ModelToolCall; gateCall: GateCall }[] = [];

  const execute = async (callId: string, tool: RegisteredTool, input: Record<string, unknown>) => {
    context.ran.push(tool.name);
    const activity = toolActivity(tool.name);
    deps.emit({
      type: "tool",
      turnId,
      callId,
      name: tool.name,
      status: "running",
      summary: activity,
    });
    const outcome = await deps.registry.call(tool.name, input);
    deps.emit({
      type: "tool",
      turnId,
      callId,
      name: tool.name,
      status: outcome.ok ? "ok" : "error",
      // Never the tool's output: it may hold a secret the gate has not scrubbed yet.
      summary: outcome.ok ? activity : AGENT_TEXT.toolFailed(activity, outcome.code),
    });
    return outcome;
  };

  for (const call of context.calls) {
    const tool = deps.toolsEnabled ? deps.registry.resolve(call.name) : undefined;
    if (tool === undefined) {
      results.set(call.id, note(call, AGENT_TEXT.unknownTool(call.name), true));
      continue;
    }
    const input = deps.registry.sanitizeInput(tool, call.input);
    if (tool.risk !== "safe") {
      gated.push({ call, gateCall: { callId: call.id, tool, input } });
      continue;
    }
    if (signal.aborted) {
      results.set(call.id, note(call, AGENT_TEXT.stopped));
      continue;
    }
    results.set(call.id, fenced(call, tool, await execute(call.id, tool, input)));
  }

  if (gated.length > 0) {
    if (signal.aborted) {
      for (const { call } of gated) results.set(call.id, note(call, AGENT_TEXT.stopped));
    } else {
      try {
        const outcomes = await deps.gate.runBatch({
          turnId,
          via: "desktop",
          calls: gated.map((g) => g.gateCall),
          signal,
          execute: (gateCall, input) => execute(gateCall.callId, gateCall.tool, input),
        });
        for (const outcome of outcomes) {
          const entry = gated.find((g) => g.call.id === outcome.callId);
          if (entry === undefined) continue;
          if (outcome.status === "ran" && outcome.outcome !== undefined) {
            const ran = fenced(entry.call, entry.gateCall.tool, outcome.outcome);
            // A batch tool ran with only its ticked elements: say so, outside the fence.
            if (outcome.skippedItems > 0)
              ran.content += `\n${AGENT_TEXT.someUnticked(outcome.skippedItems)}`;
            results.set(outcome.callId, ran);
          } else {
            results.set(
              outcome.callId,
              note(
                entry.call,
                outcome.status === "ran" ? AGENT_TEXT.stopped : STATUS_TEXT[outcome.status],
              ),
            );
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const { call } of gated)
          results.set(call.id, note(call, AGENT_TEXT.gateFailed(message), true));
      }
    }
  }
  return context.calls.map((call) => results.get(call.id) ?? note(call, AGENT_TEXT.stopped));
}

async function reportStepLimit(
  deps: ToolLoopDeps,
  context: {
    system: string;
    messages: ModelMessage[];
    signal: AbortSignal;
    turnId: string;
    ran: string[];
    budget: number;
  },
): Promise<void> {
  context.messages.push({ role: "user", text: AGENT_TEXT.stepLimitNote(MAX_STEPS) });
  let text = "";
  try {
    const reply = await streamReply(
      deps,
      {
        system: context.system,
        messages: fitHistory(context.messages, context.budget),
        tools: [],
        signal: context.signal,
      },
      context.turnId,
    );
    text = reply.text;
  } catch (error) {
    if (context.signal.aborted) throw error;
  }
  if (text.trim() === "") {
    text = AGENT_TEXT.stepLimitFallback(MAX_STEPS, context.ran);
    deps.emit({ type: "text", turnId: context.turnId, delta: text });
  }
  context.messages.push({ role: "assistant", text, toolCalls: [] });
}

export async function runTurn(deps: ToolLoopDeps, request: TurnRequest): Promise<TurnResult> {
  const { turnId, signal } = request;
  const prompt =
    request.context === undefined ? request.text : `${request.context}\n\n${request.text}`;
  const messages: ModelMessage[] = [...request.history, { role: "user", text: prompt }];
  const tools = deps.toolsEnabled ? deps.registry.modelTools() : [];
  const base = deps.toolsEnabled ? SYSTEM_PROMPT : `${SYSTEM_PROMPT}\n\n${AGENT_TEXT.noToolsNote}`;
  // Design 3.1: the safety rules close EVERY request's system text; only the
  // history is cut to fit the context, never the rules.
  const system = buildSystemPrompt(base, request.notes ?? []);
  const budget = historyBudget(deps.contextTokens ?? DEFAULT_CONTEXT_TOKENS, system, tools);
  const ran: string[] = [];

  const finish = (reason: TurnEndReason, failure?: unknown): TurnResult => {
    const error =
      failure === undefined
        ? undefined
        : failure instanceof Error
          ? failure.message
          : String(failure);
    deps.emit({ type: "turn-end", turnId, reason, ...(error === undefined ? {} : { error }) });
    return {
      reason,
      messages,
      ...(error === undefined ? {} : { error }),
      ...(failure instanceof ProviderError ? { errorKind: failure.kind } : {}),
    };
  };

  deps.emit({ type: "turn-start", turnId, text: request.text });
  try {
    for (let step = 0; ; step++) {
      if (signal.aborted) return finish("stopped");
      if (step === MAX_STEPS) {
        await reportStepLimit(deps, { system, messages, signal, turnId, ran, budget });
        return finish("step-limit");
      }
      const reply = await streamReply(
        deps,
        { system, messages: fitHistory(messages, budget), tools, signal },
        turnId,
      );
      const calls = withUsableIds(reply.calls, deps.newId);
      messages.push({ role: "assistant", text: reply.text, toolCalls: calls });
      if (calls.length === 0) return finish("done");
      messages.push({
        role: "tool",
        results: await runCalls(deps, { turnId, calls, signal, ran }),
      });
    }
  } catch (error) {
    if (signal.aborted) return finish("stopped");
    return finish("error", error);
  }
}
