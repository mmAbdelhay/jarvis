import type { SessionState } from "@jarvis/core";
import { isSubscriptionKey } from "@jarvis/wire";
import { t, type Language, type MessageKey } from "./i18n";
import type { RpcError } from "./rpc-client";
import type { SendResult } from "./session-input";
import type { SessionStreamView } from "./session-stream";
import type { KeyName } from "./terminal-keys";

export function sessionRouteId(param: unknown): string | undefined {
  return isSubscriptionKey(param) ? param : undefined;
}

export function sendResultKey(result: SendResult): MessageKey | undefined {
  switch (result.kind) {
    case "sent":
    case "empty":
    case "failed":
      return undefined;
    case "ended":
      return "session.ended";
    case "offline":
      return "session.offline";
    case "uncertain":
      return "session.uncertain";
    case "rateLimited":
      return "session.rateLimited";
    case "tooLong":
      return "session.tooLong";
    case "ctrlInvalid":
      return "session.ctrlInvalid";
  }
}

// Fix round 1 (Minor 1): the screen and ComposeBar both turned a
// `SendResult` into displayed text the same way (server text verbatim for
// `failed`, else the mapped key or nothing) — one testable expression
// instead of two copies of the same `? :` chain.
export function sendResultText(result: SendResult, language: Language): string {
  if (result.kind === "failed") return result.text;
  const key = sendResultKey(result);
  return key ? t(language, key) : "";
}

export function streamStatusKey(view: SessionStreamView): MessageKey | undefined {
  switch (view.phase) {
    case "attaching":
      return "session.attaching";
    case "waiting":
      return "session.waiting";
    case "failed":
      return "session.attachFailed";
    default:
      return undefined;
  }
}

export function isEnded(state: SessionState | undefined): boolean {
  return state === "done" || state === "dead";
}

// Final review M5: a row not yet found in the sessions list has three
// distinct causes, and each needs its own text — showing "Waiting for the
// connection…" for a `sessions:list` remote error was misleading (the
// connection is fine; the call failed). A `remote` error shows the
// laptop's own text verbatim (the same discipline as `sendResultText`);
// any other error kind (`offline`/`timeout`/`unsupported`) has no server
// text to show, so it falls back to a translated, generic "couldn't load"
// message instead of the connection-status copy.
export function notFoundText(
  sessions: { loading: boolean; error?: RpcError },
  language: Language,
): string {
  if (sessions.loading) return t(language, "session.attaching");
  if (sessions.error) {
    return sessions.error.kind === "remote"
      ? sessions.error.text
      : t(language, "session.listFailed");
  }
  return t(language, "session.notFound");
}

export function trimmedAmount(view: SessionStreamView): string {
  const n = view.droppedBytes;
  if (n <= 0) return "";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

export const KEY_CAPS: Readonly<Record<KeyName | "ctrl", string>> = {
  esc: "Esc",
  tab: "Tab",
  shiftTab: "⇧Tab",
  ctrl: "Ctrl",
  ctrlC: "^C",
  left: "←",
  up: "↑",
  down: "↓",
  right: "→",
  backspace: "⌫",
  enter: "⏎",
};

export const KEY_LABEL_KEYS: Readonly<Record<KeyName | "ctrl", MessageKey>> = {
  esc: "key.esc",
  tab: "key.tab",
  shiftTab: "key.shiftTab",
  ctrl: "key.ctrl",
  ctrlC: "key.ctrlC",
  left: "key.left",
  up: "key.up",
  down: "key.down",
  right: "key.right",
  backspace: "key.backspace",
  enter: "key.enter",
};
