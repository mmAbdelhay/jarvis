import { describe, expect, it } from "vitest";
import {
  parseChangesView,
  parseGitDiffResult,
  parseGitViewResult,
  parseTranscriptEntries,
} from "./workspace-results";

function changesPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session: {
      id: "s1",
      project: "jarvis",
      projectPath: "/Users/me/مشروع",
      agentId: "codex",
      lastActivityAt: 123,
      endedAt: undefined,
    },
    changes: {
      repoPath: "/Users/me/مشروع",
      branch: "feature/تجربة",
      detached: false,
      insertions: 3,
      deletions: 1,
      files: [
        {
          path: "src/واجهة.tsx",
          status: "M",
          insertions: 3,
          deletions: 1,
          staged: false,
        },
      ],
    },
    ...overrides,
  };
}

describe("workspace result parsers", () => {
  it("parses a GitViewResult<ChangesView> with Arabic paths and no extra fields", () => {
    const result = parseGitViewResult({ ok: true, value: changesPayload() }, parseChangesView);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.changes.files[0]?.path).toBe("src/واجهة.tsx");
    expect(Object.keys(result.value.session).sort()).toEqual(
      ["agentId", "endedAt", "id", "lastActivityAt", "project", "projectPath"].sort(),
    );
  });

  it("keeps server failure text verbatim", () => {
    expect(
      parseGitViewResult(
        { ok: false, text: "<b>لا يوجد شيء محفوظ</b>", language: "ar" },
        parseChangesView,
      ),
    ).toEqual({ ok: false, text: "<b>لا يوجد شيء محفوظ</b>", language: "ar" });
  });

  it("parses binary and too-large diff states separately", () => {
    expect(
      parseGitDiffResult({
        path: "logo.png",
        binary: true,
        hunks: [],
      }),
    ).toEqual({ path: "logo.png", binary: true, hunks: [] });

    expect(
      parseGitDiffResult({
        path: "big.sql",
        binary: false,
        tooLarge: true,
        hunks: [],
      }),
    ).toEqual({ path: "big.sql", binary: false, tooLarge: true, hunks: [] });
  });

  it("parses unified diff hunks with explicit undefined line numbers", () => {
    expect(
      parseGitDiffResult({
        path: "src/a.ts",
        binary: false,
        hunks: [
          {
            header: "@@ -1,1 +1,2 @@",
            lines: [
              { kind: "context", text: "same", beforeLine: 1, afterLine: 1 },
              { kind: "removed", text: "old", beforeLine: 2, afterLine: undefined },
              { kind: "added", text: "new", beforeLine: undefined, afterLine: 2 },
            ],
          },
        ],
      }),
    ).toEqual({
      path: "src/a.ts",
      binary: false,
      hunks: [
        {
          header: "@@ -1,1 +1,2 @@",
          lines: [
            { kind: "context", text: "same", beforeLine: 1, afterLine: 1 },
            { kind: "removed", text: "old", beforeLine: 2, afterLine: undefined },
            { kind: "added", text: "new", beforeLine: undefined, afterLine: 2 },
          ],
        },
      ],
    });
  });

  it("drops malformed transcript entries and preserves malicious-looking text as text", () => {
    expect(
      parseTranscriptEntries([
        { role: "user", text: "<img src=x onerror=alert(1)>", tools: [] },
        { role: "system", text: "no", tools: [] },
        { role: "assistant", text: "اكتمل", tools: ["git:commit", 7] },
      ]),
    ).toEqual([
      { role: "user", text: "<img src=x onerror=alert(1)>", tools: [] },
      { role: "assistant", text: "اكتمل", tools: ["git:commit"] },
    ]);
  });

  it("rejects malformed values instead of copying partial DTOs", () => {
    expect(parseChangesView(changesPayload({ changes: { files: "bad" } }))).toBeUndefined();
    expect(
      parseGitDiffResult({ path: "x", binary: false, hunks: [{ header: 7, lines: [] }] }),
    ).toBeUndefined();
  });
});
