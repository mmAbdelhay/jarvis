// Rafiq v1.1: computer-use texts. CU_TEXT is what a person sees (card,
// step list, errors) in en and ar, checked by the M4 i18n gate.
// CU_MODEL_TEXT is what the model reads (English, M4 §6 #11). Pure.
import type { CuConsequence } from "./consequential.js";
import type { Lang, Localized } from "./i18n.js";

const EFFECT_EN: Record<CuConsequence, string> = {
  save: "saves a file",
  overwrite: "overwrites a file",
  delete: "deletes something",
  send: "sends something",
  submit: "submits a form",
  buy: "makes a purchase",
  install: "installs software",
};
const EFFECT_AR: Record<CuConsequence, string> = {
  save: "يحفظ ملفًا",
  overwrite: "يستبدل ملفًا موجودًا",
  delete: "يحذف شيئًا",
  send: "يرسل شيئًا",
  submit: "يقدّم نموذجًا",
  buy: "يُجري عملية شراء",
  install: "يثبّت برامج",
};

const CU_EN = {
  sessionTitle: (apps: string, goal: string) => `Let Jarvis use ${apps} to: ${goal}`,
  sessionDetail:
    "Jarvis will make one allowed window fullscreen and use the mouse and keyboard inside it. Captures are black unless that window is fullscreen and focused. Press Esc or move the mouse to take over.",
  stepClick: (target: string) => `Click “${target}”`,
  stepDoubleClick: (target: string) => `Double-click “${target}”`,
  stepType: (target: string, count: number) => `Type ${count} characters into “${target}”`,
  stepKey: (combo: string) => `Press ${combo}`,
  stepScroll: "Scroll",
  stepDrag: (target: string) => `Drag “${target}”`,
  consequenceTitle: (step: string, intent: CuConsequence) => `${step}: this ${EFFECT_EN[intent]}`,
  consequenceDetail: (apps: string) => `In ${apps}. Jarvis waits here until you decide.`,
  stuck: "Stopped: the screen did not change after 5 looks.",
  cap: (max: number) => `Stopped: reached ${max} actions.`,
  endTitle: (steps: number) => `Computer use ended after ${steps} action(s)`,
  noSuchProvider: (id: string) => `There is no provider "${id}".`,
  noVisionModel: "This model cannot see the screen, so computer use cannot be turned on for it.",
  effect: EFFECT_EN,
};
export type CuText = typeof CU_EN;

const CU_AR: CuText = {
  sessionTitle: (apps, goal) => `اسمح لجارفيس باستخدام ${apps} من أجل: ${goal}`,
  sessionDetail:
    "سيعرض جارفيس إحدى النوافذ المسموح بها بملء الشاشة ويستخدم الفأرة ولوحة المفاتيح داخلها. ستكون اللقطات سوداء ما لم تكن تلك النافذة بملء الشاشة وفي موضع التركيز. اضغط Esc أو حرّك الفأرة لتتولى التحكم.",
  stepClick: (target) => `النقر على «${target}»`,
  stepDoubleClick: (target) => `النقر المزدوج على «${target}»`,
  stepType: (target, count) => `كتابة ${count} حرفًا في «${target}»`,
  stepKey: (combo) => `الضغط على ${combo}`,
  stepScroll: "التمرير",
  stepDrag: (target) => `سحب «${target}»`,
  consequenceTitle: (step, intent) => `${step}: هذا ${EFFECT_AR[intent]}`,
  consequenceDetail: (apps) => `في ${apps}. ينتظر جارفيس هنا حتى تقرر.`,
  stuck: "توقف: لم تتغير الشاشة بعد 5 لقطات.",
  cap: (max) => `توقف: بلغ الحد الأقصى البالغ ${max} إجراءً.`,
  endTitle: (steps) => `انتهى استخدام جارفيس للشاشة بعد ${steps} إجراء`,
  noSuchProvider: (id) => `لا يوجد مزوّد باسم «${id}».`,
  noVisionModel: "هذا النموذج لا يرى الشاشة، لذا لا يمكن تشغيل استخدام الحاسوب له.",
  effect: EFFECT_AR,
};

export const CU_TEXT: Localized<CuText> = { en: CU_EN, ar: CU_AR };

export function joinApps(apps: readonly string[], lang: Lang): string {
  return apps.join(lang === "ar" ? "، " : ", ");
}

/** Model-facing (English). */
export const CU_MODEL_TEXT = {
  phone:
    "Computer use can only be started on the computer itself, not from a phone. Do not try again.",
  off: "Computer use is not available on this system.",
  notEnabled:
    "Computer use is off for this model. The user can turn it on in Settings → Computer use.",
  noVision: "This model cannot see images, so it cannot use the screen.",
  noConsent:
    "The user has not allowed screenshots to be sent to this non-loopback provider. They can allow it in Settings → Computer use.",
  locked: "The screen is locked, so computer use is not possible.",
  noSession: "No computer-use session is running.",
  needApps: (windows: string) =>
    `Start with screen.look {goal, apps}: goal is one line saying what you will do, apps are the running app ids you need (at most 5; open an app first with apps.open if it is not running). The running apps are listed below.\n${windows}`,
  needAppsNoList:
    "Start with screen.look {goal, apps}: goal is one line saying what you will do, apps are the running app ids you need (at most 5; open an app first with apps.open if it is not running).",
  sessionDenied:
    "The user did not allow this computer-use session. Nothing was touched. Do not ask again in this request.",
  beginFailed: (message: string) => `Computer use could not start or went away: ${message}`,
  closedThisTurn:
    "Computer use has ended for this request. Tell the user what happened; do not try again in this request.",
  appsFixed:
    "The apps of a running session cannot change. Finish with screen.done and ask the user to make a new request.",
  lookFirst: "Take a fresh screen.look before acting: coordinates come from the latest screenshot.",
  pausedNow: "The user took over the screen. Do not act until they resume.",
  resumedLookFirst:
    "The user paused and then resumed. Nothing was done. Take a fresh screen.look before acting.",
  stoppedByUser: "The user stopped computer use. Do not touch the screen again in this request.",
  stuck:
    "Stopped: the screen looked exactly the same 5 times in a row, so the actions are not working. Tell the user what you tried and what is on screen.",
  cap: (max: number) =>
    `Stopped: this request used all ${max} computer-use actions. Tell the user what is done and what is left.`,
  did: (what: string) => `Done: ${what}. Take a screen.look to check the result.`,
  failed: (code: string, message: string) => `The action failed (${code}): ${message}`,
  outside:
    "That point is outside the allowed windows. Point only inside the allowed apps' windows.",
  excluded:
    "A protected window (system, terminal, password or lock) has focus, so input is refused. Do not try to reach it.",
  ended: (summary: string) => `Computer use finished: ${summary}`,
  captureHeader: (width: number, height: number) =>
    `Screenshot of the allowed windows, ${width}x${height} pixels (everything else is black). The allowed windows are listed below.`,
} as const;
