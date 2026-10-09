// One prompt, start to finish (spec §5): model -> tool calls -> results ->
// model, until the model answers, the user stops, or 20 steps pass. Safe
// calls run together, four at a time; the step's confirm/password calls go on ONE card. Every
// result — data, error, denial, timeout, stop — goes back to the model as a
// tool result, fenced when it carries tool output. A running tool is never
// interrupted: Stop takes effect between calls. Never throws.
import { SIMPLE_PROFILE, type ToolProfile } from "./backup.js";
import type { ComputerUse } from "./computer-use.js";
import { fenceToolOutput } from "./fence.js";
import { keepLatestImages, stripImages } from "./images.js";
import { isScreenTool } from "./screen-tools.js";
import { DEFAULT_CONTEXT_TOKENS, fitHistory, historyBudget } from "./context-fit.js";
import { mapLimit } from "./map-limit.js";
import { type Lang, languageRule } from "./i18n.js";
import { AGENT_TEXT, RECIPE_TEXT, SYSTEM_PROMPT, toolActivity, USER_TEXT } from "./messages.js";
import type { RecipeEngine } from "./recipe-engine.js";
import { RECIPE_RUN_TOOL } from "./recipes.js";
import { buildSystemPrompt } from "./safety.js";
import type { AgentEvent, AuditVia } from "./contract.js";
import type { GateCall, GateItemStatus, RiskGate } from "./risk-gate.js";
import { callRisk, type RegisteredTool, type ToolRegistry } from "./tool-registry.js";
import {
  type ModelChatRequest,
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

/** The usual model's profile: every tool, MAX_STEPS steps. */
export const FULL_PROFILE: ToolProfile = { name: "full", maxSteps: MAX_STEPS, allows: () => true };

/** Design §3.4: a step's safe calls run at most this many at once. */
export const SAFE_CALL_CONCURRENCY = 4;
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
  /** Design §3.8: picks this turn's tools from all of them (tool-search.ts). */
  selectTools?(text: string, tools: ModelToolSpec[]): Promise<ModelToolSpec[]>;
  /** M4 §1: the profile of the provider answering now (the failover's status).
   *  Read at the first event of each reply and after it. Default FULL_PROFILE. */
  profile?(): ToolProfile;
  /** M4 §4: runs recipes.run itself (one card item per step). Absent: recipes.run is refused. */
  recipes?: RecipeEngine;
  /** v1.1 §2: runs screen.* calls, one at a time in the model's order. Absent: they are unknown tools. */
  computerUse?: ComputerUse;
  /** v1.1: the turn's step cap now (CU_TURN_MAX_STEPS once a session ran).
   *  The cap only ever rises within a turn; default MAX_STEPS. */
  maxSteps?(): number;
};

