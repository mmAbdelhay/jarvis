import { CalculationMethod, Coordinates, PrayerTimes } from "./vendor/adhan.mjs";
import type { PrayerConfig } from "../src/config.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import { DEFAULT_PRAYER_NOTIFY, duePrayerNotifications } from "./prayer-notify.js";

const ALEXANDRIA = {
  latitude: 31.2001,
  longitude: 29.9187,
  name: "Alexandria",
};
type Location = typeof ALEXANDRIA;
const NAMES = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"] as const;

// Two states on purpose (re-review 2, item 1): `snapshot` is what the header
// chip renders and is set only from *saved* settings (app.ts, on load and
// after a Save); `formDraft` is what the Settings controls edit and hand to
// the settings draft. A toggled-but-unsaved switch never previews in the chip.
let snapshot: PrayerConfig = { enabled: false };
let formDraft: PrayerConfig = { enabled: false };
export function setPrayerSnapshot(value: PrayerConfig): void {
  snapshot = value;
}

export function nextPrayer(
  now: Date,
  location: Location,
): {
  name: string;
  remaining: number;
  progress: number;
  /** The prayer that most recently passed — "previous" in the same sense
   *  `progress` already measures the interval from. */
  previousName: string;
  /** Milliseconds since `previousName`'s own time, always >= 0 once a first
   *  prayer has passed; Infinity in the never-happens fallback below, so it
   *  can never be mistaken for the "just passed" window. */
  sincePrevious: number;
} {
  // Generate three local calendar days so every civil timezone is covered without guessing from coordinates or trusting the device timezone.
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const cacheKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}:${location.latitude}:${location.longitude}`;
  if (cachedKey !== cacheKey) {
    const coordinates = new Coordinates(location.latitude, location.longitude);
    const parameters = CalculationMethod.Egyptian();
    const events: { name: string; time: number }[] = [];
    for (const offset of [-1, 0, 1]) {
      const day = new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset);
      const times = new PrayerTimes(coordinates, day, parameters);
      for (const name of NAMES) {
        const time = times[name.toLowerCase() as Lowercase<typeof name>].getTime();
        if (Number.isFinite(time)) events.push({ name, time });
      }
    }
    events.sort((a, b) => a.time - b.time);
    cachedEvents = events;
    cachedKey = cacheKey;
  }
  const nextIndex = cachedEvents.findIndex((event) => event.time > now.getTime());
  const next = cachedEvents[nextIndex];
  const previous = cachedEvents[nextIndex - 1];
  if (!next || !previous) {
    return {
      name: "Prayer",
      remaining: 0,
      progress: 0,
      previousName: "Prayer",
      sincePrevious: Number.POSITIVE_INFINITY,
    };
  }
  return {
    name: next.name,
    remaining: next.time - now.getTime(),
    progress: Math.max(
      0,
      Math.min(1, (now.getTime() - previous.time) / (next.time - previous.time)),
    ),
    previousName: previous.name,
    sincePrevious: now.getTime() - previous.time,
  };
}

let cachedKey = "";
let cachedEvents: { name: string; time: number }[] = [];

export function renderPrayer(now = new Date(), prayerConfig = snapshot): void {
  const chip = document.getElementById("header-prayer");
  if (!chip) return;
  const enabled = prayerConfig.enabled;
  chip.hidden = !enabled;
  if (!enabled) return;
  const location = prayerConfig.location ?? ALEXANDRIA;
  const prayer = nextPrayer(now, location);
  const label = chip.querySelector<HTMLElement>(".prayer-label");
  const ring = chip.querySelector<SVGCircleElement>(".prayer-ring-fill");

  // The 5 minutes right after a prayer's own time read "<name> now" rather
  // than counting down to whatever comes after it — the countdown to Asr is
  // not what a reader wants in the moment Dhuhr itself is happening.
  const NOW_WINDOW_MS = 5 * 60_000;
  const justPassed = prayer.sincePrevious <= NOW_WINDOW_MS;
  // >30 min accent, <=30 warn, <=10 danger — checked most-urgent-first since
  // every "danger" minute count is also a "warn" one.
  const minutes = Math.ceil(prayer.remaining / 60_000);
  const state = justPassed ? "now" : minutes <= 10 ? "danger" : minutes <= 30 ? "warn" : "accent";
  chip.dataset["prayerState"] = state;

  if (justPassed) {
    const passedName = MESSAGES.prayerName(prayer.previousName, PRIMARY_LANGUAGE);
    if (label) label.textContent = MESSAGES.prayerNow(passedName, PRIMARY_LANGUAGE);
  } else {
    const duration = MESSAGES.prayerDuration(
      Math.floor(minutes / 60),
      minutes % 60,
      PRIMARY_LANGUAGE,
    );
    const prayerName = MESSAGES.prayerName(prayer.name, PRIMARY_LANGUAGE);
    if (label) label.textContent = MESSAGES.prayerNext(prayerName, duration, PRIMARY_LANGUAGE);
  }
  // board 0's ring: an r=9 circle has a 56.549px circumference
  // (2 * PI * 9); the stroke sweeps clockwise from noon as the fraction of
  // the current interval elapsed, so the filled arc grows toward the next
  // prayer rather than counting down from a full ring.
  if (ring) {
    const circumference = 2 * Math.PI * 9;
    ring.style.strokeDasharray = `${circumference}`;
    ring.style.strokeDashoffset = `${circumference * (1 - prayer.progress)}`;
  }
  chip.title = MESSAGES.prayerTitle(
    prayerConfig.location?.name ?? MESSAGES.prayerAlexandria(PRIMARY_LANGUAGE),
    MESSAGES.prayerName(prayer.name, PRIMARY_LANGUAGE),
    PRIMARY_LANGUAGE,
  );
}

// Persists for the app's whole lifetime, the same way `snapshot` and
// `formDraft` above do — so a "before" or "at time" notification fires
// exactly once per prayer instant across the 1-second tick loop, not once
// per call. checkPrayerNotifications is the only thing that touches it.
const firedPrayerNotifications = new Map<string, number>();

/**
 * The notification half of the tick, kept separate from `renderPrayer`
 * (same `now`/config, called alongside it from app.ts's own tick) so the
 * chip's rendering tests never have to know notifications exist, and a
 * caller that wants only one of the two never pays for the other. Decides
 * what is due via the pure `duePrayerNotifications` and turns each result
 * into an actual desktop notification.
 */
export function checkPrayerNotifications(now = new Date(), prayerConfig = snapshot): void {
  if (!prayerConfig.enabled) return;
  const location = prayerConfig.location ?? ALEXANDRIA;
  const prayer = nextPrayer(now, location);
  const due = duePrayerNotifications(now, prayer, prayerConfig, firedPrayerNotifications);
  if (due.length === 0) return;
  const notify = prayerConfig.notify ?? DEFAULT_PRAYER_NOTIFY;
  const body = prayerConfig.location?.name ?? MESSAGES.prayerAlexandria(PRIMARY_LANGUAGE);
  for (const notification of due) {
    const name = MESSAGES.prayerName(notification.name, PRIMARY_LANGUAGE);
    const title =
      notification.kind === "before"
        ? MESSAGES.prayerNext(
            name,
            MESSAGES.prayerDuration(0, notify.beforeMinutes, PRIMARY_LANGUAGE),
            PRIMARY_LANGUAGE,
          )
        : MESSAGES.prayerNow(name, PRIMARY_LANGUAGE);
    try {
      new Notification(title, { body });
    } catch {
      // Notification unsupported or denied — the same tolerance
      // session-view.ts and workspace-terminal.ts already give it.
    }
  }
}

export function initPrayerSettings(updateDraft: (patch: PrayerConfig) => Promise<void>): void {
  const toggle = document.getElementById("settings-prayer-enabled") as HTMLInputElement | null;
  const locate = document.getElementById("settings-prayer-locate") as HTMLButtonElement | null;
  const status = document.getElementById("settings-prayer-location");
  const latitude = document.getElementById("settings-prayer-latitude") as HTMLInputElement | null;
  const longitude = document.getElementById("settings-prayer-longitude") as HTMLInputElement | null;
  const heading = document.getElementById("settings-prayer-heading");
  const enabledLabel = document.getElementById("settings-prayer-enabled-label");
  const latitudeLabel = document.getElementById("settings-prayer-latitude-label");
  const longitudeLabel = document.getElementById("settings-prayer-longitude-label");
  const note = document.getElementById("settings-prayer-note");
  const notifyBefore = document.getElementById(
    "settings-prayer-notify-before",
  ) as HTMLInputElement | null;
  const notifyBeforeLabel = document.getElementById("settings-prayer-notify-before-label");
  const notifyMinutes = document.getElementById(
    "settings-prayer-notify-minutes",
  ) as HTMLInputElement | null;
  const notifyMinutesLabel = document.getElementById("settings-prayer-notify-minutes-label");
  const notifyAtTime = document.getElementById(
    "settings-prayer-notify-attime",
  ) as HTMLInputElement | null;
  const notifyAtTimeLabel = document.getElementById("settings-prayer-notify-attime-label");
  if (
    !toggle ||
    !locate ||
    !status ||
    !latitude ||
    !longitude ||
    !heading ||
    !enabledLabel ||
    !latitudeLabel ||
    !longitudeLabel ||
    !note ||
    !notifyBefore ||
    !notifyBeforeLabel ||
    !notifyMinutes ||
    !notifyMinutesLabel ||
    !notifyAtTime ||
    !notifyAtTimeLabel
  )
    return;
  heading.textContent = MESSAGES.prayerHeading(PRIMARY_LANGUAGE);
  // The section nav's own label for this section (board 5). Looked up
  // separately, not folded into the guard above: a harness that lays down
  // only the prayer settings fields (this file's own tests) has no reason
  // to also carry the nav, and this element's absence must not silently
  // skip the whole section.
  const navLabel = document.getElementById("settings-nav-header");
  if (navLabel) navLabel.textContent = MESSAGES.prayerHeading(PRIMARY_LANGUAGE);
  enabledLabel.textContent = MESSAGES.prayerShow(PRIMARY_LANGUAGE);
  latitudeLabel.textContent = MESSAGES.prayerLatitude(PRIMARY_LANGUAGE);
  longitudeLabel.textContent = MESSAGES.prayerLongitude(PRIMARY_LANGUAGE);
  locate.textContent = MESSAGES.prayerUseLocation(PRIMARY_LANGUAGE);
  note.textContent = MESSAGES.prayerLocationNote(PRIMARY_LANGUAGE);
  notifyBeforeLabel.textContent = MESSAGES.prayerNotifyBefore(PRIMARY_LANGUAGE);
  notifyMinutesLabel.textContent = MESSAGES.prayerNotifyBeforeMinutes(PRIMARY_LANGUAGE);
  notifyAtTimeLabel.textContent = MESSAGES.prayerNotifyAtTime(PRIMARY_LANGUAGE);
  toggle.addEventListener("change", () => {
    formDraft = { ...formDraft, enabled: toggle.checked };
    void updateDraft(formDraft);
  });
  notifyBefore.addEventListener("change", () => {
    formDraft = {
      ...formDraft,
      notify: { ...(formDraft.notify ?? DEFAULT_PRAYER_NOTIFY), before: notifyBefore.checked },
    };
    void updateDraft(formDraft);
  });
  notifyAtTime.addEventListener("change", () => {
    formDraft = {
      ...formDraft,
      notify: { ...(formDraft.notify ?? DEFAULT_PRAYER_NOTIFY), atTime: notifyAtTime.checked },
    };
    void updateDraft(formDraft);
  });
  notifyMinutes.addEventListener("change", () => {
    formDraft = {
      ...formDraft,
      notify: {
        ...(formDraft.notify ?? DEFAULT_PRAYER_NOTIFY),
        beforeMinutes: Number(notifyMinutes.value),
      },
    };
    void updateDraft(formDraft);
  });
  const saveCoordinates = (): void => {
    formDraft = {
      ...formDraft,
      location: {
        latitude: Number(latitude.value),
        longitude: Number(longitude.value),
        name: MESSAGES.prayerCustomLocation(PRIMARY_LANGUAGE),
      },
    };
    status.textContent = MESSAGES.prayerCustomLocation(PRIMARY_LANGUAGE);
    void updateDraft(formDraft);
  };
  latitude.addEventListener("change", saveCoordinates);
  longitude.addEventListener("change", saveCoordinates);
  locate.addEventListener("click", () => {
    if (!navigator.geolocation) {
      status.textContent = MESSAGES.prayerUnavailable(PRIMARY_LANGUAGE);
      return;
    }
    locate.disabled = true;
    status.textContent = MESSAGES.prayerLocating(PRIMARY_LANGUAGE);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const location = {
          latitude: coords.latitude,
          longitude: coords.longitude,
          name: MESSAGES.prayerCurrentLocation(PRIMARY_LANGUAGE),
        };
        formDraft = { ...formDraft, location };
        latitude.value = String(location.latitude);
        longitude.value = String(location.longitude);
        void updateDraft(formDraft);
        status.textContent = location.name;
        locate.disabled = false;
      },
      () => {
        status.textContent = MESSAGES.prayerDenied(
          formDraft.location?.name ?? MESSAGES.prayerAlexandria(PRIMARY_LANGUAGE),
          PRIMARY_LANGUAGE,
        );
        locate.disabled = false;
      },
      { timeout: 12_000, maximumAge: 300_000 },
    );
  });
}

export function syncPrayerSettings(value: PrayerConfig): void {
  formDraft = value;
  const toggle = document.getElementById("settings-prayer-enabled") as HTMLInputElement | null;
  const latitude = document.getElementById("settings-prayer-latitude") as HTMLInputElement | null;
  const longitude = document.getElementById("settings-prayer-longitude") as HTMLInputElement | null;
  const status = document.getElementById("settings-prayer-location");
  const notifyBefore = document.getElementById(
    "settings-prayer-notify-before",
  ) as HTMLInputElement | null;
  const notifyMinutes = document.getElementById(
    "settings-prayer-notify-minutes",
  ) as HTMLInputElement | null;
  const notifyAtTime = document.getElementById(
    "settings-prayer-notify-attime",
  ) as HTMLInputElement | null;
  if (toggle) toggle.checked = value.enabled;
  const location = value.location ?? ALEXANDRIA;
  if (latitude) latitude.value = String(location.latitude);
  if (longitude) longitude.value = String(location.longitude);
  if (status)
    status.textContent = value.location?.name ?? MESSAGES.prayerAlexandria(PRIMARY_LANGUAGE);
  const notify = value.notify ?? DEFAULT_PRAYER_NOTIFY;
  if (notifyBefore) notifyBefore.checked = notify.before;
  if (notifyMinutes) notifyMinutes.value = String(notify.beforeMinutes);
  if (notifyAtTime) notifyAtTime.checked = notify.atTime;
}
