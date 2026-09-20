// task-6-brief.md, "Tests: push-screen.test.ts" — the pure mapping table
// over every PushPhase x laptopEnabled x registered combination, plus the
// source scans the brief assigns to this file (push-context.tsx and
// app/settings.tsx never call the things they must not, native-intent.ts
// stays untouched).
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STRINGS } from "./i18n";
import type { PushPhase, PushView } from "./push-registration";
import { notificationsStatusKey, notificationsSwitchValue } from "./push-screen";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE_ROOT = resolve(HERE, "../..");

// `satisfies Record<PushPhase, true>` (voice-screen.test.ts's own trick)
// makes this array complete by construction — a new PushPhase added to
// push-registration.ts without a matching row here is a compile error.
const PHASES_COMPLETE = {
  off: true,
  requesting: true,
  on: true,
  denied: true,
  blocked: true,
  unavailable: true,
  error: true,
} satisfies Record<PushPhase, true>;
const ALL_PHASES = Object.keys(PHASES_COMPLETE) as PushPhase[];

const LAPTOP_ENABLED_VALUES: ReadonlyArray<boolean | undefined> = [true, false, undefined];
const REGISTERED_VALUES: readonly boolean[] = [true, false];

function view(phase: PushPhase, laptopEnabled: boolean | undefined, registered: boolean): PushView {
  return { phase, laptopEnabled, registered };
}

describe("notificationsStatusKey", () => {
  it.each(ALL_PHASES.filter((phase) => phase !== "on"))(
    "phase=%s ignores laptopEnabled/registered",
    (phase) => {
      for (const laptopEnabled of LAPTOP_ENABLED_VALUES) {
        for (const registered of REGISTERED_VALUES) {
          const key = notificationsStatusKey(view(phase, laptopEnabled, registered));
          if (phase === "off") {
            expect(key).toBeUndefined();
          } else {
            expect(key).toBe(`settings.notifications.${phase}`);
          }
        }
      }
    },
  );

  it("phase=on, laptopEnabled=false -> laptopOff, regardless of registered [bite-proof: drop the laptopEnabled check; this fails]", () => {
    expect(notificationsStatusKey(view("on", false, true))).toBe(
      "settings.notifications.laptopOff",
    );
    expect(notificationsStatusKey(view("on", false, false))).toBe(
      "settings.notifications.laptopOff",
    );
  });

  it("phase=on, laptopEnabled=true|undefined, registered=false -> pending", () => {
    expect(notificationsStatusKey(view("on", true, false))).toBe("settings.notifications.pending");
    expect(notificationsStatusKey(view("on", undefined, false))).toBe(
      "settings.notifications.pending",
    );
  });

  it("phase=on, laptopEnabled=true|undefined, registered=true -> on", () => {
    expect(notificationsStatusKey(view("on", true, true))).toBe("settings.notifications.on");
    expect(notificationsStatusKey(view("on", undefined, true))).toBe("settings.notifications.on");
  });

  it("every returned key exists in STRINGS, for every phase x laptopEnabled x registered", () => {
    for (const phase of ALL_PHASES) {
      for (const laptopEnabled of LAPTOP_ENABLED_VALUES) {
        for (const registered of REGISTERED_VALUES) {
          const key = notificationsStatusKey(view(phase, laptopEnabled, registered));
          if (key !== undefined) {
            expect(STRINGS[key]).toBeDefined();
          }
        }
      }
    }
  });
});

describe("notificationsSwitchValue", () => {
  it.each(ALL_PHASES)("phase=%s: true only for 'on' [bite-proof: true for requesting]", (phase) => {
    for (const laptopEnabled of LAPTOP_ENABLED_VALUES) {
      for (const registered of REGISTERED_VALUES) {
        expect(notificationsSwitchValue(view(phase, laptopEnabled, registered))).toBe(
          phase === "on",
        );
      }
    }
  });
});

// --- source scans --------------------------------------------------------

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("source scan: the switch cannot start registration without a tap", () => {
  it("app/settings.tsx calls store.setNotifications( inside an onValueChange handler", () => {
    const source = stripComments(readFileSync(join(MOBILE_ROOT, "app", "settings.tsx"), "utf8"));
    expect(source).toMatch(/onValueChange=\{[^}]*store\.setNotifications\(/s);
  });

  it("push-context.tsx never calls setEnabled( itself — only the switch's tap does", () => {
    const source = stripComments(
      readFileSync(join(MOBILE_ROOT, "src", "lib", "push-context.tsx"), "utf8"),
    );
    expect(source).not.toMatch(/setEnabled\(/);
  });
});

describe("source scan: taps navigate only through planNavigation over a fresh sessions:list", () => {
  it('push-context-support.ts calls planNavigation( and asks for "sessions:list"', () => {
    const source = stripComments(
      readFileSync(join(MOBILE_ROOT, "src", "lib", "push-context-support.ts"), "utf8"),
    );
    expect(source).toMatch(/planNavigation\(/);
    expect(source).toMatch(/"sessions:list"/);
  });

  it("push-context-support.ts's router adapter only pushes plan.route", () => {
    const source = stripComments(
      readFileSync(join(MOBILE_ROOT, "src", "lib", "push-context-support.ts"), "utf8"),
    );
    const calls = [...source.matchAll(/router\.push\(([^)]*)\)/g)].map((match) => match[1].trim());
    expect(calls.length).toBeGreaterThan(0);
    for (const argument of calls) {
      expect(argument).toBe("plan.route");
    }
  });
});

// native-intent.ts/native-intent.test.ts being byte-identical to HEAD is
// not a row in this file — global-constraints.md forbids comparing against
// `git show HEAD:...` here. The M7 rows already living in
// native-intent.test.ts are required to still pass (the full suite proves
// that), and the reviewer checks `git diff --stat` for the two files.
