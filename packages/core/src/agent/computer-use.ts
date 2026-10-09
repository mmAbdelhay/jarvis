// packages/core/src/agent/computer-use.ts
// Rafiq v1.1 computer use (contracts §2, design §2–§3.2): runs the model's
// screen.* calls against jarvis-cu. One session card (cu.begin) approves the
// goal and apps; actions then run without cards except consequential ones,
// which get their own card first. Every action is audited (typed text
// redacted, never a screenshot). Pauses on physical input, ends on lock,
// stop, a stuck screen, the 50-action cap, or when the provider answering
// now may no longer see the screen. Never throws to the loop.
import {
  type AuditEntry,
  type AuditVia,
  CU_MAX_STEPS,
  type CuPauseReason,
  type CuState,
} from "./contract.js";
import { type DescribedTarget, detectConsequence } from "./consequential.js";
import { type CuCapture, type CuClient, CuClientError, parseCuErrorCode } from "./cu-protocol.js";
import { CU_IDLE_STATE, type CuEndReason, type CuSession, createCuSession } from "./cu-session.js";
import { CU_MODEL_TEXT, CU_TEXT, joinApps } from "./cu-text.js";
import type { Lang } from "./i18n.js";
import { AGENT_TEXT } from "./messages.js";
import { redactSecrets } from "./redact.js";
import type { GateItemResult, GateItemStatus, RiskGate } from "./risk-gate.js";
import {
  type CaptureBounds,
  CU_BEGIN_REGISTERED,
  CU_BEGIN_TOOL,
  CU_END_TOOL,
  parseScreenAction,
  SCREEN_TOOLS,
  type ScreenAction,
} from "./screen-tools.js";
import type { RegisteredTool } from "./tool-registry.js";
import type { ModelImage, ToolOutcome } from "./types.js";

export const CU_CAPTURE_MAX_EDGE = 1280;
export const CU_PAUSE_TIMEOUT_MS = 600_000;
/** Model replies a turn may take once a session ran: look + act per action, plus slack. */
export const CU_TURN_MAX_STEPS = 2 * CU_MAX_STEPS + 10;

export type CuCallContext = { turnId: string; lang: Lang; via: AuditVia; signal: AbortSignal };
/** `text` is jarvisd's own note; `untrusted` (window titles) is fenced by the loop. */
export type CuCallResult = {
  text: string;
  isError: boolean;
  untrusted?: string;
  image?: ModelImage;
};

