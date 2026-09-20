import type { ProviderStatus, RateWindow } from "@jarvis/core";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import { formatAgo } from "./format.js";

// Deliberately NOT imported from @jarvis/core: the renderer has no bundler,
// so a value import of a bare specifier (`@jarvis/core`) would fail to
// resolve when index.html loads app.js as a plain ES module in the browser
// context — Phase 1 shipped a dead renderer three times over exactly this
// (controller ruling S1). Two lines of arithmetic is the right price for
// avoiding a fourth. Matches core's own `remainingPercent` (ruling S11)
// exactly, including the floor — see providers.test.ts's agreement test,
// which imports both implementations and asserts they never diverge.
// Exported (only) so providers.test.ts's agreement test can import this
// implementation side by side with core's — nothing in this module calls it
// through the export.
export function remainingPercent(window: RateWindow): number {
  return Math.floor(Math.max(0, Math.min(100, 100 - window.usedPercent)));
}

/** Older than this and the row shows its age as well as its clock time. */
const STALE_AFTER_MS = 30 * 60_000;

function clock(at: string | number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** A reset within the next day reads as a clock time; a farther one (Copilot's monthly window) as a day, since "resets 00:00" would be false ten times over. */
function resetLabel(at: string, now: number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "—";
  if (date.getTime() - now < DAY_MS) return clock(at);
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

const DAY_MS = 24 * 60 * 60 * 1000;

function unknownNote(reason: "unsupported" | "unavailable" | "never-read"): string {
  if (reason === "unsupported") return MESSAGES.capacityUnsupported(PRIMARY_LANGUAGE);
  if (reason === "unavailable") return MESSAGES.capacityUnavailable(PRIMARY_LANGUAGE);
  return MESSAGES.capacityNeverRead(PRIMARY_LANGUAGE);
}

function buildRow(status: ProviderStatus, now: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "provider";

  const head = document.createElement("div");
  head.className = "provider__head";

  const dot = document.createElement("span");
  dot.className = `dot dot--${status.health.state}`;
  head.append(dot);

  const id = document.createElement("span");
  id.className = "provider__id";
  // Never innerHTML: an account id comes from the user's own config, but
  // this is the same house rule the rest of the renderer follows without
  // exception — createElement + textContent only.
  id.textContent = status.id;
  head.append(id);

  const spacer = document.createElement("span");
  spacer.style.flexGrow = "1";
  head.append(spacer);

  const label = document.createElement("span");
  label.className = "lbl";
  label.textContent = MESSAGES.capacityLeftLabel(PRIMARY_LANGUAGE);
  head.append(label);

  const value = document.createElement("span");
  value.className = "provider__value mono";
  // Pinned LTR: a percentage is a number with a trailing sign, and an RTL
  // ancestor would otherwise reorder it.
  value.dir = "ltr";
  head.append(value);

  row.append(head);

  const note = document.createElement("div");
  note.className = "provider__note mono";

  if (status.capacity.state === "known") {
    const left = remainingPercent(status.capacity.primary);
    value.textContent = `${left}%`;
    if (left === 0) value.classList.add("provider__value--empty");

    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("div");
    // The meter shows headroom, so it empties as the account is consumed;
    // the threshold colour is what makes an almost-empty account read as a
    // warning rather than as a nearly-full CPU meter.
    fill.className = `fill ${left < 10 ? "fill--critical" : left < 25 ? "fill--low" : ""}`.trim();
    fill.style.width = `${left}%`;
    bar.append(fill);
    row.append(bar);

    const parts = [
      MESSAGES.capacityResetsAt(
        resetLabel(status.capacity.primary.resetsAt, now),
        PRIMARY_LANGUAGE,
      ),
      MESSAGES.capacityAsOf(clock(status.capacity.readAt), PRIMARY_LANGUAGE),
    ];
    const age = now - status.capacity.readAt;
    if (age >= STALE_AFTER_MS) {
      // Readings cost money, so most of them on screen are old. Showing the
      // age is more honest than hiding the row or silently re-buying it.
      note.classList.add("provider__note--stale");
      parts.push(formatAgo(status.capacity.readAt, now, PRIMARY_LANGUAGE));
    }
    note.textContent = parts.join(" · ");
  } else {
    // No `.bar` element at all — its absence is the signal, and it cannot be
    // mistaken for an empty (0%) meter (ruling P21's shape: a number that
    // isn't true is worse than no number).
    value.textContent = "—";
    value.classList.add("provider__value--unknown");
    note.textContent = unknownNote(status.capacity.reason);
  }

  if (status.health.state !== "ok") {
    note.textContent = `${note.textContent} · ${MESSAGES.providerHealth(status.health.state, PRIMARY_LANGUAGE)}`;
  }

  row.append(note);
  return row;
}

export function renderProviders(statuses: readonly ProviderStatus[], now: number): void {
  const list = document.getElementById("providers");
  if (list === null) return;

  if (statuses.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sessions-empty";
    empty.textContent = MESSAGES.providersEmpty(PRIMARY_LANGUAGE);
    list.replaceChildren(empty);
    return;
  }

  list.replaceChildren(...statuses.map((status) => buildRow(status, now)));
}

export function wireProvidersPanel(): void {
  const refresh = document.getElementById("providers-refresh");
  refresh?.setAttribute("aria-label", MESSAGES.refreshProviders(PRIMARY_LANGUAGE));
  refresh?.addEventListener("click", (event) => {
    // The header toggles the panel; the button inside it must not do both.
    event.stopPropagation();
    // Explicit user demand — the only click in the app that spends money.
    void window.jarvis.refreshProviders();
  });

  const head = document.getElementById("providers-head");
  const panel = document.getElementById("providers-panel");
  head?.addEventListener("click", () => {
    panel?.classList.toggle("providers-panel--collapsed");
  });
}
