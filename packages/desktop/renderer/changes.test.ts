// @vitest-environment jsdom
//
// Follows the harness pattern in app.test.ts: lay down the minimal DOM
// changes.ts's `$(id)` lookups touch, stub `window.jarvis`, then import the
// module fresh. Unlike app.ts, changes.ts does no work at module-import
// time (no top-level `$()` calls) — every lookup happens inside
// openChanges/showView, so there is no "wire the minimal DOM or the module
// throws on import" step here.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitFileChange, GitFileDiff } from "@jarvis/core";
import type { ChangesView, GitViewResult, RendererApi } from "../src/ipc.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import { detectLanguage, formatAgo } from "./format.js";

// Full RendererApi stub: every member defaults to a vi.fn() so a test that
// only cares about one or two bridge calls never has to enumerate the rest,
// while `openChangesWith` below can still override gitDiff/gitSetStaged/
// gitCommit for Tasks 13-15 without a second stub existing anywhere.
function stubJarvis(overrides: Partial<RendererApi>): RendererApi {
  const notStubbed: GitViewResult<never> = {
    ok: false as const,
    text: "not stubbed in this test",
    language: "en",
  };
  const defaults: RendererApi = {
    // The tests in this file exercise the Changes route, which has no
    // chords of its own; darwin keeps them reading as they always have.
    platform: "darwin",
    firstRun: false,
    checkPrerequisites: vi.fn(async () => []),
    installPrerequisite: vi.fn(async () => ({ ok: true })),
    onInstallOutput: vi.fn(),
    send: vi.fn(async () => {}),
    startVoice: vi.fn(async () => {}),
    stopVoice: vi.fn(async () => {}),
    onMetrics: vi.fn(),
    onSessions: vi.fn(),
    onTurn: vi.fn(),
    onListening: vi.fn(),
    onNotice: vi.fn(),
    onVoiceHotkeys: vi.fn(),
    getHistory: vi.fn(async () => []),
    gitChanges: vi.fn(async () => notStubbed),
    gitDiff: vi.fn(async () => notStubbed),
    gitSetStaged: vi.fn(async () => notStubbed),
    gitCommit: vi.fn(async () => notStubbed),
    onChangeCounts: vi.fn(),
    onSessionOutput: vi.fn(),
    getSessionLog: vi.fn(async () => ""),
    getSessionTranscript: vi.fn(async () => []),
    resumeSession: vi.fn(async () => ({ ok: true, project: "app", language: "en" as const })),
    sendSessionInput: vi.fn(async () => {}),
    resizeSession: vi.fn(async () => {}),
    setVoiceTarget: vi.fn(async () => {}),
    onProviders: vi.fn(),
    openTab: vi.fn(async () => {}),
    closeTab: vi.fn(async () => {}),
    activateTab: vi.fn(async () => {}),
    navigateTab: vi.fn(async () => {}),
    tabBack: vi.fn(async () => {}),
    tabForward: vi.fn(async () => {}),
    tabReload: vi.fn(async () => {}),
    setWorkspaceBounds: vi.fn(async () => {}),
    setWorkspaceVisible: vi.fn(async () => {}),
    onWorkspace: vi.fn(),
    openEditor: vi.fn(async () => notStubbed),
    editorRoots: vi.fn(async () => []),
    openDatabase: vi.fn(async () => notStubbed),
    openCluster: vi.fn(async () => notStubbed),
    clusterNames: vi.fn(async () => []),
    openChat: vi.fn(async () => notStubbed),
    chatNames: vi.fn(async () => []),
    openTerminal: vi.fn(async () => notStubbed),
    suggestCompletions: vi.fn(async () => []),
    terminalHistory: vi.fn(async () => []),
    listTerminalDir: vi.fn(async () => []),
    openTerminalFile: vi.fn(async () => notStubbed),
    terminalSettings: vi.fn(async () => ({
      blocks: true,
      inputEditor: true,
      notifyAfterSeconds: 30,
      home: "/home/x",
      scrollback: 5000,
    })),
    terminalWorkflows: vi.fn(async () => []),
    terminalAi: vi.fn(async () => ""),
    terminalChips: vi.fn(async () => undefined),
    setDevTools: vi.fn(async () => {}),
    openDockerTab: vi.fn(async () => notStubbed),
    dockerNames: vi.fn(async () => notStubbed),
    dockerView: vi.fn(async () => notStubbed),
    dockerContainers: vi.fn(async () => notStubbed),
    dockerStart: vi.fn(async () => notStubbed),
    dockerStop: vi.fn(async () => notStubbed),
    dockerRestart: vi.fn(async () => notStubbed),
    dockerComposeUp: vi.fn(async () => notStubbed),
    dockerComposeDown: vi.fn(async () => notStubbed),
    dockerShell: vi.fn(async () => notStubbed),
    dockerFollow: vi.fn(async () => notStubbed),
    dockerUnfollow: vi.fn(async () => {}),
    onDockerLog: vi.fn(),
    openApiTab: vi.fn(async () => notStubbed),
    listApiCollections: vi.fn(async () => notStubbed),
    readApiTree: vi.fn(async () => notStubbed),
    readApiRequest: vi.fn(async () => notStubbed),
    saveApiRequest: vi.fn(async () => notStubbed),
    sendApiRequest: vi.fn(async () => notStubbed),
    apiCurl: vi.fn(async () => notStubbed),
    apiHistory: vi.fn(async () => notStubbed),
    clearApiHistory: vi.fn(async () => notStubbed),
    apiCookies: vi.fn(async () => notStubbed),
    clearApiCookies: vi.fn(async () => notStubbed),
    removeApiCookie: vi.fn(async () => notStubbed),
    apiSettings: vi.fn(async () => notStubbed),
    saveApiSettings: vi.fn(async () => notStubbed),
    onSpeaking: vi.fn(),
    listVoices: vi.fn(async () => []),
    previewVoice: vi.fn(async () => {}),
    pickFiles: vi.fn(async () => []),
    readJsonFile: vi.fn(async () => notStubbed),
    createApiRequest: vi.fn(async () => notStubbed),
    createApiFolder: vi.fn(async () => notStubbed),
    renameApiEntry: vi.fn(async () => notStubbed),
    deleteApiEntry: vi.fn(async () => notStubbed),
    createApiCollection: vi.fn(async () => notStubbed),
    saveApiEnvironment: vi.fn(async () => notStubbed),
    importPostmanCollection: vi.fn(async () => notStubbed),
    setDevToolsBounds: vi.fn(async () => {}),
    setDevToolsDock: vi.fn(async () => {}),
    showDevToolsDockMenu: vi.fn(async () => {}),
    onDevToolsDockChosen: vi.fn(),
    onDevToolsClosed: vi.fn(),
    attachTerminal: vi.fn(async () => ""),
    sendTerminalInput: vi.fn(async () => {}),
    resizeTerminal: vi.fn(async () => {}),
    onTerminalData: vi.fn(),
    onTerminalExit: vi.fn(),
    splitTerminal: vi.fn(async () => {}),
    closeTerminalPane: vi.fn(async () => {}),
    listBookmarks: vi.fn(async () => notStubbed),
    addBookmark: vi.fn(async () => notStubbed),
    removeBookmark: vi.fn(async () => notStubbed),
    setBookmarkPinned: vi.fn(async () => notStubbed),
    renameBookmark: vi.fn(async () => notStubbed),
    reorderBookmarks: vi.fn(async () => notStubbed),
    getSettings: vi.fn(async () => {
      throw new Error("not stubbed in this test");
    }),
    saveSettings: vi.fn(async () => ({
      ok: false as const,
      text: "not stubbed in this test",
      detail: "not stubbed in this test",
      language: "en" as const,
    })),
    testAgent: vi.fn(async () => ({
      id: "unstubbed",
      ok: false,
      detail: "not stubbed in this test",
    })),
    restartApp: vi.fn(async () => {}),
    hideAllTabs: vi.fn(async () => {}),
    requestPictureInPicture: vi.fn(async () => {}),
    getProjects: vi.fn(async () => []),
    refreshProviders: vi.fn(async () => {}),
  };
  const jarvis: RendererApi = { ...defaults, ...overrides };
  window.jarvis = jarvis;
  return jarvis;
}

