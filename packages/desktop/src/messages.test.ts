import { describe, expect, it } from "vitest";
import { PREREQUISITES } from "@jarvis/platform";
import { errorMessage, isWayland, MESSAGES } from "./messages.js";

// Important 9: main.ts must not carry an English-only lane of user-facing
// strings beside @jarvis/core's bilingual MESSAGES table — every string a
// person can see or hear must survive Arabic.
describe("MESSAGES", () => {
  it("renders the hotkey collision message in English", () => {
    expect(MESSAGES.hotkeyCollision("Alt+Space", "en")).toContain("Alt+Space");
    expect(MESSAGES.hotkeyCollision("Alt+Space", "en")).toContain("shortcut");
  });

  it("renders the hotkey collision message in Arabic", () => {
    const text = MESSAGES.hotkeyCollision("Alt+Space", "ar");
    expect(text).toContain("Alt+Space");
    expect(text).toContain("اختصار");
  });

  it("renders the recording-failed message in both languages", () => {
    expect(MESSAGES.recordingFailed("spawn ffmpeg ENOENT", "en")).toContain("spawn ffmpeg ENOENT");
    expect(MESSAGES.recordingFailed("spawn ffmpeg ENOENT", "ar")).toContain("spawn ffmpeg ENOENT");
    expect(MESSAGES.recordingFailed("x", "ar")).toContain("تسجيل");
  });

  it("renders the transcription-failed message in both languages", () => {
    expect(MESSAGES.transcriptionFailed("whisper-cli exited with code 1", "en")).toContain(
      "whisper-cli exited with code 1",
    );
    expect(MESSAGES.transcriptionFailed("x", "ar")).toContain("تحويل الصوت");
  });

  // The personal browser's three strings: the name in the project
  // selector, the reason its project-directory tools are dead, and the
  // Picture-in-Picture button's tooltip. Bilingual like everything else —
  // the selector label especially, since it sits beside project names the
  // user chose themselves.
  describe("the personal browser", () => {
    it("names itself in both languages", () => {
      expect(MESSAGES.personalProject("en")).toBe("Personal");
      expect(MESSAGES.personalProject("ar")).toBe("شخصي");
    });

    it("says why the project tools are unavailable, in both languages", () => {
      expect(MESSAGES.personalHasNoDirectory("en")).toMatch(/folder|directory/i);
      expect(MESSAGES.personalHasNoDirectory("ar")).toContain("مجلد");
    });

    it("labels the picture-in-picture button in both languages", () => {
      expect(MESSAGES.pictureInPicture("en")).toMatch(/float|picture/i);
      expect(MESSAGES.pictureInPicture("ar")).toContain("فيديو");
    });
  });

  // Cheap fix: app.ts's history-count badge previously read
  // `${sessions.length} sessions` unconditionally, printing "1 sessions".
  describe("sessionsCount", () => {
    it("uses the singular English noun for exactly one session", () => {
      expect(MESSAGES.sessionsCount(1, "en")).toBe("1 session");
    });

    it("uses the plural English noun for zero or more than one session", () => {
      expect(MESSAGES.sessionsCount(0, "en")).toBe("0 sessions");
      expect(MESSAGES.sessionsCount(2, "en")).toBe("2 sessions");
      expect(MESSAGES.sessionsCount(11, "en")).toBe("11 sessions");
    });

    // MSA counted nouns: 0 uses the plural noun with "no", 1 and 2 have
    // dedicated singular/dual forms, 3-10 take the plural noun, and 11+
    // reverts to the singular noun — none of which is English's simple
    // one/many split.
    it("follows Arabic's singular/dual/plural counted-noun forms", () => {
      expect(MESSAGES.sessionsCount(0, "ar")).toBe("لا جلسات");
      expect(MESSAGES.sessionsCount(1, "ar")).toBe("جلسة واحدة");
      expect(MESSAGES.sessionsCount(2, "ar")).toBe("جلستان");
      expect(MESSAGES.sessionsCount(5, "ar")).toBe("5 جلسات");
      expect(MESSAGES.sessionsCount(11, "ar")).toBe("11 جلسة");
    });
  });
});

