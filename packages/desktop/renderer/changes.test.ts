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
    send: vi.fn(async () => {}),
    startVoice: vi.fn(async () => {}),
    stopVoice: vi.fn(async () => {}),
    onMetrics: vi.fn(),
    onSessions: vi.fn(),
    onTurn: vi.fn(),
    onListening: vi.fn(),
    onNotice: vi.fn(),
    getHistory: vi.fn(async () => []),
    gitChanges: vi.fn(async () => notStubbed),
    gitDiff: vi.fn(async () => notStubbed),
    gitSetStaged: vi.fn(async () => notStubbed),
    gitCommit: vi.fn(async () => notStubbed),
    onChangeCounts: vi.fn(),
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
  const { openChanges } = await import("./changes.js");
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

// Referenced only to keep the two diff-oriented helpers above from being
// flagged as unused ahead of Task 14, which is the first task that calls
// them for real.
void openChangesWithDiff;
void openChangesWithDiffFailure;

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = `
    <div class="main"></div>
    <div class="main main--changes" id="view-changes" hidden>
      <div class="changes-head">
        <div class="changes-title">Changes</div>
        <div id="changes-project" class="chip mono"></div>
        <div id="changes-path" class="mono changes-muted"></div>
        <div class="mono changes-muted">on</div>
        <div id="changes-branch" class="mono changes-dim"></div>
        <div id="changes-add" class="mono diff-add" dir="ltr"></div>
        <div id="changes-del" class="mono diff-del" dir="ltr"></div>
        <div id="changes-by" class="mono changes-muted"></div>
      </div>
      <div id="changes-stale-notice" class="changes-notice" hidden></div>
      <div id="changes-error" class="changes-error" hidden></div>
      <div class="changes-files-head">
        <div id="changes-count" class="mono changes-count"></div>
      </div>
      <div id="changes-file-list" class="changes-file-list"></div>
    </div>
    <button id="nav-dashboard" class="nav-btn nav-btn--on" type="button"></button>
    <button id="nav-changes" class="nav-btn" type="button"></button>
  `;
});

describe("openChanges", () => {
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
            lastActivityAt: Date.now() - 6 * 60_000,
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
      "written by claude-acme · 6m ago",
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
            agentId: "claude-mm",
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
    // The app's primary language is Arabic (PRIMARY_LANGUAGE): the notice
    // is renderer-generated, not echoed from a main-process failure, so it
    // follows PRIMARY_LANGUAGE the same way app.ts's history-count badge
    // does, not English.
    expect(notice?.dir).toBe("rtl");
    expect(notice?.textContent).toContain("انتهت هذه الجلسة");
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

describe("showView", () => {
  it("swaps which view is hidden and which nav button is lit", async () => {
    const { showView } = await import("./changes.js");

    showView("changes");
    expect(document.getElementById("view-changes")?.hidden).toBe(false);
    expect(document.getElementById("nav-changes")?.className).toContain("nav-btn--on");

    showView("dashboard");
    expect(document.getElementById("view-changes")?.hidden).toBe(true);
    expect(document.getElementById("nav-dashboard")?.className).toContain("nav-btn--on");
  });
});

const FILES = [
  { path: "CheckoutService.php", status: "M" as const, insertions: 42, deletions: 9, staged: true },
  { path: "RetryPolicy.php", status: "A" as const, insertions: 61, deletions: 0, staged: false },
  { path: "LegacyRetry.php", status: "D" as const, insertions: 0, deletions: 16, staged: false },
  { path: "tests/RetryPolicyTest.php", status: "A" as const, insertions: 8, deletions: 0, staged: false },
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
    expect(labels).toEqual(["TESTS"]);
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
      { path: "spec/checkout_spec.rb", status: "M" as const, insertions: 1, deletions: 0, staged: false },
    ]);
    const labels = [...document.querySelectorAll(".file-group")].map((el) => el.textContent);
    expect(labels).toEqual(["TESTS"]);
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