/** Builds a ChangesView around `files` and stubs every bridge method the
 *  Changes view calls. `overrides` replaces individual bridge methods. */
async function openChangesWith(
  files: GitFileChange[],
  select?: string,
  overrides: Partial<RendererApi> = {},
): Promise<RendererApi> {
  const jarvis = stubJarvis({
    gitChanges: vi.fn(async () => ({
      ok: true as const,
      value: {
        session: {
          id: "s1",
          project: "acme",
          projectPath: "~/projects/acme",
          agentId: "claude-acme",
          lastActivityAt: Date.now(),
          endedAt: undefined,
        },
        changes: {
          repoPath: "~/projects/acme",
          branch: "feat/checkout-retry",
          detached: false,
          files,
          insertions: files.reduce((total, file) => total + file.insertions, 0),
          deletions: files.reduce((total, file) => total + file.deletions, 0),
        },
      },
    })),
    gitDiff: vi.fn(async (_id: string, path: string) => ({
      ok: true as const,
      value: { path, binary: false, hunks: [] },
    })),
    gitSetStaged: vi.fn(async () => ({ ok: true as const, value: null })),
    gitCommit: vi.fn(async () => ({ ok: true as const, value: null })),
    ...overrides,
  });
  const { openChanges, wireCommitBar, wireDiffModes } = await import("./changes.js");
  // wireDiffModes/wireCommitBar are normally called once from app.ts; this
  // harness has no app.ts, so each test's own module instance
  // (vi.resetModules() in beforeEach) wires its own Side-by-side/Unified
  // toggle and commit bar here instead.
  wireDiffModes();
  wireCommitBar();
  await openChanges("s1", select);
  return jarvis;
}

/** One changed file whose diff is `diff`. */
async function openChangesWithDiff(diff: GitFileDiff): Promise<RendererApi> {
  return openChangesWith(
    [{ path: diff.path, status: "M", insertions: 1, deletions: 1, staged: false }],
    undefined,
    { gitDiff: vi.fn(async () => ({ ok: true as const, value: diff })) },
  );
}

/** One changed file whose diff read fails. */
async function openChangesWithDiffFailure(failure: {
  text: string;
  language: "ar" | "en";
}): Promise<RendererApi> {
  return openChangesWith(
    [{ path: "a.php", status: "M", insertions: 1, deletions: 1, staged: false }],
    undefined,
    { gitDiff: vi.fn(async () => ({ ok: false as const, ...failure })) },
  );
}

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = `
    <div class="main"></div>
    <div class="main main--changes" id="view-changes" hidden>
      <div class="changes-head">
        <div id="changes-title" class="changes-title">Changes</div>
        <div id="changes-project" class="chip mono"></div>
        <div id="changes-path" class="mono changes-muted"></div>
        <div id="changes-path-branch-sep" class="mono changes-muted">on</div>
        <div id="changes-branch" class="mono changes-dim"></div>
        <div id="changes-add" class="mono diff-add" dir="ltr"></div>
        <div id="changes-del" class="mono diff-del" dir="ltr"></div>
        <div id="changes-by" class="mono changes-muted"></div>
      </div>
      <div id="changes-stale-notice" class="changes-notice" hidden></div>
      <div id="changes-error" class="changes-error" hidden></div>
      <div class="changes-files-head">
        <div id="changes-files-label" class="lbl">CHANGED FILES</div>
        <div id="changes-count" class="mono changes-count"></div>
      </div>
      <div id="changes-file-list" class="changes-file-list"></div>
      <div class="changes-diff">
        <div class="diff-head">
          <div id="diff-filename" class="mono changes-dim"></div>
          <div class="diff-toggle">
            <button id="diff-mode-side" class="diff-mode diff-mode--on" type="button">Side by side</button>
            <button id="diff-mode-unified" class="diff-mode" type="button">Unified</button>
          </div>
        </div>
        <div id="diff-body" class="diff-body"></div>
        <div class="commit-bar">
          <input id="commit-message" class="commit-input" type="text" dir="auto" autocomplete="off" placeholder="Commit message…" />
          <button id="commit-button" class="commit-btn" type="button">Commit</button>
        </div>
      </div>
    </div>
    <button id="nav-dashboard" class="nav-btn nav-btn--on" type="button"></button>
    <button id="nav-changes" class="nav-btn" type="button"></button>
  `;
});