export type ComputerUseDeps = {
  client: CuClient;
  gate: RiskGate;
  audit(entry: AuditEntry): Promise<void>;
  emitState(state: CuState): void;
  /** null when computer use may run for the provider answering now; else
   *  the model-facing reason (CU_MODEL_TEXT). Asked before every call. */
  available(): string | null;
  /** A stable digest of a capture (SHA-256 hex in jarvisd). */
  hash(pngBase64: string): Promise<string>;
  now(): number;
  newId(): string;
  timers: {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  log(line: string): void;
};

export interface ComputerUse {
  run(
    tool: RegisteredTool,
    input: Record<string, unknown>,
    context: CuCallContext,
  ): Promise<CuCallResult>;
  state(): CuState;
  active(): boolean;
  /** cu:stop: ends the session; the caller also stops the turn. */
  stop(): Promise<void>;
  /** cu:resume: re-arms the helper and wakes a waiting action. */
  resume(): Promise<void>;
  endSession(why: CuEndReason): Promise<void>;
  /** A new turn may start a new session. */
  beginTurn(): void;
}

const ok = (text: string): CuCallResult => ({ text, isError: false });
const refuse = (text: string): CuCallResult => ({ text, isError: true });
const STATUS_TEXT: Record<Exclude<GateItemStatus, "ran">, string> = {
  unticked: AGENT_TEXT.unticked,
  denied: AGENT_TEXT.denied,
  timeout: AGENT_TEXT.timeout,
  stopped: AGENT_TEXT.stopped,
};
const MAX_AUDIT_TEXT = 200;

function errorOf(error: unknown): { code: string; text: string } {
  if (error instanceof CuClientError) return { code: error.code, text: error.message };
  return { code: "failed", text: error instanceof Error ? error.message : String(error) };
}

/** What the audit log keeps of an action: no screenshot, typed text redacted and cut. */
export function cuAuditInput(action: ScreenAction): Record<string, unknown> {
  const intent = "intent" in action && action.intent !== undefined ? { intent: action.intent } : {};
  switch (action.kind) {
    case "click":
      return {
        x: action.x,
        y: action.y,
        button: action.button,
        double: action.double,
        target: action.target,
        ...intent,
      };
    case "type":
      return {
        text: redactSecrets(action.text).slice(0, MAX_AUDIT_TEXT),
        chars: [...action.text].length,
        target: action.target,
      };
    case "key":
      return { combo: action.combo, ...intent };
    case "scroll":
      return { x: action.x, y: action.y, dx: action.dx, dy: action.dy };
    case "drag":
      return {
        x1: action.x1,
        y1: action.y1,
        x2: action.x2,
        y2: action.y2,
        target: action.target,
        ...intent,
      };
    case "look":
      return {
        ...(action.goal === undefined ? {} : { goal: action.goal }),
        ...(action.apps === undefined ? {} : { apps: action.apps }),
      };
    case "done":
      return { summary: redactSecrets(action.summary).slice(0, MAX_AUDIT_TEXT) };
  }
}

function stepTitle(action: ScreenAction, lang: Lang): string {
  const t = CU_TEXT[lang];
  switch (action.kind) {
    case "click":
      return action.double ? t.stepDoubleClick(action.target) : t.stepClick(action.target);
    case "type":
      return t.stepType(action.target, [...action.text].length);
    case "key":
      return t.stepKey(action.combo);
    case "scroll":
      return t.stepScroll;
    case "drag":
      return t.stepDrag(action.target);
    default:
      return "";
  }
}

const sameApps = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((app) => b.includes(app));

export function createComputerUse(deps: ComputerUseDeps): ComputerUse {
  let session: CuSession | undefined;
  let closedForTurn = false;
  let bounds: CaptureBounds | null = null;
  let needsLook = true;
  let lastTyped: string | undefined;
  let lastPause: CuPauseReason = "physical-input";
  let lastState: CuState = CU_IDLE_STATE;
  const waiters = new Set<(how: "resumed" | "stopped") => void>();

  const emit = () => {
    if (session !== undefined) lastState = session.state();
    deps.emitState(lastState);
  };

  async function writeAudit(entry: Omit<AuditEntry, "ts">): Promise<void> {
    try {
      await deps.audit({ ts: deps.now(), ...entry });
    } catch (error) {
      deps.log(`[cu] audit write failed: ${errorOf(error).code}`);
    }
  }

  async function endSession(why: CuEndReason): Promise<void> {
    const ending = session;
    if (ending === undefined) return;
    session = undefined;
    bounds = null;
    needsLook = true;
    lastTyped = undefined;
    for (const wake of [...waiters]) wake("stopped");
    lastState = ending.end(why);
    deps.emitState(lastState);
    try {
      await deps.client.end();
    } catch (error) {
      deps.log(`[cu] end: ${errorOf(error).code}`);
    }
    await writeAudit({
      tool: CU_END_TOOL,
      title: CU_TEXT[ending.lang].endTitle(ending.stepCount()),
      input: { reason: why, steps: ending.stepCount() },
      decision: "approved",
      via: ending.via,
      result: "ok",
    });
  }

  deps.client.onPaused((reason) => {
    if (session === undefined) return;
    if (reason === "locked") {
      closedForTurn = true;
      void endSession("locked");
      return;
    }
    lastPause = reason;
    session.pause(reason);
    emit();
  });
  deps.client.onGone(() => {
    if (session === undefined) return;
    closedForTurn = true;
    void endSession("helper");
  });

  function waitForResume(signal: AbortSignal): Promise<"resumed" | "stopped"> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (how: "resumed" | "stopped") => {
        if (settled) return;
        settled = true;
        deps.timers.clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        waiters.delete(finish);
        resolve(how);
      };
      const onAbort = () => finish("stopped");
      const timer = deps.timers.setTimeout(() => {
        finish("stopped");
        closedForTurn = true;
        void endSession("pause-timeout");
      }, CU_PAUSE_TIMEOUT_MS);
      waiters.add(finish);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function clientFailure(error: unknown): Promise<CuCallResult> {
    const { code, text } = errorOf(error);
    switch (code) {
      case "outside":
        return refuse(CU_MODEL_TEXT.outside);
      case "excluded":
        return refuse(CU_MODEL_TEXT.excluded);
      case "paused":
        if (session !== undefined) {
          session.pause(lastPause);
          emit();
        }
        return refuse(CU_MODEL_TEXT.pausedNow);
      case "no-session":
      case "unsupported":
        closedForTurn = true;
        await endSession("helper");
        return refuse(CU_MODEL_TEXT.beginFailed(text));
      default:
        return refuse(CU_MODEL_TEXT.failed(code, text));
    }
  }

  // Contracts §4 #2: discovery before begin is the helper's `apps` op (ids and
  // names, no titles, no rectangles).
  async function needApps(): Promise<CuCallResult> {
    try {
      const apps = await deps.client.apps();
      const list = apps.map((app) => ({ appId: app.appId, name: app.name.slice(0, 120) }));
      return { text: CU_MODEL_TEXT.needApps(""), isError: true, untrusted: JSON.stringify(list) };
    } catch {
      return refuse(CU_MODEL_TEXT.needAppsNoList);
    }
  }

  // Contracts §4 #2: ask the accessibility tree what is under the pointer
  // instead of trusting only the model's target text. A drag acts where it
  // drops. Any failure falls back to the model's own target.
  async function describePoint(action: ScreenAction): Promise<DescribedTarget | undefined> {
    const point =
      action.kind === "click"
        ? [action.x, action.y]
        : action.kind === "drag"
          ? [action.x2, action.y2]
          : undefined;
    if (point === undefined) return undefined;
    try {
      return await deps.client.describeAt(point[0] as number, point[1] as number);
    } catch {
      return undefined;
    }
  }

  function gateResultText(result: GateItemResult | undefined): string {
    if (result === undefined || result.status === "ran") return AGENT_TEXT.stopped;
    return STATUS_TEXT[result.status];
  }

  async function startSession(
    goal: string,
    apps: string[],
    ctx: CuCallContext,
  ): Promise<CuCallResult | undefined> {
    const sessionId = deps.newId();
    const t = CU_TEXT[ctx.lang];
    const [result] = await deps.gate.runBatch({
      turnId: ctx.turnId,
      via: "desktop",
      lang: ctx.lang,
      signal: ctx.signal,
      calls: [
        {
          callId: `${sessionId}-begin`,
          tool: CU_BEGIN_REGISTERED,
          input: { goal, apps: [...apps] },
          preset: {
            elements: [0],
            items: [
              {
                tool: CU_BEGIN_TOOL,
                description: {
                  title: t.sessionTitle(joinApps(apps, ctx.lang), goal),
                  detail: t.sessionDetail,
                  source: "system",
                },
              },
            ],
            resultOf: (_index, outcome) => (outcome.ok ? "ok" : "failed"),
          },
        },
      ],
      execute: async () => {
        try {
          await deps.client.begin(sessionId, apps);
          return { ok: true, data: null, text: "" };
        } catch (error) {
          const e = errorOf(error);
          return { ok: false, data: null, text: e.text, code: e.code };
        }
      },
    });
    if (result === undefined || result.status !== "ran" || result.outcome === undefined) {
      closedForTurn = true;
      const denied = result?.status === "denied" || result?.status === "unticked";
      return refuse(denied ? CU_MODEL_TEXT.sessionDenied : gateResultText(result));
    }
    if (!result.outcome.ok) {
      closedForTurn = true;
      return refuse(CU_MODEL_TEXT.beginFailed(result.outcome.text));
    }
    session = createCuSession({ sessionId, goal, apps, lang: ctx.lang, via: ctx.via });
    emit();
    return undefined;
  }

  async function look(): Promise<CuCallResult> {
    const current = session as CuSession;
    let capture: CuCapture;
    try {
      capture = await deps.client.capture(CU_CAPTURE_MAX_EDGE);
    } catch (error) {
      return clientFailure(error);
    }
    if (session !== current) return refuse(CU_MODEL_TEXT.stoppedByUser);
    bounds = { width: capture.width, height: capture.height };
    needsLook = false;
    if (current.noteCapture(await deps.hash(capture.pngBase64)) === "stuck") {
      closedForTurn = true;
      await endSession("stuck");
      return refuse(CU_MODEL_TEXT.stuck);
    }
    emit();
    const windows = capture.windows
      .filter((w) => w.allowed)
      .map((w) => ({
        appId: w.appId,
        title: w.title.slice(0, 200),
        x: w.x,
        y: w.y,
        w: w.w,
        h: w.h,
        focused: w.focused,
      }));
    return {
      text: CU_MODEL_TEXT.captureHeader(capture.width, capture.height),
      isError: false,
      untrusted: JSON.stringify(windows),
      image: { mediaType: "image/png", dataBase64: capture.pngBase64 },
    };
  }

  async function perform(action: ScreenAction): Promise<ToolOutcome> {
    try {
      switch (action.kind) {
        case "click":
          await deps.client.click(action.x, action.y, action.button, action.double);
          break;
        case "type":
          await deps.client.type(action.text);
          break;
        case "key":
          await deps.client.key(action.combo);
          break;
        case "scroll":
          await deps.client.scroll(action.x, action.y, action.dx, action.dy);
          break;
        case "drag":
          await deps.client.drag(action.x1, action.y1, action.x2, action.y2);
          break;
        default:
          return { ok: false, data: null, text: "not an action", code: "failed" };
      }
      return { ok: true, data: null, text: "" };
    } catch (error) {
      const e = errorOf(error);
      return { ok: false, data: null, text: e.text, code: e.code };
    }
  }

  async function act(
    tool: RegisteredTool,
    action: ScreenAction,
    ctx: CuCallContext,
  ): Promise<CuCallResult> {
    const current = session as CuSession;
    const title = stepTitle(action, ctx.lang);
    const index = current.startStep(title);
    if (index === "cap") {
      closedForTurn = true;
      await endSession("cap");
      return refuse(CU_MODEL_TEXT.cap(CU_MAX_STEPS));
    }
    emit();
    const described = await describePoint(action);
    const finding = detectConsequence(action, {
      ...(lastTyped === undefined ? {} : { lastTypedTarget: lastTyped }),
      ...(described === undefined ? {} : { described }),
    });
    const audited = cuAuditInput(action);
    let outcome: ToolOutcome;
    if (finding !== undefined) {
      current.markStep(index, "pending");
      emit();
      const t = CU_TEXT[ctx.lang];
      const [result] = await deps.gate.runBatch({
        turnId: ctx.turnId,
        via: "desktop",
        lang: ctx.lang,
        signal: ctx.signal,
        calls: [
          {
            callId: `${current.sessionId}-${index + 1}`,
            tool,
            input: audited,
            preset: {
              elements: [0],
              items: [
                {
                  tool: tool.name,
                  description: {
                    title: t.consequenceTitle(title, finding.intent),
                    detail: t.consequenceDetail(joinApps(current.apps, ctx.lang)),
                    source: "system",
                  },
                },
              ],
              resultOf: (_index, done) => (done.ok ? "ok" : "failed"),
            },
          },
        ],
        execute: () => {
          current.markStep(index, "running");
          emit();
          return perform(action);
        },
      });
      if (result === undefined || result.status !== "ran" || result.outcome === undefined) {
        current.finishStep(index, false);
        if (session === current) emit();
        return refuse(gateResultText(result));
      }
      outcome = result.outcome;
    } else {
      current.markStep(index, "running");
      emit();
      outcome = await perform(action);
      await writeAudit({
        tool: tool.name,
        title,
        input: audited,
        decision: "approved",
        via: ctx.via,
        result: outcome.ok ? "ok" : "failed",
        ...(outcome.ok ? {} : { message: outcome.text.slice(0, 500) }),
      });
    }
    lastTyped =
      action.kind === "type" ? action.target : action.kind === "key" ? lastTyped : undefined;
    if (session !== current) return refuse(CU_MODEL_TEXT.stoppedByUser);
    current.finishStep(index, outcome.ok);
    emit();
    if (outcome.ok) return ok(CU_MODEL_TEXT.did(stepTitle(action, "en")));
    return clientFailure(new CuClientError(parseCuErrorCode(outcome.code), outcome.text));
  }

  return {
    async run(tool, input, ctx) {
      if (ctx.via.startsWith("phone:")) return refuse(CU_MODEL_TEXT.phone);
      const unavailable = deps.available();
      if (unavailable !== null) {
        if (session !== undefined) {
          closedForTurn = true;
          await endSession("unavailable");
        }
        return refuse(unavailable);
      }
      if (session === undefined) {
        if (closedForTurn) return refuse(CU_MODEL_TEXT.closedThisTurn);
        if (tool.name === SCREEN_TOOLS.done) return ok(CU_MODEL_TEXT.noSession);
        if (tool.name !== SCREEN_TOOLS.look) return needApps();
        const parsed = parseScreenAction(tool.name, input, null);
        if (!parsed.ok) return refuse(parsed.error);
        if (
          parsed.action.kind !== "look" ||
          parsed.action.goal === undefined ||
          parsed.action.apps === undefined
        ) {
          return needApps();
        }
        const failure = await startSession(parsed.action.goal, parsed.action.apps, ctx);
        return failure ?? look();
      }
      const parsed = parseScreenAction(tool.name, input, bounds);
      if (!parsed.ok) return refuse(parsed.error);
      const action = parsed.action;
      if (
        action.kind === "look" &&
        action.apps !== undefined &&
        !sameApps(action.apps, session.apps)
      ) {
        return refuse(CU_MODEL_TEXT.appsFixed);
      }
      if (action.kind === "done") {
        closedForTurn = true;
        await endSession("done");
        return ok(CU_MODEL_TEXT.ended(action.summary));
      }
      if (session.paused() !== null) {
        const how = await waitForResume(ctx.signal);
        if (how !== "resumed") return refuse(CU_MODEL_TEXT.stoppedByUser);
        needsLook = true;
        return refuse(CU_MODEL_TEXT.resumedLookFirst);
      }
      if (action.kind === "look") return look();
      if (needsLook) return refuse(CU_MODEL_TEXT.lookFirst);
      return act(tool, action, ctx);
    },
    state: () => lastState,
    active: () => session !== undefined,
    async stop() {
      closedForTurn = true;
      await endSession("stopped");
    },
    async resume() {
      const current = session;
      if (current === undefined || current.paused() === null) return;
      try {
        await deps.client.begin(current.sessionId, current.apps);
      } catch (error) {
        deps.log(`[cu] resume: ${errorOf(error).code}`);
        closedForTurn = true;
        await endSession("helper");
        return;
      }
      current.resume();
      emit();
      for (const wake of [...waiters]) wake("resumed");
    },
    endSession,
    beginTurn() {
      closedForTurn = false;
    },
  };
}