export type TurnRequest = {
  turnId: string;
  history: readonly ModelMessage[];
  text: string;
  /** Prepended to the model's copy of the prompt only (the doctor's note). */
  context?: string;
  /** Fenced memory notes (memory.ts); placed before the safety rules. */
  notes?: readonly string[];
  /** The turn's language (M4 §3): activity lines, step-limit text, cards. */
  lang?: Lang;
  /** Who asked (M3 §2). Computer use refuses phone-origin turns. Default desktop. */
  via?: AuditVia;
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
  request: ModelChatRequest,
  turnId: string,
  onFirstEvent: () => void = () => {},
): Promise<{ text: string; calls: ModelToolCall[] }> {
  let text = "";
  const calls: ModelToolCall[] = [];
  let first = true;
  for await (const event of deps.provider.chat(request)) {
    if (first) {
      first = false;
      onFirstEvent();
    }
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
  context: {
    turnId: string;
    calls: ModelToolCall[];
    signal: AbortSignal;
    ran: string[];
    lang: Lang;
    via: AuditVia;
    allows(tool: string): boolean;
    /** Tools resolve at all: the deps' toolsEnabled, or the simple profile. */
    toolsOn: boolean;
  },
): Promise<ModelToolResult[]> {
  const { turnId, signal } = context;
  const results = new Map<string, ModelToolResult>();
  const gated: { call: ModelToolCall; gateCall: GateCall }[] = [];
  const safe: { call: ModelToolCall; tool: RegisteredTool; input: Record<string, unknown> }[] = [];

  const recipeCalls: {
    call: ModelToolCall;
    tool: RegisteredTool;
    input: Record<string, unknown>;
  }[] = [];
  const screenCalls: {
    call: ModelToolCall;
    tool: RegisteredTool;
    input: Record<string, unknown>;
  }[] = [];
  const runners = new Map<string, (input: Record<string, unknown>) => Promise<ToolOutcome>>();

  const execute = async (callId: string, tool: RegisteredTool, input: Record<string, unknown>) => {
    context.ran.push(tool.name);
    const activity = toolActivity(tool.name, context.lang);
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
      summary: outcome.ok ? activity : USER_TEXT[context.lang].toolFailed(activity, outcome.code),
    });
    return outcome;
  };

  for (const call of context.calls) {
    const resolved = context.toolsOn ? deps.registry.resolve(call.name) : undefined;
    // M4 §1: on the backup model, a tool outside the simple profile does not exist.
    const tool = resolved !== undefined && context.allows(resolved.name) ? resolved : undefined;
    if (tool === undefined) {
      results.set(call.id, note(call, AGENT_TEXT.unknownTool(call.name), true));
      continue;
    }
    const input = deps.registry.sanitizeInput(tool, call.input);
    if (isScreenTool(tool.name)) {
      // v1.1 §2: the session card is their approval; jarvisd runs them itself.
      screenCalls.push({ call, tool, input });
      continue;
    }
    if (tool.name === RECIPE_RUN_TOOL) {
      // M4 §4: jarvisd runs a recipe itself; recipes.run never reaches its server.
      recipeCalls.push({ call, tool, input });
      continue;
    }
    if (callRisk(tool, input) !== "safe") {
      gated.push({ call, gateCall: { callId: call.id, tool, input } });
      continue;
    }
    safe.push({ call, tool, input });
  }

  // Safe calls run together (at most SAFE_CALL_CONCURRENCY); Stop takes effect
  // before a call starts, never during one. The card comes after all of them.
  await mapLimit(safe, SAFE_CALL_CONCURRENCY, async ({ call, tool, input }) => {
    if (signal.aborted) {
      results.set(call.id, note(call, AGENT_TEXT.stopped));
      return;
    }
    results.set(call.id, fenced(call, tool, await execute(call.id, tool, input)));
  });

  for (const { call, tool, input } of screenCalls) {
    if (deps.computerUse === undefined) {
      results.set(call.id, note(call, AGENT_TEXT.unknownTool(call.name), true));
      continue;
    }
    if (signal.aborted) {
      results.set(call.id, note(call, AGENT_TEXT.stopped));
      continue;
    }
    context.ran.push(tool.name);
    const activity = toolActivity(tool.name, context.lang);
    deps.emit({
      type: "tool",
      turnId,
      callId: call.id,
      name: tool.name,
      status: "running",
      summary: activity,
    });
    const ran = await deps.computerUse.run(tool, input, {
      turnId,
      lang: context.lang,
      via: context.via,
      signal,
    });
    deps.emit({
      type: "tool",
      turnId,
      callId: call.id,
      name: tool.name,
      status: ran.isError ? "error" : "ok",
      summary: ran.isError ? USER_TEXT[context.lang].toolFailed(activity, undefined) : activity,
    });
    results.set(call.id, {
      callId: call.id,
      name: call.name,
      // jarvisd's note stays outside the fence; window titles are untrusted data.
      content:
        ran.untrusted === undefined
          ? ran.text
          : `${ran.text}\n${fenceToolOutput(tool.name, ran.untrusted)}`,
      isError: ran.isError,
      ...(ran.image === undefined ? {} : { image: ran.image }),
    });
  }

  for (const { call, tool, input } of recipeCalls) {
    if (deps.recipes === undefined) {
      results.set(call.id, note(call, RECIPE_TEXT.unavailable, true));
      continue;
    }
    if (signal.aborted) {
      results.set(call.id, note(call, AGENT_TEXT.stopped));
      continue;
    }
    try {
      const prepared = await deps.recipes.prepare(input, {
        registry: deps.registry,
        lang: context.lang,
        callStep: (index, stepTool, stepInput) =>
          execute(`${call.id}-step${index + 1}`, stepTool, stepInput),
      });
      if (!prepared.ok) {
        results.set(call.id, note(call, prepared.outcome.text, true));
        continue;
      }
      runners.set(call.id, (runInput) => prepared.prepared.run(runInput, signal));
      gated.push({
        call,
        gateCall: { callId: call.id, tool, input, preset: prepared.prepared.preset },
      });
    } catch (error) {
      results.set(
        call.id,
        note(
          call,
          AGENT_TEXT.gateFailed(error instanceof Error ? error.message : String(error)),
          true,
        ),
      );
    }
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
          lang: context.lang,
          execute: (gateCall, input) =>
            runners.get(gateCall.callId)?.(input) ?? execute(gateCall.callId, gateCall.tool, input),
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
    lang: Lang;
    steps: number;
  },
): Promise<void> {
  context.messages.push({ role: "user", text: AGENT_TEXT.stepLimitNote(context.steps) });
  let text = "";
  try {
    const reply = await streamReply(
      deps,
      {
        system: context.system,
        messages: fitHistory(keepLatestImages(context.messages), context.budget),
        tools: [],
        final: true,
        signal: context.signal,
      },
      context.turnId,
    );
    text = reply.text;
  } catch (error) {
    if (context.signal.aborted) throw error;
  }
  if (text.trim() === "") {
    text = USER_TEXT[context.lang].stepLimitFallback(context.steps, context.ran);
    deps.emit({ type: "text", turnId: context.turnId, delta: text });
  }
  context.messages.push({ role: "assistant", text, toolCalls: [] });
}