describe("openChanges", () => {
  // Pinned rather than read back from Date.now() at assertion time: the
  // header's "written by X · 6m ago" is built from a clock reading taken
  // inside openChanges, and re-reading the clock here can land in the next
  // whole minute and flake.
  const ACTIVE_AT = Date.now() - 6 * 60_000;

  it("names the session, project path, branch and totals in the header", async () => {
    const jarvis = stubJarvis({
      gitChanges: vi.fn(async () => ({
        ok: true as const,
        value: {
          session: {
            id: "s1",
            project: "acme",
            projectPath: "~/projects/acme",
            agentId: "claude-acme",
            lastActivityAt: ACTIVE_AT,
            endedAt: undefined,
          },
          changes: {
            repoPath: "~/projects/acme",
            branch: "feat/checkout-retry",
            detached: false,
            files: [],
            insertions: 128,
            deletions: 34,
          },
        },
      })),
    });

    const { openChanges } = await import("./changes.js");
    await openChanges("s1");

    expect(document.getElementById("changes-project")?.textContent).toBe("acme");
    expect(document.getElementById("changes-path")?.textContent).toBe("~/projects/acme");
    expect(document.getElementById("changes-branch")?.textContent).toBe("feat/checkout-retry");
    expect(document.getElementById("changes-add")?.textContent).toBe("+128");
    expect(document.getElementById("changes-del")?.textContent).toBe("−34");
    expect(document.getElementById("changes-by")?.textContent).toBe(
      MESSAGES.writtenBy(
        "claude-acme",
        formatAgo(ACTIVE_AT, Date.now(), PRIMARY_LANGUAGE),
        PRIMARY_LANGUAGE,
      ),
    );
    expect(jarvis.gitChanges).toHaveBeenCalledWith("s1");
  });

  it("shows a git failure in the view instead of throwing", async () => {
    stubJarvis({
      gitChanges: vi.fn(async () => ({
        ok: false as const,
        text: "هذا المجلد ليس مستودع git.",
        language: "ar" as const,
      })),
    });

    const { openChanges } = await import("./changes.js");
    await openChanges("s1");

    const banner = document.getElementById("changes-error");
    expect(banner?.hidden).toBe(false);
    expect(banner?.textContent).toBe("هذا المجلد ليس مستودع git.");
    expect(banner?.dir).toBe("rtl");
  });

  it("renders an Arabic project name right-to-left", async () => {
    stubJarvis({
      gitChanges: vi.fn(async () => ({
        ok: true as const,
        value: {
          session: {
            id: "s1",
            project: "متجر",
            projectPath: "~/مشاريع/متجر",
            agentId: "claude-main",
            lastActivityAt: Date.now(),
            endedAt: undefined,
          },
          changes: {
            repoPath: "~/مشاريع/متجر",
            branch: "رئيسي",
            detached: false,
            files: [],
            insertions: 0,
            deletions: 0,
          },
        },
      })),
    });

    const { openChanges } = await import("./changes.js");
    await openChanges("s1");

    expect(document.getElementById("changes-project")?.dir).toBe("rtl");
    expect(document.getElementById("changes-branch")?.dir).toBe("rtl");
  });

  it("clears a previous error banner on a subsequent successful open (opening twice in a row)", async () => {
    let call = 0;
    stubJarvis({
      gitChanges: vi.fn(async () => {
        call += 1;
        if (call === 1) {
          return { ok: false as const, text: "not a git repo", language: "en" as const };
        }
        return {
          ok: true as const,
          value: {
            session: {
              id: "s1",
              project: "acme",
              projectPath: "~/projects/acme",
              agentId: "claude-acme",
              lastActivityAt: Date.now(),
              endedAt: undefined,
            },
            changes: {
              repoPath: "~/projects/acme",
              branch: "main",
              detached: false,
              files: [],
              insertions: 0,
              deletions: 0,
            },
          },
        };
      }),
    });

    const { openChanges } = await import("./changes.js");
    await openChanges("s1");
    expect(document.getElementById("changes-error")?.hidden).toBe(false);

    await openChanges("s1");
    expect(document.getElementById("changes-error")?.hidden).toBe(true);
    expect(document.getElementById("changes-branch")?.textContent).toBe("main");
  });

  it("shows an empty state (zero totals, no throw) for a repo with no changes", async () => {
    stubJarvis({
      gitChanges: vi.fn(async () => ({
        ok: true as const,
        value: {
          session: {
            id: "s1",
            project: "acme",
            projectPath: "~/projects/acme",
            agentId: "claude-acme",
            lastActivityAt: Date.now(),
            endedAt: undefined,
          },
          changes: {
            repoPath: "~/projects/acme",
            branch: "main",
            detached: false,
            files: [],
            insertions: 0,
            deletions: 0,
          },
        },
      })),
    });

    const { openChanges } = await import("./changes.js");
    await openChanges("s1");

    expect(document.getElementById("changes-add")?.textContent).toBe("+0");
    expect(document.getElementById("changes-del")?.textContent).toBe("−0");
    expect(document.getElementById("changes-error")?.hidden).toBe(true);
  });

  // I3: a failed gitChanges() for session B must not leave session A's file
  // list, diff pane, filename or header on screen — that reads as B's data
  // under the error banner, and a click on one of A's still-rendered rows
  // would fire gitDiff() against A (the row's closure captured A's view).
  it("clears the previous session's file list, diff pane and header on a failed re-open", async () => {
    let call = 0;
    const gitDiff = vi.fn(async (_id: string, path: string) => ({
      ok: true as const,
      value: { path, binary: false, hunks: [] },
    }));
    stubJarvis({
      gitChanges: vi.fn(async () => {
        call += 1;
        if (call === 1) {
          return {
            ok: true as const,
            value: {
              session: {
                id: "a",
                project: "acme",
                projectPath: "~/projects/acme",
                agentId: "claude-acme",
                lastActivityAt: Date.now(),
                endedAt: undefined,
              },
              changes: {
                repoPath: "~/projects/acme",
                branch: "feat/checkout-retry",
                detached: false,
                files: [
                  {
                    path: "a.php",
                    status: "M" as const,
                    insertions: 1,
                    deletions: 1,
                    staged: false,
                  },
                ],
                insertions: 1,
                deletions: 1,
              },
            },
          };
        }
        return {
          ok: false as const,
          text: "That folder isn't a git repository.",
          language: "en" as const,
        };
      }),
      gitDiff,
    });

    const { openChanges } = await import("./changes.js");
    await openChanges("a");

    expect(document.getElementById("changes-file-list")?.children.length).toBeGreaterThan(0);
    expect(document.getElementById("diff-filename")?.textContent).toBe("a.php");
    expect(gitDiff).toHaveBeenCalledTimes(1);

    const staleRow = document.querySelector<HTMLElement>(".file-row");
    expect(staleRow).not.toBeNull();

    await openChanges("b");

    expect(document.getElementById("changes-error")?.hidden).toBe(false);
    expect(document.getElementById("changes-file-list")?.children.length).toBe(0);
    expect(document.getElementById("diff-body")?.children.length).toBe(0);
    expect(document.getElementById("diff-filename")?.textContent).toBe("");
    expect(document.getElementById("changes-project")?.textContent).toBe("");
    expect(document.getElementById("changes-path")?.textContent).toBe("");
    expect(document.getElementById("changes-branch")?.textContent).toBe("");

    // The row from session A no longer exists in the DOM at all (its parent
    // was replaced), so it cannot be clicked to fire gitDiff() against A.
    expect(document.body.contains(staleRow)).toBe(false);
    expect(gitDiff).toHaveBeenCalledTimes(1);
  });
});

// Ruling P22: gitChanges() always reads the repository's *current* working
// tree, not a snapshot tied to a particular session, so opening the view
// from a History row would otherwise show today's uncommitted work under a
// finished session's name and agent — implying that agent wrote it, exactly
// the lie ruling P21 already removed from the session badge. The Changes
// view keeps the affordance (History rows still open it) but says so
// plainly whenever the session it was opened for has already ended.
describe("the P22 current-state notice", () => {
  async function openEndedSession(): Promise<void> {
    stubJarvis({
      gitChanges: vi.fn(async () => ({
        ok: true as const,
        value: {
          session: {
            id: "s1",
            project: "acme",
            projectPath: "~/projects/acme",
            agentId: "claude-acme",
            lastActivityAt: Date.now(),
            endedAt: 1_700_000_000_000,
          },
          changes: {
            repoPath: "~/projects/acme",
            branch: "main",
            detached: false,
            files: [],
            insertions: 0,
            deletions: 0,
          },
        },
      })),
    });
    const { openChanges } = await import("./changes.js");
    await openChanges("s1");
  }

  it("shows the notice, naming the agent, for a session that has ended", async () => {
    await openEndedSession();
    const notice = document.getElementById("changes-stale-notice");
    expect(notice?.hidden).toBe(false);
    expect(notice?.textContent).toContain("claude-acme");
    // The notice is renderer-generated, not echoed from a main-process
    // failure, so it follows PRIMARY_LANGUAGE the same way app.ts's
    // history-count badge does. Asserted through MESSAGES rather than a
    // literal so this keeps testing the wiring when the default flips.
    // Asserted against the notice's own text rather than against
    // PRIMARY_LANGUAGE directly: PRIMARY_LANGUAGE is a literal type, so
    // `=== "ar"` is a compile-time-false comparison, and "the direction
    // matches the language of the words shown" is the real invariant.
    expect(notice?.dir).toBe(detectLanguage(notice?.textContent ?? "") === "ar" ? "rtl" : "ltr");
    expect(notice?.textContent).toBe(
      MESSAGES.changesShowCurrentState("claude-acme", PRIMARY_LANGUAGE),
    );
  });

  it("stays hidden for a session that is still live", async () => {
    stubJarvis({
      gitChanges: vi.fn(async () => ({
        ok: true as const,
        value: {
          session: {
            id: "s1",
            project: "acme",
            projectPath: "~/projects/acme",
            agentId: "claude-acme",
            lastActivityAt: Date.now(),
            endedAt: undefined,
          },
          changes: {
            repoPath: "~/projects/acme",
            branch: "main",
            detached: false,
            files: [],
            insertions: 0,
            deletions: 0,
          },
        },
      })),
    });
    const { openChanges } = await import("./changes.js");
    await openChanges("s1");
    expect(document.getElementById("changes-stale-notice")?.hidden).toBe(true);
  });

  it("hides again once a live session is opened after an ended one", async () => {
    await openEndedSession();
    expect(document.getElementById("changes-stale-notice")?.hidden).toBe(false);

    (
      window.jarvis.gitChanges as unknown as { mockImplementation: (fn: unknown) => void }
    ).mockImplementation(async () => ({
      ok: true as const,
      value: {
        session: {
          id: "s1",
          project: "acme",
          projectPath: "~/projects/acme",
          agentId: "claude-acme",
          lastActivityAt: Date.now(),
          endedAt: undefined,
        },
        changes: {
          repoPath: "~/projects/acme",
          branch: "main",
          detached: false,
          files: [],
          insertions: 0,
          deletions: 0,
        },
      },
    }));

    const { openChanges } = await import("./changes.js");
    await openChanges("s1");
    expect(document.getElementById("changes-stale-notice")?.hidden).toBe(true);
  });
});

