// What `jarvisd status` and `jarvisd devices` print, as pure functions of
// the daemon's answers. A device name and a pairing request's name and
// address come from the device, so they pass through terminalSafe before
// they reach a terminal: an escape sequence in a name could otherwise
// rewrite the screen, and a bidi override could make one name read as
// another.
//
// No electron here (core/no-electron.test.ts).
import type { OwnerStatus, RemoteStatus } from "@jarvis/remote";
import { MESSAGES } from "../../messages.js";
import { remoteDeviceClient, remoteWebState } from "../../remote-web.js";
import { CLI_MESSAGES } from "./messages.js";

type Language = "ar" | "en";

/** Longest device name the table prints, in code points. */
export const MAX_NAME_COLUMN = 40;

// C0 and C1 controls (ESC, CR, BEL, …), the bidi embeddings, overrides and
// isolates, the zero-width marks and the BOM.
const UNSAFE = /[\p{Cc}\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu;

/** Untrusted text made safe to print: no control or bidi characters. */
export function terminalSafe(text: string, maxLength?: number): string {
  const clean = [...text.replace(UNSAFE, "")];
  if (maxLength === undefined || clean.length <= maxLength) return clean.join("");
  return `${clean.slice(0, maxLength - 1).join("")}…`;
}

/** Local date and time, minutes precision: `2026-09-28 14:05`. */
export function formatTime(at: number): string {
  const date = new Date(at);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

function width(text: string): number {
  return [...text].length;
}

function table(rows: readonly (readonly string[])[]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, width(cell));
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, index) =>
          index === row.length - 1 ? cell : cell + " ".repeat((widths[index] ?? 0) - width(cell)),
        )
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export function formatDevices(devices: RemoteStatus["devices"], language: Language): string {
  if (devices.length === 0) return MESSAGES.remoteNoDevices(language);
  const column = (name: Parameters<typeof CLI_MESSAGES.deviceColumn>[0]) =>
    CLI_MESSAGES.deviceColumn(name, language);
  const rows = [
    [
      column("id"),
      column("name"),
      column("client"),
      column("state"),
      column("paired"),
      column("lastSeen"),
    ],
    ...devices.map((device) => [
      terminalSafe(device.id, MAX_NAME_COLUMN),
      terminalSafe(device.name, MAX_NAME_COLUMN),
      MESSAGES.remoteWebDeviceClient(remoteDeviceClient(device), language),
      device.connected
        ? MESSAGES.remoteDeviceConnected(language)
        : CLI_MESSAGES.deviceIdle(language),
      formatTime(device.pairedAt),
      device.lastSeenAt === undefined
        ? CLI_MESSAGES.never(language)
        : formatTime(device.lastSeenAt),
    ]),
  ];
  return table(rows);
}

export function formatStatus(remote: RemoteStatus, owner: OwnerStatus, language: Language): string {
  const label = (row: Parameters<typeof CLI_MESSAGES.statusLabel>[0]) =>
    CLI_MESSAGES.statusLabel(row, language);
  const rows: [string, string][] = [
    [label("remote"), MESSAGES.remoteState(remote.enabled, language)],
  ];
  if (remote.listening !== undefined) {
    rows.push([label("listening"), `${remote.listening.host}:${remote.listening.port}`]);
  }
  if (remote.problem !== undefined) {
    rows.push([label("problem"), MESSAGES.remoteProblem(remote.problem, language)]);
  }
  rows.push([
    label("owner"),
    owner.hasPassword
      ? MESSAGES.remoteOwnerHasPassword(language)
      : MESSAGES.remoteOwnerNoPassword(language),
  ]);
  rows.push([label("passkeys"), String(owner.passkeys.length)]);
  rows.push([label("web"), MESSAGES.remoteWebState(remoteWebState(remote), language)]);
  rows.push([
    label("devices"),
    CLI_MESSAGES.devicesCount(
      remote.devices.length,
      remote.devices.filter((device) => device.connected).length,
      language,
    ),
  ]);
  rows.push([label("pairing"), CLI_MESSAGES.pairingState(remote.pairing.kind, language)]);
  return [
    CLI_MESSAGES.daemonRunning(language),
    table(rows.map(([name, value]) => [`${name}:`, value])),
  ].join("\n");
}
