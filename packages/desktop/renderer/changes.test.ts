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
  const { openChanges, wireDiffModes } = await import("./changes.js");
  // wireDiffModes is normally called once from app.ts; this harness has no
  // app.ts, so each test's own module instance (vi.resetModules() in
  // beforeEach) wires its own Side-by-side/Unified toggle here instead.
  wireDiffModes();
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
      <div class="changes-diff">
        <div class="diff-head">
          <div id="diff-filename" class="mono changes-dim"></div>
          <div class="diff-toggle">
            <button id="diff-mode-side" class="diff-mode diff-mode--on" type="button">Side by side</button>
            <button id="diff-mode-unified" class="diff-mode" type="button">Unified</button>
          </div>
        </div>
        <div id="diff-body" class="diff-body"></div>
      </div>
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

const HUNK = {
  header: "@@ -41,9 +41,9 @@",
  lines: [
    { kind: "context" as const, text: "public function charge()", beforeLine: 41, afterLine: 41 },
    { kind: "removed" as const, text: "  $res = $this->pay();", beforeLine: 42, afterLine: undefined },
    { kind: "added" as const, text: "  $res = $policy->run();", beforeLine: undefined, afterLine: 42 },
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
  // they follow PRIMARY_LANGUAGE (Arabic), not English.
  it("says so plainly for a binary file instead of rendering nothing", async () => {
    await openChangesWithDiff({ path: "logo.png", binary: true, hunks: [] });
    expect(document.getElementById("diff-body")?.textContent).toContain("ملف ثنائي");
  });

  // Ruling P8: `tooLarge` means the content was never read at all, which is
  // a different fact from `binary` — a consumer that conflates the two
  // would tell the user their text file is binary, which is simply false.
  it("says the file is too large, distinctly from binary, when tooLarge is set", async () => {
    await openChangesWithDiff({ path: "generated.sql", binary: false, tooLarge: true, hunks: [] });
    const text = document.getElementById("diff-body")?.textContent ?? "";
    expect(text).toContain("كبير جدًا");
    expect(text).not.toContain("ملف ثنائي");
  });

  it("says there are no changes for a file with an empty diff", async () => {
    await openChangesWithDiff({ path: "a.php", binary: false, hunks: [] });
    expect(document.getElementById("diff-body")?.textContent).toContain("لا توجد تغييرات");
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
          lines: [
            { kind: "added" as const, text: longLine, beforeLine: undefined, afterLine: 1 },
          ],
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
            lines: [{ kind: "added" as const, text: "b file line", beforeLine: undefined, afterLine: 1 }],
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
});