// I2: the Changes view shipped as an English-only lane in an
// Arabic-primary app (Global Constraints names this exact defect). These
// pin the static-chrome initializer and the per-row aria-labels, alongside
// the commit-button-label and TESTS-group-label coverage already updated
// above to expect Arabic (this app's PRIMARY_LANGUAGE).
describe("applyStaticChrome", () => {
  it("fills every placeholder label from MESSAGES at the primary language", async () => {
    const { applyStaticChrome } = await import("./changes.js");
    applyStaticChrome();

    expect(document.getElementById("nav-dashboard")?.textContent).toBe(
      MESSAGES.navDashboard(PRIMARY_LANGUAGE),
    );
    expect(document.getElementById("nav-changes")?.textContent).toBe(
      MESSAGES.navChanges(PRIMARY_LANGUAGE),
    );
    expect(document.getElementById("changes-files-label")?.textContent).toBe(
      MESSAGES.changedFilesLabel(PRIMARY_LANGUAGE),
    );
    expect(document.getElementById("changes-path-branch-sep")?.textContent).toBe(
      MESSAGES.pathBranchSeparator(PRIMARY_LANGUAGE),
    );
    expect(document.getElementById("diff-mode-side")?.textContent).toBe(
      MESSAGES.sideBySideLabel(PRIMARY_LANGUAGE),
    );
    expect(document.getElementById("diff-mode-unified")?.textContent).toBe(
      MESSAGES.unifiedLabel(PRIMARY_LANGUAGE),
    );
    const message = document.getElementById("commit-message");
    expect(message instanceof HTMLInputElement && message.placeholder).toBe(
      MESSAGES.commitMessagePlaceholder(PRIMARY_LANGUAGE),
    );
  });

  it("does not throw against app.test.ts's minimal DOM, which lacks this markup", async () => {
    document.body.innerHTML = "";
    const { applyStaticChrome } = await import("./changes.js");
    expect(() => applyStaticChrome()).not.toThrow();
  });
});

describe("BEFORE/AFTER pane headers", () => {
  it("renders the Arabic column labels, not the artboard's literal English", async () => {
    await openChangesWithDiff({
      path: "a.php",
      binary: false,
      hunks: [
        {
          header: "@@ -1,1 +1,1 @@",
          lines: [{ kind: "context", text: "x", beforeLine: 1, afterLine: 1 }],
        },
      ],
    });

    const headers = [...document.querySelectorAll(".pane-head")].map((el) => el.textContent);
    expect(headers).toEqual([
      MESSAGES.beforeColumnLabel(PRIMARY_LANGUAGE),
      MESSAGES.afterColumnLabel(PRIMARY_LANGUAGE),
    ]);
  });
});

describe("stage/unstage aria-labels", () => {
  it("names the action at the app's primary language", async () => {
    await openChangesWith([
      { path: "a.php", status: "M", insertions: 1, deletions: 0, staged: false },
      { path: "b.php", status: "M", insertions: 1, deletions: 0, staged: true },
    ]);

    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".file-stage")];
    expect(buttons[0]?.getAttribute("aria-label")).toBe(MESSAGES.stageFileLabel(PRIMARY_LANGUAGE));
    expect(buttons[1]?.getAttribute("aria-label")).toBe(
      MESSAGES.unstageFileLabel(PRIMARY_LANGUAGE),
    );
  });
});

const FILES = [
  { path: "CheckoutService.php", status: "M" as const, insertions: 42, deletions: 9, staged: true },
  { path: "RetryPolicy.php", status: "A" as const, insertions: 61, deletions: 0, staged: false },
  { path: "LegacyRetry.php", status: "D" as const, insertions: 0, deletions: 16, staged: false },
  {
    path: "tests/RetryPolicyTest.php",
    status: "A" as const,
    insertions: 8,
    deletions: 0,
    staged: false,
  },
];

