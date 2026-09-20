import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STRINGS } from "./i18n";
import type { VoiceNoticeCode, VoicePhase } from "./voice-controller";
import type { VoiceView } from "./voice-controller";
import {
  formatElapsed,
  micButtonState,
  noticeKey,
  phaseStatusKey,
  textDirection,
} from "./voice-screen";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE_ROOT = resolve(HERE, "../..");

// `satisfies Record<VoicePhase, true>` (fix round 1, Minor 6) makes this
// array complete by construction — a new `VoicePhase` added to
// voice-controller.ts without a matching key here is a compile error, the
// same discipline `noticeKey`'s own `NOTICE_KEYS` table already uses.
const PHASES_COMPLETE = {
  idle: true,
  starting: true,
  recording: true,
  sending: true,
  notSent: true,
  uncertain: true,
  waitingReply: true,
  speaking: true,
} satisfies Record<VoicePhase, true>;
const ALL_PHASES = Object.keys(PHASES_COMPLETE) as VoicePhase[];

const ENABLED_PHASES = new Set<VoicePhase>(["idle", "recording", "waitingReply", "speaking"]);

function baseView(phase: VoicePhase): VoiceView {
  return {
    phase,
    target: { kind: "brain" },
    elapsedMs: 0,
    turns: [],
    speakReplies: true,
    canRetry: false,
    spokenReplyIds: [],
  };
}

describe("micButtonState", () => {
  it.each(ALL_PHASES)(
    "phase=%s: enabled matches the idle/recording/waitingReply/speaking rule " +
      "[bite-proof: enable in notSent; the row fails]",
    (phase) => {
      const state = micButtonState(baseView(phase), {});
      expect(state.enabled).toBe(ENABLED_PHASES.has(phase));
    },
  );

  it.each(ALL_PHASES.filter((phase) => phase !== "recording"))(
    "phase=%s, sessionEnded: true -> disabled",
    (phase) => {
      const state = micButtonState(baseView(phase), { sessionEnded: true });
      expect(state.enabled).toBe(false);
    },
  );

  // M5: the session-screen mic must stay usable to STOP a recording in
  // progress even if the session ended mid-recording — only starting a
  // *new* recording is disabled. [bite-proof: drop the `active ||` from
  // micButtonState's `enabled`; this row fails]
  it("phase=recording, sessionEnded: true -> still enabled (can stop, not start)", () => {
    const state = micButtonState(baseView("recording"), { sessionEnded: true });
    expect(state.enabled).toBe(true);
    expect(state.active).toBe(true);
  });

  it("active is true only while recording", () => {
    for (const phase of ALL_PHASES) {
      expect(micButtonState(baseView(phase), {}).active).toBe(phase === "recording");
    }
  });

  it("labelKey is voice.stop while recording, forSession or not", () => {
    expect(micButtonState(baseView("recording"), {}).labelKey).toBe("voice.stop");
    expect(micButtonState(baseView("recording"), { forSession: true }).labelKey).toBe("voice.stop");
  });

  it("labelKey is voice.startForSession when forSession and not recording", () => {
    expect(micButtonState(baseView("idle"), { forSession: true }).labelKey).toBe(
      "voice.startForSession",
    );
  });

  it("labelKey is voice.start when not forSession and not recording", () => {
    expect(micButtonState(baseView("idle"), {}).labelKey).toBe("voice.start");
  });
});

describe("phaseStatusKey", () => {
  it("maps recording/sending/waitingReply/speaking to their keys", () => {
    expect(phaseStatusKey("recording")).toBe("voice.recording");
    expect(phaseStatusKey("sending")).toBe("voice.sending");
    expect(phaseStatusKey("waitingReply")).toBe("voice.waitingReply");
    expect(phaseStatusKey("speaking")).toBe("voice.speaking");
  });

  it.each<VoicePhase>(["idle", "starting", "notSent", "uncertain"])(
    "phase=%s -> undefined",
    (phase) => {
      expect(phaseStatusKey(phase)).toBeUndefined();
    },
  );
});

