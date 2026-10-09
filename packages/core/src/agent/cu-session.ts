// One computer-use session's state (design §2.7, contracts §2 cu:state):
// the action list with statuses, the 50-action cap, stuck detection by
// screenshot hash and the pause reason. No I/O. Pure.
import {
  type AuditVia,
  CU_MAX_STEPS,
  type CuPauseReason,
  type CuState,
  type CuStep,
  type CuStepStatus,
} from "./contract.js";
import { CU_TEXT } from "./cu-text.js";
import type { Lang } from "./i18n.js";

export const CU_STUCK_REPEATS = 5;
export type CuEndReason =
  | "done"
  | "stopped"
  | "stuck"
  | "cap"
  | "locked"
  | "turn-end"
  | "unavailable"
  | "helper"
  | "pause-timeout";

export const CU_IDLE_STATE: CuState = {
  active: false,
  sessionId: null,
  goal: "",
  apps: [],
  step: 0,
  maxSteps: CU_MAX_STEPS,
  steps: [],
  paused: null,
};

export type CuSession = {
  readonly sessionId: string;
  readonly goal: string;
  readonly apps: readonly string[];
  readonly lang: Lang;
  readonly via: AuditVia;
  startStep(title: string): number | "cap";
  markStep(index: number, status: CuStepStatus): void;
  finishStep(index: number, ok: boolean): void;
  noteCapture(hash: string): "ok" | "stuck";
  pause(reason: CuPauseReason): void;
  resume(): void;
  paused(): CuPauseReason | null;
  stepCount(): number;
  state(): CuState;
  end(why: CuEndReason): CuState;
};

export function createCuSession(init: {
  sessionId: string;
  goal: string;
  apps: readonly string[];
  lang: Lang;
  via: AuditVia;
  maxSteps?: number;
  stuckRepeats?: number;
}): CuSession {
  const apps = [...init.apps];
  const requestedMax = init.maxSteps ?? CU_MAX_STEPS;
  const maxSteps =
    Number.isInteger(requestedMax) && requestedMax > 0
      ? Math.min(requestedMax, CU_MAX_STEPS)
      : CU_MAX_STEPS;
  const repeats = init.stuckRepeats ?? CU_STUCK_REPEATS;
  const steps: CuStep[] = [];
  let actions = 0;
  let lastHash: string | undefined;
  let same = 0;
  let paused: CuPauseReason | null = null;
  let active = true;

  const state = (): CuState => ({
    active,
    sessionId: init.sessionId,
    goal: init.goal,
    apps: [...apps],
    step: actions,
    maxSteps,
    steps: steps.map((step) => ({ ...step })),
    paused,
  });
  const mark = (index: number, status: CuStepStatus) => {
    const step = steps[index];
    if (active && step !== undefined) step.status = status;
  };

  return {
    sessionId: init.sessionId,
    goal: init.goal,
    apps: [...apps],
    lang: init.lang,
    via: init.via,
    startStep(title) {
      if (!active || actions >= maxSteps) return "cap";
      actions++;
      steps.push({ title, status: "running" });
      return steps.length - 1;
    },
    markStep: mark,
    finishStep(index, ok) {
      mark(index, ok ? "done" : "failed");
    },
    noteCapture(hash) {
      if (hash === lastHash) same++;
      else {
        lastHash = hash;
        same = 1;
      }
      return same >= repeats ? "stuck" : "ok";
    },
    pause(reason) {
      if (active) paused = reason;
    },
    resume() {
      paused = null;
    },
    paused: () => paused,
    stepCount: () => actions,
    state,
    end(why) {
      if (!active) return state();
      active = false;
      paused = null;
      for (const step of steps) {
        if (step.status === "running" || step.status === "pending") step.status = "failed";
      }
      if (why === "stuck") steps.push({ title: CU_TEXT[init.lang].stuck, status: "failed" });
      if (why === "cap") steps.push({ title: CU_TEXT[init.lang].cap(maxSteps), status: "failed" });
      return state();
    },
  };
}