// arabicFilesCount sits in a *governed* position (mudaf ilayhi of the verbal
// noun "حفظ", an iḍāfa) rather than arabicSessionsCount's standalone-label
// position, so it must not share arabicSessionsCount's table: the dual is
// genitive (ملفين), not nominative (ملفان). Every count is asserted here so
// a future re-merge of the two tables gets caught.
describe("commitButtonLabel", () => {
  it("uses the singular/plural English noun, including at zero", () => {
    expect(MESSAGES.commitButtonLabel(0, "en")).toBe("Commit 0 files");
    expect(MESSAGES.commitButtonLabel(1, "en")).toBe("Commit 1 file");
    expect(MESSAGES.commitButtonLabel(2, "en")).toBe("Commit 2 files");
  });

  it("says just the bare verb at zero, since there is no noun for it to govern", () => {
    expect(MESSAGES.commitButtonLabel(0, "ar")).toBe("حفظ");
  });

  it("uses the genitive dual (ملفين), not the nominative dual (ملفان)", () => {
    expect(MESSAGES.commitButtonLabel(2, "ar")).toBe("حفظ ملفين");
  });

  it("follows Arabic's singular/3-10-plural/11+ counted-noun forms for the rest", () => {
    expect(MESSAGES.commitButtonLabel(1, "ar")).toBe("حفظ ملف واحد");
    expect(MESSAGES.commitButtonLabel(3, "ar")).toBe("حفظ 3 ملفات");
    expect(MESSAGES.commitButtonLabel(11, "ar")).toBe("حفظ 11 ملفًا");
  });
});

describe("pathBranchSeparator", () => {
  it("renders in both languages", () => {
    expect(MESSAGES.pathBranchSeparator("en")).toBe("on");
    expect(MESSAGES.pathBranchSeparator("ar")).toBe("على");
  });
});

describe("unknownSession", () => {
  it("names the session id at the tail in both languages", () => {
    expect(MESSAGES.unknownSession("s1", "ar").endsWith("s1")).toBe(true);
    expect(MESSAGES.unknownSession("s1", "en").endsWith("s1")).toBe(true);
  });

  // MINOR finding on Task 10's review: sessionId is renderer-supplied and
  // was echoed back unbounded.
  it("caps an unbounded sessionId instead of echoing it in full", () => {
    const huge = "x".repeat(10_000);
    const text = MESSAGES.unknownSession(huge, "en");
    expect(text.length).toBeLessThan(200);
    expect(text).not.toContain(huge);
  });
});

describe("invalidArgument", () => {
  it("renders in both languages without echoing anything back", () => {
    expect(MESSAGES.invalidArgument("en").length).toBeGreaterThan(0);
    expect(MESSAGES.invalidArgument("ar").length).toBeGreaterThan(0);
  });
});

describe("changesShowCurrentState", () => {
  it("names the agent and states the caveat in both languages", () => {
    expect(MESSAGES.changesShowCurrentState("claude-acme", "en")).toBe(
      "This session has ended — what's shown below is the repository's current state, not necessarily claude-acme's work.",
    );
    expect(MESSAGES.changesShowCurrentState("claude-acme", "ar")).toBe(
      "انتهت هذه الجلسة — ما يظهر أدناه هو الحالة الحالية للمستودع، وليس بالضرورة ما كتبه claude-acme.",
    );
  });
});

// Ruling P25: these three notices and core's gitDiffOpenedText
// (packages/core/src/git/messages.ts) describe the same GitFileDiff
// conditions for the same file at the same moment, so diffBinaryFile and
// diffTooLarge reuse gitDiffOpenedText's own wording rather than a second
// vocabulary — asserted here by pinning the exact strings.
describe("diffBinaryFile", () => {
  it("renders in both languages, matching core's gitDiffOpenedText wording", () => {
    expect(MESSAGES.diffBinaryFile("en")).toBe("Binary file — no diff to show.");
    expect(MESSAGES.diffBinaryFile("ar")).toBe("هذا ملف ثنائي ولا يمكن عرض فروقه.");
  });
});

describe("diffTooLarge", () => {
  it("renders in both languages, matching core's gitDiffOpenedText wording", () => {
    expect(MESSAGES.diffTooLarge("en")).toBe("Too large to show a diff for.");
    expect(MESSAGES.diffTooLarge("ar")).toBe("الملف كبير جدًا لعرض الفروق.");
  });

  // Ruling P8: tooLarge and binary describe different facts (never read at
  // all, vs. confirmed not text) and must not share wording.
  it("is worded distinctly from diffBinaryFile in both languages", () => {
    expect(MESSAGES.diffTooLarge("en")).not.toBe(MESSAGES.diffBinaryFile("en"));
    expect(MESSAGES.diffTooLarge("ar")).not.toBe(MESSAGES.diffBinaryFile("ar"));
  });
});

describe("diffNoChanges", () => {
  it("renders in both languages", () => {
    expect(MESSAGES.diffNoChanges("en")).toBe("No changes to show.");
    expect(MESSAGES.diffNoChanges("ar")).toBe("لا توجد تغييرات لعرضها.");
  });
});