// Same completeness-by-construction trick as `ALL_PHASES` above.
const NOTICE_CODES_COMPLETE = {
  micDenied: true,
  micBlocked: true,
  recorderFailed: true,
  tooShort: true,
  tooLarge: true,
  notSentOffline: true,
  notSentBusy: true,
  uncertain: true,
  stoppedInBackground: true,
  noReply: true,
  noVoiceAr: true,
  noVoiceEn: true,
  laptopTooOld: true,
  failed: true,
  sentToSession: true,
  server: true,
} satisfies Record<VoiceNoticeCode, true>;
const ALL_NOTICE_CODES = Object.keys(NOTICE_CODES_COMPLETE) as VoiceNoticeCode[];

describe("noticeKey", () => {
  it("server -> undefined (its text is the laptop's own bilingual text, shown verbatim)", () => {
    expect(noticeKey("server")).toBeUndefined();
  });

  it.each(ALL_NOTICE_CODES.filter((code) => code !== "server"))(
    "%s -> voice.notice.%s, present in STRINGS",
    (code) => {
      const key = noticeKey(code);
      expect(key).toBe(`voice.notice.${code}`);
      expect(key && STRINGS[key]).toBeDefined();
    },
  );

  it("covers every VoiceNoticeCode exactly once", () => {
    const mapped = ALL_NOTICE_CODES.filter((code) => noticeKey(code) !== undefined);
    expect(mapped).toHaveLength(ALL_NOTICE_CODES.length - 1); // every code but "server"
  });
});

describe("formatElapsed", () => {
  it("7400ms -> 0:07", () => {
    expect(formatElapsed(7_400)).toBe("0:07");
  });

  it("120000ms -> 2:00", () => {
    expect(formatElapsed(120_000)).toBe("2:00");
  });

  it("-1 -> 0:00", () => {
    expect(formatElapsed(-1)).toBe("0:00");
  });

  it("NaN -> 0:00", () => {
    expect(formatElapsed(Number.NaN)).toBe("0:00");
  });
});

describe("textDirection", () => {
  it("ar -> rtl", () => {
    expect(textDirection("ar")).toBe("rtl");
  });

  it("en -> ltr", () => {
    expect(textDirection("en")).toBe("ltr");
  });
});

// --- source scans --------------------------------------------------------

// Strips comments before matching (rtl-lint.test.ts's own helper), so a
// file that merely *mentions* `.upload(`/`toggle(` in a docstring — e.g.
// explaining why it never calls them — never counts as an offender.
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      files.push(...collectSourceFiles(full));
      continue;
    }
    if (/\.tsx?$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

describe("source scan: only voice-controller.ts calls RpcClient.upload", () => {
  it("no file under app/ or src/components/, and not voice-context.tsx, contains .upload(", () => {
    const targets = [join(MOBILE_ROOT, "app"), join(MOBILE_ROOT, "src", "components")];
    const files = targets.flatMap(collectSourceFiles);
    files.push(join(MOBILE_ROOT, "src", "lib", "voice-context.tsx"));

    const offenders = files.filter((file) =>
      /\.upload\(/.test(stripComments(readFileSync(file, "utf8"))),
    );
    expect(
      offenders,
      `.upload( found outside voice-controller.ts: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("voice-context.tsx never calls toggle( — only a user's mic tap reaches the controller's toggle()", () => {
    const source = stripComments(
      readFileSync(join(MOBILE_ROOT, "src", "lib", "voice-context.tsx"), "utf8"),
    );
    expect(source).not.toMatch(/toggle\(/);
  });
});

describe("source scan: VoiceProvider rebuilds a disposed controller (fix round 1, Important 1)", () => {
  it(
    "voice-context.tsx checks isDisposed() before reusing the cached controller " +
      "[bite-proof: drop the isDisposed() half of the guard and this fails]",
    () => {
      const source = stripComments(
        readFileSync(join(MOBILE_ROOT, "src", "lib", "voice-context.tsx"), "utf8"),
      );
      expect(source).toMatch(
        /controllerRef\.current\s*===\s*undefined\s*\|\|\s*controllerRef\.current\.isDisposed\(\)/,
      );
    },
  );
});

describe("source scan: the session-screen mic passes the route's own validated id", () => {
  it("app/session/[id].tsx passes sessionId: id and reads useLocalSearchParams only once", () => {
    const source = readFileSync(join(MOBILE_ROOT, "app", "session", "[id].tsx"), "utf8");
    expect(source).toMatch(/sessionId:\s*id\b/);
    const searchParamReads = source.match(/useLocalSearchParams\(/g) ?? [];
    expect(searchParamReads).toHaveLength(1);
  });
});