describe("the changed-files panel", () => {
  it("lists every file with its status letter and counts", async () => {
    const { selectedPath } = await import("./changes.js");
    void selectedPath;
    await openChangesWith(FILES);

    const rows = [...document.querySelectorAll(".file-row")];
    expect(rows).toHaveLength(4);
    expect(rows[0]?.querySelector(".file-status")?.textContent).toBe("M");
    expect(rows[0]?.querySelector(".file-name")?.textContent).toBe("CheckoutService.php");
    expect(rows[0]?.querySelector(".diff-add")?.textContent).toBe("+42");
    expect(rows[0]?.querySelector(".diff-del")?.textContent).toBe("−9");
  });

  it("omits a zero count instead of printing +0", async () => {
    await openChangesWith(FILES);
    const added = [...document.querySelectorAll(".file-row")][1];
    expect(added?.querySelector(".diff-del")).toBeNull();
  });

  it("shows the file count in the panel header", async () => {
    await openChangesWith(FILES);
    expect(document.getElementById("changes-count")?.textContent).toBe("4");
  });

  it("groups test files under a TESTS label, as the artboard does", async () => {
    await openChangesWith(FILES);
    const labels = [...document.querySelectorAll(".file-group")].map((el) => el.textContent);
    expect(labels).toEqual([MESSAGES.testsGroupLabel(PRIMARY_LANGUAGE)]);
    const rows = [...document.querySelectorAll(".file-row .file-name")].map((el) => el.textContent);
    expect(rows[3]).toBe("tests/RetryPolicyTest.php");
  });

  it("does not sweep a merely test-like filename into the TESTS group (contest.php)", async () => {
    await openChangesWith([
      { path: "contest.php", status: "M" as const, insertions: 1, deletions: 0, staged: false },
    ]);
    expect(document.querySelectorAll(".file-group")).toHaveLength(0);
  });

  it("groups a spec/ directory under TESTS too", async () => {
    await openChangesWith([
      {
        path: "spec/checkout_spec.rb",
        status: "M" as const,
        insertions: 1,
        deletions: 0,
        staged: false,
      },
    ]);
    const labels = [...document.querySelectorAll(".file-group")].map((el) => el.textContent);
    expect(labels).toEqual([MESSAGES.testsGroupLabel(PRIMARY_LANGUAGE)]);
  });

  it("selects the first file by default and marks the row selected", async () => {
    const { selectedPath } = await import("./changes.js");
    await openChangesWith(FILES);
    expect(selectedPath()).toBe("CheckoutService.php");
    expect(document.querySelector(".file-row")?.className).toContain("file-row--on");
  });

  it("selects the file the caller asked for", async () => {
    const { selectedPath } = await import("./changes.js");
    await openChangesWith(FILES, "RetryPolicy.php");
    expect(selectedPath()).toBe("RetryPolicy.php");
  });

  it("changes the selection when a row is clicked", async () => {
    const { selectedPath } = await import("./changes.js");
    await openChangesWith(FILES);
    const rows = [...document.querySelectorAll(".file-row")];
    if (!(rows[2] instanceof HTMLElement)) throw new Error("missing row");
    rows[2].click();
    expect(selectedPath()).toBe("LegacyRetry.php");
  });

  it("toggles staging through the bridge without changing the selection", async () => {
    const { selectedPath } = await import("./changes.js");
    const jarvis = await openChangesWith(FILES);
    const toggle = document.querySelector(".file-stage");
    if (!(toggle instanceof HTMLElement)) throw new Error("missing stage toggle");

    toggle.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(jarvis.gitSetStaged).toHaveBeenCalledWith("s1", "CheckoutService.php", false);
    expect(selectedPath()).toBe("CheckoutService.php");
  });

  it("shows the failure banner, without crashing, when staging a file deleted from disk", async () => {
    const jarvis = await openChangesWith(FILES, undefined, {
      gitSetStaged: vi.fn(async () => ({
        ok: false as const,
        text: "الملف لم يعد موجودًا على القرص.",
        language: "ar" as const,
      })),
    });
    const toggle = document.querySelector(".file-stage");
    if (!(toggle instanceof HTMLElement)) throw new Error("missing stage toggle");

    toggle.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(jarvis.gitSetStaged).toHaveBeenCalledWith("s1", "CheckoutService.php", false);
    const banner = document.getElementById("changes-error");
    expect(banner?.hidden).toBe(false);
    expect(banner?.textContent).toBe("الملف لم يعد موجودًا على القرص.");
  });

  it("does not corrupt the displayed state when the stage toggle is double-clicked before the first call resolves", async () => {
    let resolveFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let calls = 0;
    const jarvis = await openChangesWith(FILES, undefined, {
      gitSetStaged: vi.fn(async () => {
        calls += 1;
        if (calls === 1) await first;
        return { ok: true as const, value: null };
      }),
    });
    const toggle = document.querySelector(".file-stage");
    if (!(toggle instanceof HTMLElement)) throw new Error("missing stage toggle");

    toggle.click();
    toggle.click();
    resolveFirst?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(jarvis.gitSetStaged).toHaveBeenCalledTimes(2);
    // The row for CheckoutService.php still exists exactly once and the
    // panel is in a coherent state (not duplicated, not blank).
    const names = [...document.querySelectorAll(".file-name")].map((el) => el.textContent);
    expect(names.filter((name) => name === "CheckoutService.php")).toHaveLength(1);
  });

  it("renders an Arabic file path right-to-left while keeping its counts LTR", async () => {
    await openChangesWith([
      { path: "خدمات/الدفع.php", status: "M" as const, insertions: 3, deletions: 1, staged: false },
    ]);
    const row = document.querySelector(".file-row");
    expect(row?.querySelector(".file-name")?.getAttribute("dir")).toBe("rtl");
    expect(row?.querySelector(".diff-add")?.getAttribute("dir")).toBe("ltr");
  });

  it("never interprets a path as markup", async () => {
    await openChangesWith([
      {
        path: '<img src=x onerror="globalThis.pwned = true">.php',
        status: "A" as const,
        insertions: 1,
        deletions: 0,
        staged: false,
      },
    ]);
    expect(document.querySelector(".file-name img")).toBeNull();
    expect("pwned" in globalThis).toBe(false);
    expect(document.querySelector(".file-name")?.textContent).toBe(
      '<img src=x onerror="globalThis.pwned = true">.php',
    );
  });

  it("renders a very long path in full, unclipped", async () => {
    const longPath = `deep/${"nested/".repeat(20)}CheckoutServiceWithAVeryLongClassNameIndeed.php`;
    await openChangesWith([
      { path: longPath, status: "M" as const, insertions: 1, deletions: 1, staged: false },
    ]);
    expect(document.querySelector(".file-name")?.textContent).toBe(longPath);
  });

  it("renders a path with no directory component", async () => {
    await openChangesWith([
      { path: "README.md", status: "M" as const, insertions: 2, deletions: 0, staged: false },
    ]);
    expect(document.querySelector(".file-name")?.textContent).toBe("README.md");
    expect(document.querySelectorAll(".file-row")).toHaveLength(1);
  });
});

const HUNK = {
  header: "@@ -41,9 +41,9 @@",
  lines: [
    { kind: "context" as const, text: "public function charge()", beforeLine: 41, afterLine: 41 },
    {
      kind: "removed" as const,
      text: "  $res = $this->pay();",
      beforeLine: 42,
      afterLine: undefined,
    },
    {
      kind: "added" as const,
      text: "  $res = $policy->run();",
      beforeLine: undefined,
      afterLine: 42,
    },
  ],
};