describe("errorMessage", () => {
  it("extracts the message from an Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies a non-Error value", () => {
    expect(errorMessage("boom")).toBe("boom");
    expect(errorMessage(42)).toBe("42");
  });
});

describe("provider panel strings", () => {
  it("has an Arabic and an English form for every provider label", () => {
    for (const key of [
      "providersEmpty",
      "capacityLeftLabel",
      "capacityUnsupported",
      "capacityUnavailable",
      "capacityNeverRead",
      "refreshProviders",
    ] as const) {
      expect(MESSAGES[key]("ar")).not.toBe(MESSAGES[key]("en"));
      expect(MESSAGES[key]("ar")).not.toBe("");
    }
  });

  it("states a reset time as a label and a clock value, never as a counted duration", () => {
    const ar = MESSAGES.capacityResetsAt("14:30", "ar");
    expect(ar).toContain("14:30");
    // Ruling P30: no composed counted duration in either language.
    expect(ar).not.toMatch(/ساعات|ساعتين|يومين/);
    expect(MESSAGES.capacityResetsAt("14:30", "en")).toContain("14:30");
  });
});

// A hosted app's start is a real wait (measured: 1.9-2.3s warm, up to 21.6s
// for a cold DbGate), so it gets said out loud — in both languages, like
// every other string a person can see.
describe("hosted-app starting strings", () => {
  it("has an Arabic and an English form for each", () => {
    for (const key of ["editorStarting", "databaseStarting"] as const) {
      expect(MESSAGES[key]("ar")).not.toBe(MESSAGES[key]("en"));
      expect(MESSAGES[key]("ar")).not.toBe("");
      expect(MESSAGES[key]("en")).not.toBe("");
    }
    expect(MESSAGES.editorStarting("en")).toBe("Starting the editor…");
    expect(MESSAGES.databaseStarting("en")).toBe("Starting the database browser…");
  });
});

describe("cluster strings", () => {
  it("has both lanes for the cluster messages", () => {
    expect(MESSAGES.clusterUnavailable("en")).toBe("Could not open the cluster browser.");
    expect(MESSAGES.clusterUnavailable("ar")).toContain("عنقود");
    expect(MESSAGES.clusterStarting("en")).toBe("Starting the cluster browser…");
    expect(MESSAGES.clusterStarting("ar")).toContain("عنقود");
    expect(MESSAGES.noClustersConfigured("en")).toBe("No clusters configured for this project.");
    expect(MESSAGES.noClustersConfigured("ar")).toContain("عناقيد");
  });

  it("names AWS login timing out, in both languages", () => {
    expect(MESSAGES.clusterLoginTimedOut("en")).toContain("did not finish in time");
    expect(MESSAGES.clusterLoginTimedOut("ar")).toContain("لم تكتمل");
  });
});

describe("docker messages", () => {
  it("says both why Docker is unavailable, in both languages", () => {
    expect(MESSAGES.dockerNotInstalled("en")).toBe(
      "Docker is not installed, or is not on the shell PATH.",
    );
    expect(MESSAGES.dockerDaemonDown("en")).toBe("The Docker daemon is not running.");
    expect(MESSAGES.dockerNotInstalled("ar")).not.toBe(MESSAGES.dockerNotInstalled("en"));
    expect(MESSAGES.dockerDaemonDown("ar")).not.toBe(MESSAGES.dockerDaemonDown("en"));
  });

  it("names the container in every confirmation", () => {
    expect(MESSAGES.dockerConfirmStop("app", "en")).toContain("app");
    expect(MESSAGES.dockerConfirmRestart("app", "en")).toContain("app");
    expect(MESSAGES.dockerConfirmStop("app", "ar")).toContain("app");
    expect(MESSAGES.dockerConfirmRestart("app", "ar")).toContain("app");
  });

  it("warns that compose down removes containers", () => {
    expect(MESSAGES.dockerConfirmComposeDown("acme", "en")).toBe(
      "Take down the acme stack? This removes its containers.",
    );
    expect(MESSAGES.dockerConfirmComposeDown("acme", "ar")).toContain("acme");
  });

  it("distinguishes nothing configured from nothing composable", () => {
    expect(MESSAGES.dockerNoContainers("en")).toBe(
      "No containers configured for this project",
    );
    expect(MESSAGES.dockerNoComposeProject("en")).toBe(
      "These containers do not belong to a single compose project.",
    );
  });

  it("has an Arabic form for every docker message", () => {
    const both = [
      MESSAGES.dockerNoContainers,
      MESSAGES.dockerUnknownContainer,
      MESSAGES.dockerNoComposeProject,
    ];
    for (const message of both) {
      expect(message("ar")).not.toBe(message("en"));
      expect(message("ar")).not.toBe("");
    }
  });
});

