import { type Language, languageFromLocale } from "./i18n";
import { SIDECAR_ZOOM_MAX, SIDECAR_ZOOM_MIN } from "./sidecar-webview-config";

// The three sidecar kinds the "Editor"/"Database"/"Cluster" rows on
// sidecars/[project].tsx open — the same set `resolveTitle` in
// app/sidecar-view.tsx already switches on by its `kind` route param.
export type SidecarKind = "editor" | "database" | "cluster";

// Per-kind zoom level (a percentage in sidecar-webview-config.ts's [60,
// 220] range), keyed by `SidecarKind`. Every key is optional: an absent
// kind means "never zoomed on this screen yet", which the header treats
// as the 100% default (SIDECAR_ZOOM_DEFAULT) rather than storing 100
// explicitly for every kind up front.
export type SidecarZoomPrefs = Partial<Record<SidecarKind, number>>;

export type Prefs = {
  language: Language;
  speakReplies: boolean;
  // M10 Task 5: both default false, independently of every other field
  // (rule 16 of M8, extended by rule 1 of task-5-brief.md) — a missing or
  // invalid stored value must never turn notifications on, and must never
  // report a registration that isn't real.
  notifications: boolean;
  pushRegistered: boolean;
  // Sidecar UA fix: defaults true, independently of every other field —
  // a missing or invalid stored value must still show DbGate/code-server
  // their real desktop UI rather than the "not supported on mobile"
  // notice or the cramped phone layout.
  sidecarDesktopSite: boolean;
  // Sidecar zoom fix: defaults to `{}` (every kind absent -> 100%),
  // independently of every other field. Corrupt or out-of-range entries
  // are dropped per-kind rather than resetting the whole object, so one
  // bad value can't wipe every sidecar's remembered zoom.
  sidecarZoom: SidecarZoomPrefs;
};

// Injected so the app's real `expo-file-system` implementation (prefs-file.ts)
// and this module's tests never touch the filesystem directly.
export type PrefsStore = {
  read(): Promise<string | undefined>;
  write(text: string): Promise<void>;
};

// M8 Task 7, rule 16: "Speak replies" defaults on — a missing or invalid
// stored value must not silently mute the phone.
const DEFAULT_SPEAK_REPLIES = true;
const DEFAULT_NOTIFICATIONS = false;
const DEFAULT_PUSH_REGISTERED = false;
const DEFAULT_SIDECAR_DESKTOP_SITE = true;
const DEFAULT_SIDECAR_ZOOM: SidecarZoomPrefs = {};
const SIDECAR_KINDS: SidecarKind[] = ["editor", "database", "cluster"];

function isLanguage(value: unknown): value is Language {
  return value === "ar" || value === "en";
}

function isValidZoomValue(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= SIDECAR_ZOOM_MIN &&
    value <= SIDECAR_ZOOM_MAX
  );
}

// Drops each kind independently rather than rejecting the whole object on
// one bad entry — a corrupt `database` value must not also wipe a
// perfectly valid `editor` one.
function parseSidecarZoom(value: unknown): SidecarZoomPrefs {
  if (typeof value !== "object" || value === null) return { ...DEFAULT_SIDECAR_ZOOM };
  const raw = value as Record<string, unknown>;
  const result: SidecarZoomPrefs = {};
  for (const kind of SIDECAR_KINDS) {
    if (isValidZoomValue(raw[kind])) {
      result[kind] = raw[kind] as number;
    }
  }
  return result;
}

export async function loadPrefs(store: PrefsStore, localeTag: string): Promise<Prefs> {
  // Rule 16: an invalid/missing `language` still falls back to the locale
  // default independently of `speakReplies` — the two fields never affect
  // each other's fallback.
  const fallback: Prefs = {
    language: languageFromLocale(localeTag),
    speakReplies: DEFAULT_SPEAK_REPLIES,
    notifications: DEFAULT_NOTIFICATIONS,
    pushRegistered: DEFAULT_PUSH_REGISTERED,
    sidecarDesktopSite: DEFAULT_SIDECAR_DESKTOP_SITE,
    sidecarZoom: { ...DEFAULT_SIDECAR_ZOOM },
  };

  let text: string | undefined;
  try {
    text = await store.read();
  } catch {
    return fallback;
  }
  if (text === undefined) {
    return fallback;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fallback;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return fallback;
  }
  const raw = parsed as Record<string, unknown>;

  const language = isLanguage(raw.language) ? raw.language : fallback.language;
  const speakReplies =
    typeof raw.speakReplies === "boolean" ? raw.speakReplies : DEFAULT_SPEAK_REPLIES;
  const notifications =
    typeof raw.notifications === "boolean" ? raw.notifications : DEFAULT_NOTIFICATIONS;
  const pushRegistered =
    typeof raw.pushRegistered === "boolean" ? raw.pushRegistered : DEFAULT_PUSH_REGISTERED;
  const sidecarDesktopSite =
    typeof raw.sidecarDesktopSite === "boolean"
      ? raw.sidecarDesktopSite
      : DEFAULT_SIDECAR_DESKTOP_SITE;
  const sidecarZoom = parseSidecarZoom(raw.sidecarZoom);

  return {
    language,
    speakReplies,
    notifications,
    pushRegistered,
    sidecarDesktopSite,
    sidecarZoom,
  };
}

export async function savePrefs(store: PrefsStore, prefs: Prefs): Promise<void> {
  await store.write(JSON.stringify(prefs));
}
