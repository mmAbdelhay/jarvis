// @vitest-environment jsdom
//
// Follows the harness pattern in app.test.ts: lay down the minimal DOM
// changes.ts's `$(id)` lookups touch, stub `window.jarvis`, then import the
// module fresh. Unlike app.ts, changes.ts does no work at module-import
// time (no top-level `$()` calls) — every lookup happens inside
// openChanges/showView, so there is no "wire the minimal DOM or the module
// throws on import" step here.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitViewResult } from "../src/ipc.js";
import type { ChangesView } from "../src/ipc.js";

function stubJarvis(overrides: { gitChanges: (sessionId: string) => Promise<GitViewResult<ChangesView>> }): {
  gitChanges: ReturnType<typeof vi.fn>;
} {
  const gitChanges = vi.fn(overrides.gitChanges);
  (window as unknown as { jarvis: Record<string, unknown> }).jarvis = { gitChanges };
  return { gitChanges };
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
      <div id="changes-error" class="changes-error" hidden></div>
    </div>
    <button id="nav-dashboard" class="nav-btn nav-btn--on" type="button"></button>
    <button id="nav-changes" class="nav-btn" type="button"></button>
  `;
});

describe("openChanges", () => {
  it("names the session, project path, branch and totals in the header", async () => {
    const jarvis = stubJarvis({
      gitChanges: async () => ({
        ok: true,
        value: {
          session: {
            id: "s1",
            project: "acme",
            projectPath: "~/projects/acme",
            agentId: "claude-acme",
            lastActivityAt: Date.now() - 6 * 60_000,
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
      }),
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
      gitChanges: async () => ({
        ok: false,
        text: "هذا المجلد ليس مستودع git.",
        language: "ar",
      }),
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
      gitChanges: async () => ({
        ok: true,
        value: {
          session: {
            id: "s1",
            project: "متجر",
            projectPath: "~/مشاريع/متجر",
            agentId: "claude-mm",
            lastActivityAt: Date.now(),
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
      }),
    });

    const { openChanges } = await import("./changes.js");
    await openChanges("s1");

    expect(document.getElementById("changes-project")?.dir).toBe("rtl");
    expect(document.getElementById("changes-branch")?.dir).toBe("rtl");
  });

  it("clears a previous error banner on a subsequent successful open (opening twice in a row)", async () => {
    let call = 0;
    stubJarvis({
      gitChanges: async () => {
        call += 1;
        if (call === 1) {
          return { ok: false, text: "not a git repo", language: "en" };
        }
        return {
          ok: true,
          value: {
            session: {
              id: "s1",
              project: "acme",
              projectPath: "~/projects/acme",
              agentId: "claude-acme",
              lastActivityAt: Date.now(),
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
      },
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
      gitChanges: async () => ({
        ok: true,
        value: {
          session: {
            id: "s1",
            project: "acme",
            projectPath: "~/projects/acme",
            agentId: "claude-acme",
            lastActivityAt: Date.now(),
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
      }),
    });

    const { openChanges } = await import("./changes.js");
    await openChanges("s1");

    expect(document.getElementById("changes-add")?.textContent).toBe("+0");
    expect(document.getElementById("changes-del")?.textContent).toBe("−0");
    expect(document.getElementById("changes-error")?.hidden).toBe(true);
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