// The bookmarks sidebar's own strings. The two controls the spec asks for
// (design :240 — a pin on every list row, an unpin on every grid tile) are
// named for a screen reader as well as a pointer, and the renderer never
// builds either string itself.
describe("the bookmarks sidebar", () => {
  it("names the pin and unpin controls in English", () => {
    expect(MESSAGES.pinBookmark("en")).toMatch(/pin/i);
    expect(MESSAGES.unpinBookmark("en")).toMatch(/unpin/i);
  });

  it("says the sidebar toggle shows or hides a sidebar, not a bar", () => {
    expect(MESSAGES.toggleBookmarksSidebar("en")).toMatch(/sidebar/i);
    expect(MESSAGES.toggleBookmarksSidebar("en")).not.toMatch(/bookmarks bar/i);
  });

  it("has an Arabic form for every sidebar message", () => {
    const both = [
      MESSAGES.pinBookmark,
      MESSAGES.unpinBookmark,
      MESSAGES.noEssentials,
      MESSAGES.toggleBookmarksSidebar,
    ];
    for (const message of both) {
      expect(message("ar")).not.toBe(message("en"));
      expect(message("ar")).not.toBe("");
    }
  });
});

describe("isWayland", () => {
  it("recognises a Wayland session by either marker", () => {
    // Neither is universal: XDG_SESSION_TYPE comes from the login manager and
    // some do not set it; WAYLAND_DISPLAY comes from the compositor.
    expect(isWayland({ XDG_SESSION_TYPE: "wayland" })).toBe(true);
    expect(isWayland({ WAYLAND_DISPLAY: "wayland-0" })).toBe(true);
  });

  it("does not mistake X11 for it", () => {
    // Including XWayland, where an X11 app's global shortcut does work — so
    // saying it does not would be wrong in the other direction.
    expect(isWayland({ XDG_SESSION_TYPE: "x11", DISPLAY: ":0" })).toBe(false);
  });

  it("does not mistake macOS, where neither variable exists", () => {
    expect(isWayland({})).toBe(false);
  });

  it("treats an empty WAYLAND_DISPLAY as unset", () => {
    expect(isWayland({ WAYLAND_DISPLAY: "" })).toBe(false);
  });
});

describe("MESSAGES.hotkeyUnavailableWayland", () => {
  it("names the combo in both languages", () => {
    expect(MESSAGES.hotkeyUnavailableWayland("Alt+Space", "en")).toContain("Alt+Space");
    expect(MESSAGES.hotkeyUnavailableWayland("Alt+Space", "ar")).toContain("Alt+Space");
  });

  it("is written in Arabic for an Arabic reader", () => {
    expect(MESSAGES.hotkeyUnavailableWayland("Alt+Space", "ar")).toMatch(/[\u0600-\u06FF]/);
  });

  it("points at what still works rather than at a conflict that does not exist", () => {
    // The collision message's advice — look for the app holding the combo —
    // is a wild goose chase here: Wayland lets no application hold one.
    const text = MESSAGES.hotkeyUnavailableWayland("Alt+Space", "en");
    expect(text).toMatch(/microphone/i);
    expect(text).not.toMatch(/another app/i);
  });
});

describe("prerequisite wording", () => {
  it("names every catalogue entry in both languages", () => {
    // Derived from the catalogue rather than a hand-written list, so a tool
    // cannot be added without its wording — which is how an English-only
    // string lane grows back.
    for (const prerequisite of PREREQUISITES) {
      for (const language of ["en", "ar"] as const) {
        expect(MESSAGES.prerequisiteName(prerequisite.id, language)).not.toBe("");
        expect(MESSAGES.prerequisiteUnlocks(prerequisite.id, language)).not.toBe("");
      }
    }
  });

  it("writes the Arabic line in Arabic", () => {
    // A table with both columns filled from English is the failure this rule
    // exists to prevent, and it looks complete until someone reads it.
    for (const prerequisite of PREREQUISITES) {
      expect(MESSAGES.prerequisiteUnlocks(prerequisite.id, "ar")).toMatch(/[؀-ۿ]/);
    }
  });

  it("counts tools the way Arabic counts them", () => {
    // Singular, dual, then the small-number plural — the same split
    // arabicFilesCount and arabicSessionsCount already make.
    expect(MESSAGES.setupInstallCount(1, "ar")).toContain("واحدة");
    expect(MESSAGES.setupInstallCount(2, "ar")).toContain("أداتين");
    expect(MESSAGES.setupInstallCount(3, "ar")).toContain("أدوات");
    expect(MESSAGES.setupInstallCount(3, "en")).toBe("Install 3 selected");
  });

});