describe("the diff panes", () => {
  it("renders BEFORE and AFTER columns with line numbers from the hunk", async () => {
    await openChangesWithDiff({ path: "a.php", binary: false, hunks: [HUNK] });

    const before = [...document.querySelectorAll(".pane--before .ln")];
    const after = [...document.querySelectorAll(".pane--after .ln")];
    expect(before).toHaveLength(2);
    expect(after).toHaveLength(2);
    expect(before[0]?.querySelector(".num")?.textContent).toBe("41");
    expect(before[1]?.querySelector(".code")?.textContent).toBe("  $res = $this->pay();");
    expect(after[1]?.querySelector(".code")?.textContent).toBe("  $res = $policy->run();");
  });

  it("marks removed and added rows with their own classes", async () => {
    await openChangesWithDiff({ path: "a.php", binary: false, hunks: [HUNK] });
    expect(document.querySelector(".pane--before .ln--del")).not.toBeNull();
    expect(document.querySelector(".pane--after .ln--add")).not.toBeNull();
  });

  it("switches to a single unified column when Unified is clicked", async () => {
    await openChangesWithDiff({ path: "a.php", binary: false, hunks: [HUNK] });
    const unified = document.getElementById("diff-mode-unified");
    if (!(unified instanceof HTMLElement)) throw new Error("missing toggle");
    unified.click();
    await Promise.resolve();

    expect(document.querySelector(".pane--before")).toBeNull();
    expect([...document.querySelectorAll(".diff-unified .ln")]).toHaveLength(3);
    expect(unified.className).toContain("diff-mode--on");
  });

  it("switches back to side-by-side when Side by side is clicked again", async () => {
    await openChangesWithDiff({ path: "a.php", binary: false, hunks: [HUNK] });
    const side = document.getElementById("diff-mode-side");
    const unified = document.getElementById("diff-mode-unified");
    if (!(side instanceof HTMLElement) || !(unified instanceof HTMLElement)) {
      throw new Error("missing toggle");
    }
    unified.click();
    await Promise.resolve();
    side.click();
    await Promise.resolve();

    expect(document.querySelector(".pane--before")).not.toBeNull();
    expect(document.querySelector(".diff-unified")).toBeNull();
    expect(side.className).toContain("diff-mode--on");
    expect(unified.className).not.toContain("diff-mode--on");
  });

  it("shows the hunk header between hunks", async () => {
    await openChangesWithDiff({
      path: "a.php",
      binary: false,
      hunks: [HUNK, { header: "@@ -90,2 +90,3 @@", lines: HUNK.lines }],
    });
    const headers = [...document.querySelectorAll(".hunk-head")].map((el) => el.textContent);
    expect(headers).toEqual(["@@ -41,9 +41,9 @@", "@@ -90,2 +90,3 @@"]);
  });

  // These three notices are renderer-generated (never echoed from a main-
  // process failure), so — like ruling P22's changesShowCurrentState —
  // they follow PRIMARY_LANGUAGE, whatever it is set to.
  it("says so plainly for a binary file instead of rendering nothing", async () => {
    await openChangesWithDiff({ path: "logo.png", binary: true, hunks: [] });
    expect(document.getElementById("diff-body")?.textContent).toContain(
      MESSAGES.diffBinaryFile(PRIMARY_LANGUAGE),
    );
  });

  // Ruling P8: `tooLarge` means the content was never read at all, which is
  // a different fact from `binary` — a consumer that conflates the two
  // would tell the user their text file is binary, which is simply false.
  it("says the file is too large, distinctly from binary, when tooLarge is set", async () => {
    await openChangesWithDiff({ path: "generated.sql", binary: false, tooLarge: true, hunks: [] });
    const text = document.getElementById("diff-body")?.textContent ?? "";
    expect(text).toContain(MESSAGES.diffTooLarge(PRIMARY_LANGUAGE));
    expect(text).not.toContain(MESSAGES.diffBinaryFile(PRIMARY_LANGUAGE));
  });

  it("says there are no changes for a file with an empty diff", async () => {
    await openChangesWithDiff({ path: "a.php", binary: false, hunks: [] });
    expect(document.getElementById("diff-body")?.textContent).toContain(
      MESSAGES.diffNoChanges(PRIMARY_LANGUAGE),
    );
  });

  it("renders diff content as text, never as markup", async () => {
    await openChangesWithDiff({
      path: "a.php",
      binary: false,
      hunks: [
        {
          header: "@@ -1,1 +1,1 @@",
          lines: [
            {
              kind: "added" as const,
              text: '<img src=x onerror="globalThis.diffPwned = true">',
              beforeLine: undefined,
              afterLine: 1,
            },
          ],
        },
      ],
    });

    expect(document.querySelector(".diff-body img")).toBeNull();
    expect("diffPwned" in globalThis).toBe(false);
    expect(document.querySelector(".pane--after .code")?.textContent).toContain("onerror");
  });

  it("keeps the code panes left-to-right even for Arabic content", async () => {
    await openChangesWithDiff({
      path: "a.php",
      binary: false,
      hunks: [
        {
          header: "@@ -1,1 +1,1 @@",
          lines: [
            { kind: "added" as const, text: "// تعليق عربي", beforeLine: undefined, afterLine: 1 },
          ],
        },
      ],
    });
    expect(document.querySelector(".pane--after .code")?.getAttribute("dir")).toBe("ltr");
  });

  it("renders a 50,000-character line without throwing", async () => {
    const longLine = "x".repeat(50_000);
    await openChangesWithDiff({
      path: "generated.js",
      binary: false,
      hunks: [
        {
          header: "@@ -1,1 +1,1 @@",
          lines: [{ kind: "added" as const, text: longLine, beforeLine: undefined, afterLine: 1 }],
        },
      ],
    });
    expect(document.querySelector(".pane--after .code")?.textContent).toHaveLength(50_000);
  });

  it("tolerates a hunk header whose counts disagree with the lines that follow", async () => {
    await openChangesWithDiff({
      path: "a.php",
      binary: false,
      hunks: [
        {
          // Header claims 1 line changed on each side; five actually follow.
          header: "@@ -1,1 +1,1 @@",
          lines: [
            { kind: "context" as const, text: "a", beforeLine: 1, afterLine: 1 },
            { kind: "removed" as const, text: "b", beforeLine: 2, afterLine: undefined },
            { kind: "removed" as const, text: "c", beforeLine: 3, afterLine: undefined },
            { kind: "added" as const, text: "d", beforeLine: undefined, afterLine: 2 },
            { kind: "context" as const, text: "e", beforeLine: 4, afterLine: 3 },
          ],
        },
      ],
    });
    expect([...document.querySelectorAll(".pane--after .ln")]).toHaveLength(4);
  });

  it("shows the added lines with nothing on the before side for a wholly-added file", async () => {
    await openChangesWithDiff({
      path: "new.php",
      binary: false,
      hunks: [
        {
          header: "@@ -0,0 +1,2 @@",
          lines: [
            { kind: "added" as const, text: "line one", beforeLine: undefined, afterLine: 1 },
            { kind: "added" as const, text: "line two", beforeLine: undefined, afterLine: 2 },
          ],
        },
      ],
    });
    const before = [...document.querySelectorAll(".pane--before .ln")];
    const after = [...document.querySelectorAll(".pane--after .ln")];
    expect(after).toHaveLength(2);
    expect(before).toHaveLength(2);
    expect(before.every((row) => row.querySelector(".code")?.textContent === "")).toBe(true);
  });

  it("shows the removed lines with nothing on the after side for a wholly-deleted file", async () => {
    await openChangesWithDiff({
      path: "gone.php",
      binary: false,
      hunks: [
        {
          header: "@@ -1,2 +0,0 @@",
          lines: [
            { kind: "removed" as const, text: "line one", beforeLine: 1, afterLine: undefined },
            { kind: "removed" as const, text: "line two", beforeLine: 2, afterLine: undefined },
          ],
        },
      ],
    });
    const before = [...document.querySelectorAll(".pane--before .ln")];
    const after = [...document.querySelectorAll(".pane--after .ln")];
    expect(before).toHaveLength(2);
    expect(after).toHaveLength(2);
    expect(after.every((row) => row.querySelector(".code")?.textContent === "")).toBe(true);
  });

  it("re-renders the diff for the newly selected file when the selection changes while Unified is active", async () => {
    const files = [
      { path: "a.php", status: "M" as const, insertions: 1, deletions: 1, staged: false },
      { path: "b.php", status: "M" as const, insertions: 1, deletions: 1, staged: false },
    ];
    const diffs: Record<string, GitFileDiff> = {
      "a.php": { path: "a.php", binary: false, hunks: [HUNK] },
      "b.php": {
        path: "b.php",
        binary: false,
        hunks: [
          {
            header: "@@ -1,1 +1,1 @@",
            lines: [
              { kind: "added" as const, text: "b file line", beforeLine: undefined, afterLine: 1 },
            ],
          },
        ],
      },
    };
    await openChangesWith(files, undefined, {
      gitDiff: vi.fn(async (_id: string, path: string) => {
        const diff = diffs[path];
        if (diff === undefined) throw new Error(`no stub diff for ${path}`);
        return { ok: true as const, value: diff };
      }),
    });

    const unified = document.getElementById("diff-mode-unified");
    if (!(unified instanceof HTMLElement)) throw new Error("missing toggle");
    unified.click();
    await Promise.resolve();
    expect([...document.querySelectorAll(".diff-unified .ln")]).toHaveLength(3);

    const rows = [...document.querySelectorAll(".file-row")];
    const second = rows[1];
    if (!(second instanceof HTMLElement)) throw new Error("missing second row");
    second.click();
    await Promise.resolve();
    await Promise.resolve();

    const unifiedLines = [...document.querySelectorAll(".diff-unified .ln")];
    expect(unifiedLines).toHaveLength(1);
    expect(unifiedLines[0]?.querySelector(".code")?.textContent).toBe("b file line");
  });

  it("shows a git failure for the file without clearing the file list", async () => {
    await openChangesWithDiffFailure({ text: "The git command failed: boom", language: "en" });
    expect(document.getElementById("changes-error")?.hidden).toBe(false);
    expect(document.querySelectorAll(".file-row").length).toBeGreaterThan(0);
  });

  // A previous file's failed gitDiff() call leaves the banner showing; a
  // later file's successful diff must not leave it standing underneath a
  // now-correct pane, accusing the repository of a failure that isn't
  // happening any more.
  it("clears a standing error banner once a later diff succeeds", async () => {
    let first = true;
    await openChangesWith(
      [
        { path: "a.php", status: "M" as const, insertions: 1, deletions: 1, staged: false },
        { path: "b.php", status: "M" as const, insertions: 1, deletions: 1, staged: false },
      ],
      undefined,
      {
        gitDiff: vi.fn(async (_id: string, path: string) => {
          if (first) {
            first = false;
            return {
              ok: false as const,
              text: "The git command failed: boom",
              language: "en" as const,
            };
          }
          return { ok: true as const, value: { path, binary: false, hunks: [] } };
        }),
      },
    );
    expect(document.getElementById("changes-error")?.hidden).toBe(false);

    const rows = [...document.querySelectorAll(".file-row")];
    const second = rows[1];
    if (!(second instanceof HTMLElement)) throw new Error("missing second row");
    second.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById("changes-error")?.hidden).toBe(true);
  });

  // Two clicks in quick succession — A then B — whose gitDiff() responses
  // land out of order (B first, A second) must not leave A's diff showing
  // under B's highlighted file row. The staging toggle above already
  // defends against this shape of race by re-rendering from a fresh read;
  // here the defense is capturing the requested path before the await and
  // discarding a response that arrives after the selection has moved on.
  // Verified against the pre-fix code (renderDiff with no guard): this
  // test fails there, resolving B first and A second still leaves A's
  // "a file line" in the pane instead of B's "b file line".
  it("keeps the diff pane in sync when two diff responses resolve out of order", async () => {
    const files = [
      { path: "a.php", status: "M" as const, insertions: 1, deletions: 1, staged: false },
      { path: "b.php", status: "M" as const, insertions: 1, deletions: 1, staged: false },
    ];
    const diffs: Record<string, GitFileDiff> = {
      "a.php": {
        path: "a.php",
        binary: false,
        hunks: [
          {
            header: "@@ -1,1 +1,1 @@",
            lines: [
              { kind: "added" as const, text: "a file line", beforeLine: undefined, afterLine: 1 },
            ],
          },
        ],
      },
      "b.php": {
        path: "b.php",
        binary: false,
        hunks: [
          {
            header: "@@ -1,1 +1,1 @@",
            lines: [
              { kind: "added" as const, text: "b file line", beforeLine: undefined, afterLine: 1 },
            ],
          },
        ],
      },
    };

    let calls = 0;
    const pending: Record<number, () => void> = {};
    await openChangesWith(files, undefined, {
      gitDiff: vi.fn((_id: string, path: string): Promise<GitViewResult<GitFileDiff>> => {
        const index = calls++;
        const diff = diffs[path];
        if (diff === undefined) throw new Error(`no stub diff for ${path}`);
        // Call 0 is openChangesWith's own initial selection of a.php —
        // resolved immediately so setup itself doesn't hang. Later calls
        // (the two rapid clicks below) stay pending until resolved by hand,
        // in whichever order the test chooses.
        if (index === 0) {
          return Promise.resolve({ ok: true as const, value: diff });
        }
        return new Promise((resolve) => {
          pending[index] = () => resolve({ ok: true as const, value: diff });
        });
      }),
    });

    const rows = [...document.querySelectorAll(".file-row")];
    const rowA = rows[0];
    const rowB = rows[1];
    if (!(rowA instanceof HTMLElement) || !(rowB instanceof HTMLElement)) {
      throw new Error("missing file rows");
    }

    // Click A, then B, before either response has arrived.
    rowA.click();
    rowB.click();

    // Resolve out of order: B (the later click, call index 2) first, A
    // (call index 1) second.
    pending[2]?.();
    await Promise.resolve();
    await Promise.resolve();
    pending[1]?.();
    await Promise.resolve();
    await Promise.resolve();

    // Each click re-renders the whole file list (fresh nodes), so the
    // final highlighted row must be re-queried rather than read off the
    // `rowA`/`rowB` references captured before either click.
    const finalRows = [...document.querySelectorAll(".file-row")];
    const finalA = finalRows.find(
      (row) => row.querySelector(".file-name")?.textContent === "a.php",
    );
    const finalB = finalRows.find(
      (row) => row.querySelector(".file-name")?.textContent === "b.php",
    );

    expect(document.querySelector(".pane--after .code")?.textContent).toBe("b file line");
    expect(document.getElementById("diff-filename")?.textContent).toBe("b.php");
    expect(finalB?.className).toContain("file-row--on");
    expect(finalA?.className).not.toContain("file-row--on");
  });
});