export async function runTurn(deps: ToolLoopDeps, request: TurnRequest): Promise<TurnResult> {
  const { turnId, signal } = request;
  const lang: Lang = request.lang ?? "en";
  const prompt =
    request.context === undefined ? request.text : `${request.context}\n\n${request.text}`;
  const messages: ModelMessage[] = [...request.history, { role: "user", text: prompt }];
  const allTools = deps.toolsEnabled ? deps.registry.modelTools() : [];
  let tools = allTools;
  const base = `${
    deps.toolsEnabled ? SYSTEM_PROMPT : `${SYSTEM_PROMPT}\n\n${AGENT_TEXT.noToolsNote}`
  }\n\n${languageRule(lang)}`;
  // Design 3.1: the safety rules close EVERY request's system text; only the
  // history is cut to fit the context, never the rules.
  const system = buildSystemPrompt(base, request.notes ?? []);
  let budget = historyBudget(deps.contextTokens ?? DEFAULT_CONTEXT_TOKENS, system, tools);
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
      messages: stripImages(messages),
      ...(error === undefined ? {} : { error }),
      ...(failure instanceof ProviderError ? { errorKind: failure.kind } : {}),
    };
  };

  let profile: ToolProfile = FULL_PROFILE;
  let profileSteps = 0;
  let turnCap = MAX_STEPS;
  let noticed = false;
  // The failover switches inside chat(); the profile is read at the reply's
  // first event (for the notice) and after it (for the cap and the tools).
  const readProfile = () => {
    const now = deps.profile?.() ?? FULL_PROFILE;
    if (now.name === profile.name) return;
    profile = now;
    profileSteps = 0;
    if (now.name === "simple" && !noticed) {
      noticed = true;
      deps.emit({ type: "text", turnId, delta: `${USER_TEXT[lang].backupNotice}\n\n` });
    }
  };

  deps.emit({ type: "turn-start", turnId, text: request.text });
  try {
    if (deps.selectTools !== undefined && allTools.length > 0) {
      try {
        const picked = await deps.selectTools(request.text, allTools);
        if (picked.length > 0) tools = picked;
      } catch {
        tools = allTools;
      }
      budget = historyBudget(deps.contextTokens ?? DEFAULT_CONTEXT_TOKENS, system, tools);
    }
    for (let step = 0; ; step++) {
      if (signal.aborted) return finish("stopped");
      turnCap = Math.max(turnCap, deps.maxSteps?.() ?? MAX_STEPS);
      // The usual (full) profile follows the turn's raised cap; the backup's own cap stays.
      const profileCap = profile.name === FULL_PROFILE.name ? turnCap : profile.maxSteps;
      const cap = step >= turnCap ? turnCap : profileSteps >= profileCap ? profileCap : undefined;
      if (cap !== undefined) {
        await reportStepLimit(deps, {
          system,
          messages,
          signal,
          turnId,
          ran,
          budget,
          lang,
          steps: cap,
        });
        return finish("step-limit");
      }
      const reply = await streamReply(
        deps,
        { system, messages: fitHistory(keepLatestImages(messages), budget), tools, signal },
        turnId,
        readProfile,
      );
      readProfile();
      profileSteps++;
      const calls = withUsableIds(reply.calls, deps.newId);
      messages.push({ role: "assistant", text: reply.text, toolCalls: calls });
      if (calls.length === 0) return finish("done");
      messages.push({
        role: "tool",
        results: await runCalls(deps, {
          turnId,
          calls,
          signal,
          ran,
          lang,
          via: request.via ?? "desktop",
          allows: (name) => profile.allows(name),
          // M4 §1: the simple profile always has its tools, even when the
          // usual model that started the turn could not call any.
          toolsOn: deps.toolsEnabled || profile.name === SIMPLE_PROFILE.name,
        }),
      });
    }
  } catch (error) {
    if (signal.aborted) return finish("stopped");
    return finish("error", error);
  }
}
