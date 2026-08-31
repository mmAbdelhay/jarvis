import type { Session } from "../session/types.js";

type Language = "ar" | "en";

/** One project with work the user has not committed yet. */
export type DirtyProject = {
  project: string;
  changedFiles: number;
};

export type GreetingInput = {
  /** Local wall-clock instant the app opened at. */
  now: number;
  /** Session rows, most recently active first — SessionStore.history()'s order. */
  history: readonly Session[];
  dirtyProjects: readonly DirtyProject[];
};

/**
 * Sessions do not survive a restart: their agent processes die with the app,
 * and the store marks every stale row dead on open. So the greeting reports
 * what is genuinely there to come back to — the session the user was last in,
 * and the work they left uncommitted — never "2 sessions restored", which
 * would be a comforting lie about state that no longer exists.
 *
 * Ruling P30 governs every string here, same as git/messages.ts and
 * providers/messages.ts: label-value form with the number at the clause tail,
 * and no duration counted in words. "3 hours ago" cannot be rendered in
 * Arabic without counted-noun agreement that changes with the number
 * (ساعة/ساعتان/ساعات/ساعة), and it also drifts while the greeting sits on
 * screen — an absolute clock time does neither.
 */

const READY: Record<Language, string> = {
  ar: "جارفِس جاهز.",
  en: "Jarvis is ready.",
};

/**
 * Arabic has two greetings where English has three: مساء الخير covers the
 * afternoon and the evening alike. The English "afternoon" case therefore
 * collapses into the same Arabic phrase rather than being forced into an
 * invented third form.
 *
 * The small hours (00:00–04:59) take the evening greeting: 03:00 is not
 * morning in either language, and a fourth "good night" would be a farewell
 * at the moment the user is starting work.
 */
function timeOfDay(now: number, language: Language): string {
  const hour = new Date(now).getHours();
  if (hour >= 5 && hour < 12) return language === "ar" ? "صباح الخير." : "Good morning.";
  if (hour >= 12 && hour < 17) return language === "ar" ? "مساء الخير." : "Good afternoon.";
  return language === "ar" ? "مساء الخير." : "Good evening.";
}

/** Same en-GB clock the dashboard and the provider lines use. */
function clock(at: number): string {
  return new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function sameDay(a: number, b: number): boolean {
  const left = new Date(a);
  const right = new Date(b);
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

/**
 * A bare "14:32" on a session from last week reads as this afternoon, so the
 * date is added exactly when the clock alone would mislead — and only then,
 * since most launches follow the same day's work.
 */
function when(at: number, now: number): string {
  if (sameDay(at, now)) return clock(at);
  const date = new Date(at).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit" });
  return `${date} ${clock(at)}`;
}

function lastSessionLine(session: Session, now: number, language: Language): string {
  const label = language === "ar" ? "آخر جلسة" : "Last session";
  return `${label}: ${session.project} · ${session.agentId} · ${when(session.lastActivityAt, now)}`;
}

function uncommittedLine(projects: readonly DirtyProject[], language: Language): string {
  const label = language === "ar" ? "تغييرات غير محفوظة" : "Uncommitted";
  const parts = projects.map((entry) => `${entry.project}: ${entry.changedFiles}`);
  return `${label} — ${parts.join(", ")}`;
}

/**
 * The greeting, as text. One line per part, so a caller can show it in the
 * transcript and speak the same string without composing two variants that
 * could drift apart.
 */
export function greetingText(input: GreetingInput, language: Language): string {
  const lines = [`${timeOfDay(input.now, language)} ${READY[language]}`];

  const last = input.history[0];
  if (last !== undefined) lines.push(lastSessionLine(last, input.now, language));

  if (input.dirtyProjects.length > 0) {
    lines.push(uncommittedLine(input.dirtyProjects, language));
  }

  return lines.join("\n");
}