describe("the commit bar", () => {
  it("counts only the staged files in the button label", async () => {
    await openChangesWith([
      { path: "a.php", status: "M" as const, insertions: 1, deletions: 0, staged: true },
      { path: "b.php", status: "M" as const, insertions: 1, deletions: 0, staged: true },
      { path: "c.php", status: "M" as const, insertions: 1, deletions: 0, staged: false },
    ]);
    expect(document.getElementById("commit-button")?.textContent).toBe(
      MESSAGES.commitButtonLabel(2, PRIMARY_LANGUAGE),
    );
  });

  it("uses the singular for one staged file", async () => {
    await openChangesWith([
      { path: "a.php", status: "M" as const, insertions: 1, deletions: 0, staged: true },
    ]);
    expect(document.getElementById("commit-button")?.textContent).toBe(
      MESSAGES.commitButtonLabel(1, PRIMARY_LANGUAGE),
    );
  });

  it("is disabled with nothing staged", async () => {
    await openChangesWith([
      { path: "a.php", status: "M" as const, insertions: 1, deletions: 0, staged: false },
    ]);
    const button = document.getElementById("commit-button");
    if (!(button instanceof HTMLButtonElement)) throw new Error("missing button");
    expect(button.disabled).toBe(true);
  });

  it("is disabled while the message is empty and enabled once it is typed", async () => {
    await openChangesWith([
      { path: "a.php", status: "M" as const, insertions: 1, deletions: 0, staged: true },
    ]);
    const input = document.getElementById("commit-message");
    const button = document.getElementById("commit-button");
    if (!(input instanceof HTMLInputElement)) throw new Error("missing input");
    if (!(button instanceof HTMLButtonElement)) throw new Error("missing button");

    expect(button.disabled).toBe(true);
    input.value = "  ";
    input.dispatchEvent(new Event("input"));
    expect(button.disabled).toBe(true);

    input.value = "إصلاح الدفع";
    input.dispatchEvent(new Event("input"));
    expect(button.disabled).toBe(false);
  });

  it("updates the button label as soon as a file is staged or unstaged", async () => {
    const jarvis = await openChangesWith(
      [{ path: "a.php", status: "M" as const, insertions: 1, deletions: 0, staged: false }],
      undefined,
      {
        gitSetStaged: vi.fn(async () => ({ ok: true as const, value: null })),
      },
    );
    expect(document.getElementById("commit-button")?.textContent).toBe(
      MESSAGES.commitButtonLabel(0, PRIMARY_LANGUAGE),
    );

    // gitChanges() is re-read after the toggle resolves; simulate the file
    // now being staged, the same way openChanges's real refetch would.
    jarvis.gitChanges = vi.fn(async () => ({
      ok: true as const,
      value: {
        session: {
          id: "s1",
          project: "acme",
          projectPath: "~/projects/acme",
          agentId: "claude-acme",
          lastActivityAt: Date.now(),
          endedAt: undefined,
        },
        changes: {
          repoPath: "~/projects/acme",
          branch: "feat/checkout-retry",
          detached: false,
          files: [
            { path: "a.php", status: "M" as const, insertions: 1, deletions: 0, staged: true },
          ],
          insertions: 1,
          deletions: 0,
        },
      },
    }));

    const stageButton = document.querySelector(".file-stage");
    if (!(stageButton instanceof HTMLElement)) throw new Error("missing stage toggle");
    stageButton.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById("commit-button")?.textContent).toBe(
      MESSAGES.commitButtonLabel(1, PRIMARY_LANGUAGE),
    );
  });

  it("commits the typed message and clears the field on success", async () => {
    const jarvis = await openChangesWith([
      { path: "a.php", status: "M" as const, insertions: 1, deletions: 0, staged: true },
    ]);
    const input = document.getElementById("commit-message");
    const button = document.getElementById("commit-button");
    if (!(input instanceof HTMLInputElement)) throw new Error("missing input");
    if (!(button instanceof HTMLElement)) throw new Error("missing button");

    input.value = "إصلاح الدفع";
    input.dispatchEvent(new Event("input"));
    button.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(jarvis.gitCommit).toHaveBeenCalledWith("s1", "إصلاح الدفع");
    expect(input.value).toBe("");
  });

  it("re-reads the repository after a successful commit so a now-committed file drops off the list", async () => {
    const emptyView = {
      ok: true as const,
      value: {
        session: {
          id: "s1",
          project: "acme",
          projectPath: "~/projects/acme",
          agentId: "claude-acme",
          lastActivityAt: Date.now(),
          endedAt: undefined,
        },
        changes: {
          repoPath: "~/projects/acme",
          branch: "feat/checkout-retry",
          detached: false,
          files: [],
          insertions: 0,
          deletions: 0,
        },
      },
    };
    let call = 0;
    const gitChanges = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: true as const,
          value: {
            session: emptyView.value.session,
            changes: {
              ...emptyView.value.changes,
              files: [
                { path: "a.php", status: "M" as const, insertions: 1, deletions: 0, staged: true },
              ],
              insertions: 1,
            },
          },
        };
      }
      return emptyView;
    });
    const jarvis = await openChangesWith(
      [{ path: "a.php", status: "M" as const, insertions: 1, deletions: 0, staged: true }],
      undefined,
      { gitChanges, gitCommit: vi.fn(async () => ({ ok: true as const, value: null })) },
    );
    const input = document.getElementById("commit-message");
    const button = document.getElementById("commit-button");
    if (!(input instanceof HTMLInputElement)) throw new Error("missing input");
    if (!(button instanceof HTMLElement)) throw new Error("missing button");

    input.value = "إصلاح الدفع";
    input.dispatchEvent(new Event("input"));
    button.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // openChanges() was called a second time (once at open, once after the
    // commit resolves) to redraw the file list, counts and commit button
    // from whatever the repository actually looks like now.
    expect(jarvis.gitChanges).toHaveBeenCalledTimes(2);
    expect(document.getElementById("commit-button")?.textContent).toBe(
      MESSAGES.commitButtonLabel(0, PRIMARY_LANGUAGE),
    );
  });

  it("shows a commit failure and keeps the message so it is not lost", async () => {
    const jarvis = await openChangesWith(
      [{ path: "a.php", status: "M" as const, insertions: 1, deletions: 0, staged: true }],
      undefined,
      {
        gitCommit: vi.fn(async () => ({
          ok: false as const,
          text: "لا توجد تغييرات مجهّزة للحفظ.",
          language: "ar" as const,
        })),
      },
    );
    const input = document.getElementById("commit-message");
    const button = document.getElementById("commit-button");
    if (!(input instanceof HTMLInputElement)) throw new Error("missing input");
    if (!(button instanceof HTMLElement)) throw new Error("missing button");

    input.value = "محاولة";
    input.dispatchEvent(new Event("input"));
    button.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById("changes-error")?.textContent).toBe(
      "لا توجد تغييرات مجهّزة للحفظ.",
    );
    expect(input.value).toBe("محاولة");
    expect(jarvis.gitCommit).toHaveBeenCalled();
  });

  it("surfaces an empty-message refusal from the provider and leaves the assistant usable", async () => {
    const jarvis = await openChangesWith(
      [{ path: "a.php", status: "M" as const, insertions: 1, deletions: 0, staged: true }],
      undefined,
      {
        gitCommit: vi.fn(async () => ({
          ok: false as const,
          text: "اكتب رسالة للحفظ أولًا.",
          language: "ar" as const,
        })),
      },
    );
    const input = document.getElementById("commit-message");
    const button = document.getElementById("commit-button");
    if (!(input instanceof HTMLInputElement)) throw new Error("missing input");
    if (!(button instanceof HTMLButtonElement)) throw new Error("missing button");

    input.value = "x";
    input.dispatchEvent(new Event("input"));
    button.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById("changes-error")?.textContent).toBe("اكتب رسالة للحفظ أولًا.");
    // The assistant stays usable: the button is not stuck disabled forever.
    expect(button.disabled).toBe(false);
    expect(jarvis.gitCommit).toHaveBeenCalled();
  });

  it("keeps the message field's direction following what was typed, not the app chrome", async () => {
    await openChangesWith([
      { path: "a.php", status: "M" as const, insertions: 1, deletions: 0, staged: true },
    ]);
    const input = document.getElementById("commit-message");
    if (!(input instanceof HTMLInputElement)) throw new Error("missing input");
    expect(input.getAttribute("dir")).toBe("auto");

    input.value = "إصلاح الدفع";
    input.dispatchEvent(new Event("input"));
    // The message survives intact — no reordering, no stripped characters.
    expect(input.value).toBe("إصلاح الدفع");
  });

  it("does not double-commit on a second click before the first resolves", async () => {
    let resolveCommit: ((result: { ok: true; value: null }) => void) | undefined;
    const commitPromise = new Promise<{ ok: true; value: null }>((resolve) => {
      resolveCommit = resolve;
    });
    const jarvis = await openChangesWith(
      [{ path: "a.php", status: "M" as const, insertions: 1, deletions: 0, staged: true }],
      undefined,
      { gitCommit: vi.fn(() => commitPromise) },
    );
    const input = document.getElementById("commit-message");
    const button = document.getElementById("commit-button");
    if (!(input instanceof HTMLInputElement)) throw new Error("missing input");
    if (!(button instanceof HTMLElement)) throw new Error("missing button");

    input.value = "إصلاح الدفع";
    input.dispatchEvent(new Event("input"));
    button.click();
    button.click();
    button.click();

    if (resolveCommit === undefined) throw new Error("commit never called");
    resolveCommit({ ok: true, value: null });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(jarvis.gitCommit).toHaveBeenCalledTimes(1);
  });

  // Task 15 review: a stage/unstage toggle in flight must also block
  // Commit, not just an in-flight commit itself — otherwise a commit fired
  // while gitSetStaged() is still outstanding can include or exclude a
  // file the button's label never described.
  it("disables Commit while a stage toggle is outstanding, and re-enables it once the toggle settles", async () => {
    let resolveStage: ((result: { ok: true; value: null }) => void) | undefined;
    const stagePromise = new Promise<{ ok: true; value: null }>((resolve) => {
      resolveStage = resolve;
    });
    const jarvis = await openChangesWith(
      [{ path: "a.php", status: "M" as const, insertions: 1, deletions: 0, staged: true }],
      undefined,
      { gitSetStaged: vi.fn(() => stagePromise) },
    );
    const input = document.getElementById("commit-message");
    if (!(input instanceof HTMLInputElement)) throw new Error("missing input");
    input.value = "إصلاح الدفع";
    input.dispatchEvent(new Event("input"));

    const stageButton = document.querySelector(".file-stage");
    if (!(stageButton instanceof HTMLElement)) throw new Error("missing stage toggle");
    stageButton.click();
    await Promise.resolve();

    const button = document.getElementById("commit-button");
    if (!(button instanceof HTMLButtonElement)) throw new Error("missing button");
    expect(button.disabled).toBe(true);

    button.click();
    await Promise.resolve();
    expect(jarvis.gitCommit).not.toHaveBeenCalled();

    if (resolveStage === undefined) throw new Error("stage toggle never called");
    resolveStage({ ok: true, value: null });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const settledButton = document.getElementById("commit-button");
    if (!(settledButton instanceof HTMLButtonElement)) throw new Error("missing button");
    expect(settledButton.disabled).toBe(false);

    settledButton.click();
    await Promise.resolve();
    expect(jarvis.gitCommit).toHaveBeenCalledTimes(1);
  });
});
