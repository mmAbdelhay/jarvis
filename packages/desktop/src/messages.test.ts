import { describe, expect, it } from "vitest";
import { PREREQUISITES } from "@jarvis/platform";
import { REMOTE_ERROR_CODES } from "@jarvis/remote";
import { PUSH_KINDS } from "@jarvis/wire";
import { errorMessage, isWayland, MESSAGES } from "./messages.js";

// Important 9: main.ts must not carry an English-only lane of user-facing
// strings beside @jarvis/core's bilingual MESSAGES table — every string a
// person can see or hear must survive Arabic.
describe("MESSAGES", () => {
  it("localises settings-save, menu, block, and every prayer string", () => {
    const unary = [
      MESSAGES.settingsSavedLive,
      MESSAGES.settingsSavedRestart,
      MESSAGES.reloadJarvis,
      MESSAGES.deleteBlock,
      MESSAGES.deleteBlockTitle,
      MESSAGES.prayerHeading,
      MESSAGES.prayerShow,
      MESSAGES.prayerLatitude,
      MESSAGES.prayerLongitude,
      MESSAGES.prayerUseLocation,
      MESSAGES.prayerLocationNote,
      MESSAGES.prayerNotifyBefore,
      MESSAGES.prayerNotifyBeforeMinutes,
      MESSAGES.prayerNotifyAtTime,
      MESSAGES.prayerAlexandria,
      MESSAGES.prayerCustomLocation,
      MESSAGES.prayerUnavailable,
      MESSAGES.prayerLocating,
      MESSAGES.prayerCurrentLocation,
      MESSAGES.renameTab,
      MESSAGES.tabRenameHint,
      MESSAGES.tabMenuRename,
      MESSAGES.tabMenuReload,
      MESSAGES.tabMenuClose,
    ];
    for (const message of unary) expect(message("ar")).not.toBe(message("en"));
    expect(MESSAGES.prayerDenied("Alexandria", "ar")).not.toBe(
      MESSAGES.prayerDenied("Alexandria", "en"),
    );
    expect(MESSAGES.prayerNext("Fajr", "2h", "ar")).not.toBe(
      MESSAGES.prayerNext("Fajr", "2h", "en"),
    );
    expect(MESSAGES.prayerNow("Fajr", "ar")).not.toBe(MESSAGES.prayerNow("Fajr", "en"));
    expect(MESSAGES.prayerTitle("Alexandria", "Fajr", "ar")).not.toBe(
      MESSAGES.prayerTitle("Alexandria", "Fajr", "en"),
    );
    expect(MESSAGES.prayerName("Fajr", "ar")).not.toBe(MESSAGES.prayerName("Fajr", "en"));
    expect(MESSAGES.prayerDuration(1, 2, "ar")).not.toBe(MESSAGES.prayerDuration(1, 2, "en"));
  });
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

  // M12 Task 7 (ruling 10, "voice leak"): no detail argument any more — a
  // desktop-origin transcription failure's own detail never reaches
  // turn:new, which every subscribed client (remote-paired phones
  // included) can see.
  it("renders the transcription-failed message in both languages, non-empty, distinct and detail-free", () => {
    const en = MESSAGES.transcriptionFailed("en");
    const ar = MESSAGES.transcriptionFailed("ar");
    expect(en).not.toBe("");
    expect(ar).not.toBe("");
    expect(en).not.toBe(ar);
    expect(ar).toContain("تحويل الصوت");
  });

  it("renders the nothing-heard notice in both languages, non-empty and distinct", () => {
    const en = MESSAGES.nothingHeard("en");
    const ar = MESSAGES.nothingHeard("ar");
    expect(en).not.toBe("");
    expect(ar).not.toBe("");
    expect(en).not.toBe(ar);
  });

  // Ruling 17: generic on purpose — never contains the laptop-side detail.
  it("renders the voice-turn-failed message in both languages, with no detail argument", () => {
    const en = MESSAGES.voiceTurnFailed("en");
    const ar = MESSAGES.voiceTurnFailed("ar");
    expect(en).not.toBe("");
    expect(ar).not.toBe("");
    expect(en).not.toBe(ar);
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

describe("remoteErrorText", () => {
  it("is non-empty and distinct between languages for every wire error code", () => {
    // Iterates @jarvis/remote's own REMOTE_ERROR_CODES rather than a hand
    // list, so a code added to the wire protocol without a translation here
    // fails this test rather than shipping an English-only (or silently
    // missing) sentence.
    for (const code of REMOTE_ERROR_CODES) {
      const en = MESSAGES.remoteErrorText(code, "en");
      const ar = MESSAGES.remoteErrorText(code, "ar");
      expect(en.length).toBeGreaterThan(0);
      expect(ar.length).toBeGreaterThan(0);
      expect(en).not.toBe(ar);
    }
  });
});

describe("remote:pair result strings", () => {
  it("are bilingual", () => {
    expect(MESSAGES.remotePairingDisabled("en").length).toBeGreaterThan(0);
    expect(MESSAGES.remotePairingDisabled("ar").length).toBeGreaterThan(0);
    expect(MESSAGES.remotePairingUnavailable("en").length).toBeGreaterThan(0);
    expect(MESSAGES.remotePairingUnavailable("ar").length).toBeGreaterThan(0);
    expect(MESSAGES.remoteRevokeFailed("en").length).toBeGreaterThan(0);
    expect(MESSAGES.remoteRevokeFailed("ar").length).toBeGreaterThan(0);
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

describe("dashboard core-stage strings", () => {
  it("has an Arabic and an English form for every simple label", () => {
    for (const key of [
      "dashboardProjectsLabel",
      "dashboardFilterPlaceholder",
      "dashboardFilterLabel",
      "dashboardAllSessions",
      "dashboardNodeWaiting",
      "dashboardIdle",
      "dashboardNoProjects",
      "dashboardNoMatches",
      "dashboardNoSessions",
      "dashboardActionTerminal",
      "dashboardActionEditor",
      "dashboardActionBrowser",
      "dashboardActionDocker",
    ] as const) {
      expect(MESSAGES[key]("ar")).not.toBe(MESSAGES[key]("en"));
      expect(MESSAGES[key]("ar")).not.toBe("");
      expect(MESSAGES[key]("en")).not.toBe("");
    }
  });

  it("states running and waiting counts distinctly in both languages", () => {
    expect(MESSAGES.dashboardRunningWaiting(2, 1, "en")).toBe("2 running · 1 waiting");
    expect(MESSAGES.dashboardRunningWaiting(2, 1, "ar")).not.toBe(
      MESSAGES.dashboardRunningWaiting(2, 1, "en"),
    );
  });

  it("counts a node's own running badge distinctly in both languages", () => {
    expect(MESSAGES.dashboardNodeRunning(1, "en")).toBe("1 running");
    expect(MESSAGES.dashboardNodeRunning(1, "ar")).not.toBe(MESSAGES.dashboardNodeRunning(1, "en"));
  });

  it("names an idle node's dirty-file count distinctly in both languages", () => {
    expect(MESSAGES.dashboardIdleDirty(6, "en")).toBe("6 changed");
    expect(MESSAGES.dashboardIdleDirty(6, "ar")).not.toBe(MESSAGES.dashboardIdleDirty(6, "en"));
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
    expect(MESSAGES.dockerNoContainers("en")).toBe("No containers configured for this project");
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

  // docker:follow's per-device cap (docker-followers.ts,
  // MAX_REMOTE_FOLLOWERS_PER_DEVICE).
  it("dockerFollowLimit is non-empty in both languages and they differ", () => {
    expect(MESSAGES.dockerFollowLimit("en")).not.toBe("");
    expect(MESSAGES.dockerFollowLimit("ar")).not.toBe("");
    expect(MESSAGES.dockerFollowLimit("ar")).not.toBe(MESSAGES.dockerFollowLimit("en"));
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

describe("the remote access panel", () => {
  const plain = [
    "remoteTitle",
    "remoteEnabledLabel",
    "remoteReachableOn",
    "remoteTailscaleLabel",
    "remoteWifiLabel",
    "remoteTailscaleMissing",
    "remoteAdvancedLabel",
    "remoteOtherAddress",
    "remoteOtherPlaceholder",
    "remoteAllInterfaces",
    "remotePortLabel",
    "remotePortNote",
    "remoteProxyLabel",
    "remoteProxyNote",
    "remotePushLabel",
    "remotePushNote",
    "remoteIdleLabel",
    "remoteIdleNote",
    "remotePushProjectsLabel",
    "remotePushProjectsNote",
    "remotePairTitle",
    "remoteNewCode",
    "remotePairSaveFirst",
    "remotePairInstructions",
    "remotePairCancel",
    "remoteDevicesTitle",
    "remoteNoDevices",
    "remoteDeviceConnected",
    "remoteDeviceNeverSeen",
    "remoteRevoke",
    "remoteConfirmTitle",
    "remoteConfirmSubtitle",
    "remoteConfirmDeviceLabel",
    "remoteConfirmFromLabel",
    "remoteConfirmApprove",
    "remoteConfirmDeny",
    "remoteWarning",
    "remoteNoCredential",
  ] as const;

  it.each(plain)("%s says something in both languages, and the Arabic is Arabic", (key) => {
    const en = MESSAGES[key]("en");
    const ar = MESSAGES[key]("ar");
    expect(en.trim()).not.toBe("");
    expect(ar).toMatch(/[؀-ۿ]/);
    expect(ar).not.toBe(en);
  });

  // The spec's sentence, verbatim: it is the honest framing of the feature.
  it("carries the spec's warning", () => {
    expect(MESSAGES.remoteWarning("en")).toContain(
      "While this is on, a paired device can run commands on this machine as you.",
    );
    expect(MESSAGES.remoteWarning("ar")).toContain("باسمك");
  });

  it("says no Tailscale credential is ever involved", () => {
    expect(MESSAGES.remoteNoCredential("en")).toContain("No Tailscale credential is ever involved");
    expect(MESSAGES.remoteNoCredential("ar")).toContain("بيانات اعتماد خاصة بـ Tailscale");
  });

  it("names the switch's state", () => {
    expect(MESSAGES.remoteState(true, "en")).toBe("On");
    expect(MESSAGES.remoteState(false, "en")).toBe("Off");
    expect(MESSAGES.remoteState(true, "ar")).toBe("مفعّل");
    expect(MESSAGES.remoteState(false, "ar")).toBe("متوقف");
  });

  it("is gone: remotePairUnavailable was replaced by remotePairSaveFirst/remotePairInstructions", () => {
    expect((MESSAGES as Record<string, unknown>)["remotePairUnavailable"]).toBeUndefined();
  });

  it("formats the pairing expiry as minutes:seconds", () => {
    expect(MESSAGES.remotePairExpires(107, "en")).toContain("1:47");
    expect(MESSAGES.remotePairExpires(120, "en")).toContain("2:00");
    expect(MESSAGES.remotePairExpires(107, "ar")).not.toBe(MESSAGES.remotePairExpires(107, "en"));
  });

  it("names the requesting device while waiting for confirmation", () => {
    expect(MESSAGES.remotePairWaiting("Ali's iPhone", "en")).toContain("Ali's iPhone");
    expect(MESSAGES.remotePairWaiting("Ali's iPhone", "ar")).toContain("Ali's iPhone");
    expect(MESSAGES.remotePairWaiting("x", "ar")).not.toBe(MESSAGES.remotePairWaiting("x", "en"));
  });

  it("remotePairWaitingParts splits on the template's own placeholder, not the name", () => {
    const parts = MESSAGES.remotePairWaitingParts("ar");
    expect(`${parts.before}الجهاز${parts.after}`).toBe(MESSAGES.remotePairWaiting("الجهاز", "ar"));
    expect(parts.before + parts.after).not.toContain("{name}");
  });

  it("covers all five RemoteProblem values, bilingually and distinctly", () => {
    const problems = [
      "bad-address",
      "listen-failed",
      "certificate-failed",
      "devices-unreadable",
      "devices-write-failed",
    ] as const;
    for (const problem of problems) {
      const en = MESSAGES.remoteProblem(problem, "en");
      const ar = MESSAGES.remoteProblem(problem, "ar");
      expect(en.trim()).not.toBe("");
      expect(ar).toMatch(/[؀-ۿ]/);
      expect(ar).not.toBe(en);
    }
  });

  it("builds the indicator text from host, port and whether pairing is open", () => {
    expect(MESSAGES.remoteIndicator("127.0.0.1", 7717, false, "en")).toContain("127.0.0.1:7717");
    expect(MESSAGES.remoteIndicator("127.0.0.1", 7717, true, "en")).toBe(
      MESSAGES.remoteIndicator("127.0.0.1", 7717, true, "en"),
    );
    expect(MESSAGES.remoteIndicator("127.0.0.1", 7717, true, "en")).toContain("127.0.0.1:7717");
    // Pairing-open reads differently from plain listening (same language,
    // same address) — not just a different translation of the same fact.
    expect(MESSAGES.remoteIndicator("127.0.0.1", 7717, true, "en")).not.toBe(
      MESSAGES.remoteIndicator("127.0.0.1", 7717, false, "en"),
    );
    expect(MESSAGES.remoteIndicator("127.0.0.1", 7717, true, "ar")).not.toBe(
      MESSAGES.remoteIndicator("127.0.0.1", 7717, true, "en"),
    );
    // ...and so does plain listening: it carries a state word too, not a
    // bare host:port that would be identical in both languages.
    expect(MESSAGES.remoteIndicator("127.0.0.1", 7717, false, "ar")).not.toBe(
      MESSAGES.remoteIndicator("127.0.0.1", 7717, false, "en"),
    );
    expect(MESSAGES.remoteIndicatorTitle(2, "ar")).not.toBe(MESSAGES.remoteIndicatorTitle(2, "en"));
  });

  it("names the requester in the confirmation body", () => {
    expect(MESSAGES.remoteConfirmBody("Probe laptop", "en")).toContain("Probe laptop");
    expect(MESSAGES.remoteConfirmBody("Probe laptop", "ar")).toContain("Probe laptop");
    expect(MESSAGES.remoteConfirmBody("x", "ar")).not.toBe(MESSAGES.remoteConfirmBody("x", "en"));
  });

  it("remoteConfirmBodyParts splits on the template's own placeholder, not the name — a name equal to the template's own word still lands at the real interpolation point", () => {
    const parts = MESSAGES.remoteConfirmBodyParts("ar");
    expect(`${parts.before}الجهاز${parts.after}`).toBe(MESSAGES.remoteConfirmBody("الجهاز", "ar"));
    expect(parts.before + parts.after).not.toContain("{name}");
  });

  it("formats a device's last-seen instant, localised per language", () => {
    const at = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(MESSAGES.remoteDeviceLastSeen(at, "en")).toContain("2026");
    expect(MESSAGES.remoteDeviceLastSeen(at, "ar")).toContain("2026");
    expect(MESSAGES.remoteDeviceLastSeen(at, "ar")).not.toBe(
      MESSAGES.remoteDeviceLastSeen(at, "en"),
    );
  });

  it("formats the idle-armed state with the disable time (M12 Task 4)", () => {
    const disableAt = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(MESSAGES.remoteIdleArmed(disableAt, "en")).toContain("2026");
    expect(MESSAGES.remoteIdleArmed(disableAt, "ar")).toContain("2026");
    expect(MESSAGES.remoteIdleArmed(disableAt, "ar")).not.toBe(
      MESSAGES.remoteIdleArmed(disableAt, "en"),
    );
  });

  it("embeds the minute count in the idle-disabled state, in both languages (M12 Task 4)", () => {
    const at = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(MESSAGES.remoteIdleDisabled(at, 30, "en")).toContain("2026");
    expect(MESSAGES.remoteIdleDisabled(at, 30, "en")).toContain("30");
    expect(MESSAGES.remoteIdleDisabled(at, 30, "ar")).toContain("30");
    expect(MESSAGES.remoteIdleDisabled(at, 30, "ar")).not.toBe(
      MESSAGES.remoteIdleDisabled(at, 30, "en"),
    );
  });

  it.each([
    [1, "دقيقة واحدة"],
    [2, "دقيقتين"],
    [3, "3 دقائق"],
    [10, "10 دقائق"],
    [11, "11 دقيقة"],
  ])("uses the Arabic minute grammar for %s", (minutes, phrase) => {
    expect(MESSAGES.remoteIdleDisabled(Date.UTC(2026, 0, 1, 12), minutes, "ar")).toContain(phrase);
  });

  it("names the platform in remoteDevicePush, bilingually (ruling h)", () => {
    expect(MESSAGES.remoteDevicePush("ios", "en")).toBe("Notifications on (iPhone)");
    expect(MESSAGES.remoteDevicePush("android", "en")).toContain("Android");
    expect(MESSAGES.remoteDevicePush("ios", "ar")).not.toBe(MESSAGES.remoteDevicePush("ios", "en"));
    expect(MESSAGES.remoteDevicePush("android", "ar")).not.toBe(
      MESSAGES.remoteDevicePush("android", "en"),
    );
    expect(MESSAGES.remoteDevicePush("ios", "ar")).not.toBe(
      MESSAGES.remoteDevicePush("android", "ar"),
    );
  });

  it.each([
    ["loopback", "lo0", "en", "This machine only"],
    ["lan", "en0", "en", "Local network — en0"],
    ["mesh", "utun4", "en", "Tailscale — utun4"],
    ["other", "eth0", "en", "Other network — eth0"],
    ["lan", "", "en", "Local network"],
    ["loopback", "lo0", "ar", "هذا الحاسوب فقط"],
    ["lan", "en0", "ar", "الشبكة المحلية — en0"],
    ["mesh", "utun4", "ar", "شبكة Tailscale — utun4"],
    ["other", "eth0", "ar", "شبكة أخرى — eth0"],
  ] as const)("labels a %s address on %j in %s", (kind, iface, language, expected) => {
    expect(MESSAGES.remoteBindChoiceLabel(kind, iface, language)).toBe(expected);
  });
});

// M10 Task 3: the push catalogue — the only bilingual text a notification's
// title/body ever carry. pushBody's `project` argument must never leak
// anything but the project name itself, and command-finished's `detail`
// must never carry the command.
describe("push notification catalogue", () => {
  it("names the app in both languages for pushTitle", () => {
    expect(MESSAGES.pushTitle("en")).toBe("Jarvis");
    expect(MESSAGES.pushTitle("ar")).toBe("جارفيس");
  });

  it("is non-empty and distinct between languages for every PushKind", () => {
    for (const kind of PUSH_KINDS) {
      const en = MESSAGES.pushBody(kind, undefined, "en", { ok: true, seconds: 60 });
      const ar = MESSAGES.pushBody(kind, undefined, "ar", { ok: true, seconds: 60 });
      expect(en.length).toBeGreaterThan(0);
      expect(ar.length).toBeGreaterThan(0);
      expect(en).not.toBe(ar);
    }
  });

  it("includes the project name for a session-* kind only when given", () => {
    expect(MESSAGES.pushBody("session-done", "acme", "en", undefined)).toContain("acme");
    expect(MESSAGES.pushBody("session-done", undefined, "en", undefined)).not.toContain(
      "undefined",
    );
  });

  it("rounds command-finished's seconds to minutes and never echoes the raw seconds", () => {
    const text = MESSAGES.pushBody("command-finished", undefined, "en", {
      ok: false,
      seconds: 150,
    });
    expect(text).toContain("3");
    expect(text).not.toContain("150");
    expect(text).toMatch(/fail/i);
  });

  // Deferred minor: command-finished with no detail must never fabricate a
  // duration or a success/failure it was never told.
  it("gives a neutral command-finished body when detail is undefined", () => {
    const en = MESSAGES.pushBody("command-finished", undefined, "en", undefined);
    const ar = MESSAGES.pushBody("command-finished", undefined, "ar", undefined);
    expect(en).not.toMatch(/succeed|fail/i);
    expect(en).not.toMatch(/\d/);
    expect(ar).not.toMatch(/نجح|فشل/);
    expect(ar).not.toMatch(/\d/);
  });

  it("starts the Arabic command-finished body with انتهى تنفيذ أمر, with and without detail", () => {
    expect(
      MESSAGES.pushBody("command-finished", undefined, "ar", { ok: true, seconds: 60 }),
    ).toMatch(/^انتهى تنفيذ أمر/);
    expect(MESSAGES.pushBody("command-finished", undefined, "ar", undefined)).toMatch(
      /^انتهى تنفيذ أمر/,
    );
  });

  it("never leaks a project name for a kind that carries none", () => {
    expect(
      MESSAGES.pushBody("command-finished", "acme", "en", { ok: true, seconds: 60 }),
    ).not.toContain("acme");
    expect(MESSAGES.pushBody("reply", "acme", "en", undefined)).not.toContain("acme");
  });

  it("says why registration failed, in both languages, and this is the laptop's only registered:false text", () => {
    expect(MESSAGES.pushRegisterInvalid("en")).toBe(
      "This device could not be registered for notifications",
    );
    expect(MESSAGES.pushRegisterInvalid("ar").length).toBeGreaterThan(0);
    expect(MESSAGES.pushRegisterInvalid("ar")).not.toBe(MESSAGES.pushRegisterInvalid("en"));
  });

  it("declares exactly these three push* builders", () => {
    const pushKeys = Object.keys(MESSAGES).filter((key) => key.startsWith("push"));
    expect(pushKeys.sort()).toEqual(["pushBody", "pushRegisterInvalid", "pushTitle"]);
  });
});
