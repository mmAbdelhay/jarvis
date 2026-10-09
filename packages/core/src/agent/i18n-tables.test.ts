// The TS component of the M4 i18n CI gate (contracts §3): every en key has an
// ar value and vice versa, nothing is empty, Arabic cells are Arabic and
// English cells are not. tsc already refuses a missing key; this also catches
// empty strings, untranslated copies and function cells.
import { describe, expect, it } from "vitest";
import { hasArabic } from "./i18n.js";
import { I18N_TABLES, TOOL_ACTIVITY } from "./messages.js";
import { HOST_FORCED_RISK } from "./tool-registry.js";

/** Arguments for every function cell, by "<table>.<key>". */
const SAMPLES: Record<string, unknown[]> = {
  "cu.sessionTitle": ["GIMP", "export beach.xcf"],
  "cu.stepClick": ["Export"],
  "cu.stepDoubleClick": ["beach.xcf"],
  "cu.stepType": ["File name", 9],
  "cu.stepKey": ["ctrl+s"],
  "cu.stepDrag": ["layer"],
  "cu.consequenceTitle": ["Click", "save"],
  "cu.consequenceDetail": ["GIMP"],
  "cu.cap": [50],
  "cu.endTitle": [3],
  "cu.noSuchProvider": ["work"],
  "user.toolFailed": ["X", "failed"],
  "user.stepLimitFallback": [8, ["net.status", "net.status"]],
  "user.updatesCheckFailed": ["boom"],
  "doctor.connected": ["home"],
  "doctor.connectionFixed": ["home"],
  "doctor.statusSummary": [
    {
      connectivity: "none",
      nmRunning: true,
      devices: [{ name: "wlan0", state: "disconnected" }],
      dnsOk: false,
      gatewayPingOk: false,
    },
  ],
  "doctor.summary": ["fixed", ["a"]],
  "doctor.stillBroken": ["s", ["l"]],
  "failover.unreachable": ["timeout"],
  "failover.serverError": [503],
  "failover.reason": ["work", "x"],
  "failover.failed": ["401"],
  "control.undone": ["t"],
  "control.undoTitle": ["t"],
  "control.undoFailed": ["t", "d"],
  "control.undoMoved": ["t"],
  "control.moreItems": ["t", 2],
  "control.noItem": ["item-1"],
  "control.noSecretField": ["item-1", "password"],
  "control.tickAtMost": [1],
};

function cells(table: unknown, prefix: string, out = new Map<string, unknown>()) {
  for (const [key, value] of Object.entries(table as Record<string, unknown>)) {
    const path = `${prefix}.${key}`;
    if (typeof value === "object" && value !== null) cells(value, path, out);
    else out.set(path, value);
  }
  return out;
}

function render(path: string, value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "function") throw new Error(`${path} is neither text nor a function`);
  const sampleKey = path.split(".").slice(0, 2).join(".");
  const args = SAMPLES[sampleKey];
  if (args === undefined) throw new Error(`add sample arguments for ${sampleKey} to SAMPLES`);
  return (value as (...a: unknown[]) => string)(...args);
}

describe("jarvisd message tables (M4 i18n gate)", () => {
  for (const [name, table] of Object.entries(I18N_TABLES)) {
    it(`${name}: en and ar have the same keys`, () => {
      const en = [...cells(table.en, name).keys()].sort();
      const ar = [...cells(table.ar, name).keys()].sort();
      expect(ar).toEqual(en);
    });

    it(`${name}: no empty cell, Arabic is Arabic, English is not`, () => {
      for (const [path, value] of cells(table.en, name)) {
        const text = render(path, value);
        expect(text.trim(), path).not.toBe("");
        expect(hasArabic(text), `${path} (en) contains Arabic`).toBe(false);
      }
      for (const [path, value] of cells(table.ar, name)) {
        const text = render(path, value);
        expect(text.trim(), path).not.toBe("");
        expect(hasArabic(text), `${path} (ar) is not translated`).toBe(true);
      }
    });
  }

  it("names an activity for every action tool the host forces a risk on", () => {
    for (const tool of Object.keys(HOST_FORCED_RISK)) {
      expect(Object.hasOwn(TOOL_ACTIVITY.en, tool), tool).toBe(true);
    }
  });
});
