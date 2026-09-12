import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseUnifiedDiff } from "@jarvis/core";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";
import { createGitProvider, DEFAULT_GIT_TIMEOUT_MS } from "./git.js";

/**
 * Whether this process may create symlinks. On macOS and Linux always; on
 * Windows only with Developer Mode or the SeCreateSymbolicLink privilege,
 * without which symlink() fails with EPERM. The tests that need one are
 * skipped rather than failed there: the containment rule they pin does not
 * depend on the host being able to plant the link.
 */
const canSymlink = ((): boolean => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-symlink-probe-"));
  try {
    writeFileSync(join(dir, "target"), "");
    symlinkSync(join(dir, "target"), join(dir, "link"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();


const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/**
 * Creates a real git repository in a temp directory with one committed file.
 * The spec's Testing section requires git operations to be tested against
 * temporary repositories created in the test, not against a mocked driver —
 * a mock would only prove we can restate our own assumptions about git.
 */
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-git-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));

  const git = simpleGit(dir);
  await git.init(["--initial-branch=main"]);
  await git.addConfig("user.name", "Jarvis Test");
  await git.addConfig("user.email", "test@example.invalid");
  await git.addConfig("commit.gpgsign", "false");

  await writeFile(join(dir, "kept.txt"), "one\ntwo\nthree\n", "utf8");
  await git.add(["kept.txt"]);
  await git.commit("initial");

  return dir;
}

describe("createGitProvider().changes", () => {
  it("reports a modified file with its status letter and line counts", async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, "kept.txt"), "one\nTWO\nthree\nfour\n", "utf8");

    const outcome = await createGitProvider().changes(dir);
    if (!outcome.ok) throw new Error(`expected ok, got ${outcome.error.code}`);

    expect(outcome.value.branch).toBe("main");
    expect(outcome.value.detached).toBe(false);
    expect(outcome.value.files).toHaveLength(1);
    expect(outcome.value.files[0]).toMatchObject({
      path: "kept.txt",
      status: "M",
      insertions: 2,
      deletions: 1,
      staged: false,
    });
    expect(outcome.value.insertions).toBe(2);
    expect(outcome.value.deletions).toBe(1);
  });

  it("marks a staged file as staged and keeps its counts", async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, "added.txt"), "a\nb\n", "utf8");
    await simpleGit(dir).add(["added.txt"]);

    const outcome = await createGitProvider().changes(dir);
    if (!outcome.ok) throw new Error("expected ok");

    expect(outcome.value.files[0]).toMatchObject({
      path: "added.txt",
      status: "A",
      staged: true,
      insertions: 2,
      deletions: 0,
    });
  });

  it("lists an untracked file with `?` and zero counts", async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, "loose.txt"), "x\n", "utf8");

    const outcome = await createGitProvider().changes(dir);
    if (!outcome.ok) throw new Error("expected ok");

    expect(outcome.value.files[0]).toMatchObject({
      path: "loose.txt",
      status: "?",
      staged: false,
      insertions: 0,
      deletions: 0,
    });
  });

  it("keeps an Arabic file path intact", async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, "خدمة.txt"), "س\n", "utf8");

    const outcome = await createGitProvider().changes(dir);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.value.files.map((file) => file.path)).toContain("خدمة.txt");
  });

  it("reports a deleted file with the D status letter", async () => {
    const dir = await makeRepo();
    await rm(join(dir, "kept.txt"));

    const outcome = await createGitProvider().changes(dir);
    if (!outcome.ok) throw new Error("expected ok");

    expect(outcome.value.files[0]).toMatchObject({
      path: "kept.txt",
      status: "D",
      staged: false,
    });
  });

  it("reports a renamed and staged file with the R status letter", async () => {
    const dir = await makeRepo();
    const git = simpleGit(dir);
    await git.mv("kept.txt", "renamed.txt");

    const outcome = await createGitProvider().changes(dir);
    if (!outcome.ok) throw new Error("expected ok");

    expect(outcome.value.files).toHaveLength(1);
    expect(outcome.value.files[0]).toMatchObject({
      status: "R",
      staged: true,
    });
  });

  it("reports real insertions/deletions for a rename with content changes, not 0/0", async () => {
    // Regression test: simple-git's diffSummary reports a renamed file as
    // "kept.txt => renamed.txt", not as the new path alone. A counts lookup
    // keyed by the raw diffSummary string never matches status.files[].path
    // (always the new path) and silently falls back to zero.
    const dir = await makeRepo();
    const git = simpleGit(dir);
    await git.mv("kept.txt", "renamed.txt");
    await writeFile(join(dir, "renamed.txt"), "one\nTWO\nthree\nfour\n", "utf8");
    await git.add(["renamed.txt"]);

    const outcome = await createGitProvider().changes(dir);
    if (!outcome.ok) throw new Error(`expected ok, got ${outcome.error.code}`);

    expect(outcome.value.files).toHaveLength(1);
    expect(outcome.value.files[0]).toMatchObject({
      path: "renamed.txt",
      status: "R",
      staged: true,
      insertions: 2,
      deletions: 1,
    });
    expect(outcome.value.insertions).toBe(2);
    expect(outcome.value.deletions).toBe(1);
  });

  it("reports real insertions/deletions for a rename in a subdirectory (brace notation)", async () => {
    // Same bug, brace form: a common directory collapses the diffSummary
    // key to "sub/{kept.txt => renamed.txt}", which must resolve to
    // "sub/renamed.txt" to match status.files[].path.
    const dir = await makeRepo();
    const git = simpleGit(dir);
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "kept2.txt"), "one\ntwo\nthree\n", "utf8");
    await git.add(["sub/kept2.txt"]);
    await git.commit("add sub file");

    await git.mv("sub/kept2.txt", "sub/renamed2.txt");
    await writeFile(join(dir, "sub", "renamed2.txt"), "one\nTWO\nthree\nfour\n", "utf8");
    await git.add(["sub/renamed2.txt"]);

    const outcome = await createGitProvider().changes(dir);
    if (!outcome.ok) throw new Error(`expected ok, got ${outcome.error.code}`);

    const renamed = outcome.value.files.find((file) => file.path === "sub/renamed2.txt");
    expect(renamed).toMatchObject({
      status: "R",
      staged: true,
      insertions: 2,
      deletions: 1,
    });
  });

  it("rolls a rename's real counts up into the totals alongside an ordinary edit", async () => {
    const dir = await makeRepo();
    const git = simpleGit(dir);
    await git.mv("kept.txt", "renamed.txt");
    await writeFile(join(dir, "renamed.txt"), "one\nTWO\nthree\nfour\n", "utf8");
    await git.add(["renamed.txt"]);
    await writeFile(join(dir, "loose.txt"), "x\ny\n", "utf8");

    const outcome = await createGitProvider().changes(dir);
    if (!outcome.ok) throw new Error(`expected ok, got ${outcome.error.code}`);

    expect(outcome.value.files).toHaveLength(2);
    // renamed.txt: +2/-1 (staged), loose.txt: untracked, +0/-0.
    expect(outcome.value.insertions).toBe(2);
    expect(outcome.value.deletions).toBe(1);
  });

  it("reports a detached HEAD as detached with the short SHA as the branch", async () => {
    const dir = await makeRepo();
    const git = simpleGit(dir);
    const head = (await git.revparse(["HEAD"])).trim();
    await git.checkout([head]);

    const outcome = await createGitProvider().changes(dir);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.value.detached).toBe(true);
    expect(head.startsWith(outcome.value.branch)).toBe(true);
  });

  it("returns a clean repo with no files and zero totals", async () => {
    const dir = await makeRepo();

    const outcome = await createGitProvider().changes(dir);
    if (!outcome.ok) throw new Error("expected ok");

    expect(outcome.value.files).toEqual([]);
    expect(outcome.value.insertions).toBe(0);
    expect(outcome.value.deletions).toBe(0);
  });

  it("returns a not-a-repo failure instead of throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-plain-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));

    const outcome = await createGitProvider().changes(dir);
    expect(outcome).toEqual({
      ok: false,
      error: { code: "not-a-repo", detail: dir },
    });
  });

  it("returns a failure, not a rejection, for a path that does not exist", async () => {
    const outcome = await createGitProvider().changes("/definitely/not/here");
    expect(outcome.ok).toBe(false);
  });

  it("returns a failure instead of hanging when the git process exceeds the timeout", async () => {
    // A stalled index lock or a huge repo must not hang the caller forever —
    // GitOutcome cannot express "still running". Rather than waiting out a
    // real multi-second hang (the suite must stay fast), the provider's
    // timeout is injected as an unreasonably small bound: any real spawn of
    // the git binary takes far longer than 1ms of wall time, so the
    // timeout plugin reliably fires almost immediately, without a sleep in
    // this test.
    const dir = await makeRepo();

    const outcome = await createGitProvider(1).changes(dir);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("failed");
    expect(outcome.error.detail).toContain("timed out");
  });

  it("uses a generous default timeout so a normal repo is unaffected", async () => {
    expect(DEFAULT_GIT_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });
});

describe("createGitProvider().diff", () => {
  it("returns parsed hunks for a modified tracked file", async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, "kept.txt"), "one\nTWO\nthree\n", "utf8");

    const outcome = await createGitProvider().diff(dir, "kept.txt");
    if (!outcome.ok) throw new Error(`expected ok, got ${outcome.error.code}`);

    expect(outcome.value.path).toBe("kept.txt");
    expect(outcome.value.binary).toBe(false);
    expect(outcome.value.hunks).toHaveLength(1);
    const kinds = outcome.value.hunks[0]?.lines.map((line) => line.kind);
    expect(kinds).toContain("removed");
    expect(kinds).toContain("added");
  });

  it("diffs against HEAD so a staged change is still visible", async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, "kept.txt"), "one\nTWO\nthree\n", "utf8");
    await simpleGit(dir).add(["kept.txt"]);

    const outcome = await createGitProvider().diff(dir, "kept.txt");
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.value.hunks).toHaveLength(1);
  });

  it("diffs against HEAD so an unstaged edit on top of a staged one is still visible", async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, "kept.txt"), "one\nTWO\nthree\n", "utf8");
    await simpleGit(dir).add(["kept.txt"]);
    await writeFile(join(dir, "kept.txt"), "one\nTWO\nTHREE\n", "utf8");

    const outcome = await createGitProvider().diff(dir, "kept.txt");
    if (!outcome.ok) throw new Error("expected ok");
    const texts = outcome.value.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text));
    expect(texts).toContain("TWO");
    expect(texts).toContain("THREE");
  });

  it("renders an untracked file as one all-added hunk", async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, "new.txt"), "alpha\nbeta\n", "utf8");

    const outcome = await createGitProvider().diff(dir, "new.txt");
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.value.hunks[0]?.lines).toEqual([
      { kind: "added", text: "alpha", beforeLine: undefined, afterLine: 1 },
      { kind: "added", text: "beta", beforeLine: undefined, afterLine: 2 },
    ]);
  });

  it("renders a staged (but not yet committed) new file as one all-added hunk", async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, "new.txt"), "alpha\nbeta\n", "utf8");
    await simpleGit(dir).add(["new.txt"]);

    const outcome = await createGitProvider().diff(dir, "new.txt");
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.value.hunks[0]?.lines.map((line) => line.text)).toEqual(["alpha", "beta"]);
  });

  it("refuses a path that escapes the repository", async () => {
    const dir = await makeRepo();
    const outcome = await createGitProvider().diff(dir, "../../../etc/passwd");
    expect(outcome.ok).toBe(false);
  });

  it("refuses an absolute path", async () => {
    const dir = await makeRepo();
    const outcome = await createGitProvider().diff(dir, "/etc/passwd");
    expect(outcome.ok).toBe(false);
  });

  it.skipIf(!canSymlink)("refuses an untracked symlink whose target resolves outside the repository (P17)", async () => {
    const dir = await makeRepo();
    const secretDir = await mkdtemp(join(tmpdir(), "jarvis-secret-"));
    cleanups.push(() => rm(secretDir, { recursive: true, force: true }));
    const secretPath = join(secretDir, "id_rsa");
    await writeFile(secretPath, "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n", "utf8");

    // insideRepo() is a lexical-only check on the *link's own* path
    // ("link.txt" — no "../", not absolute) and would pass it; the escape
    // is entirely in what the link resolves to.
    await symlink(secretPath, join(dir, "link.txt"));

    const outcome = await createGitProvider().diff(dir, "link.txt");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // Must be a normal GitOutcome failure, never leak the secret content.
    expect(JSON.stringify(outcome)).not.toContain("secret");
  });

  it("still reads a legitimate untracked file when the repo itself sits under a symlinked root", async () => {
    // makeRepo() already creates its repo under os.tmpdir(), which is
    // itself a symlink on macOS (/tmp -> /private/tmp) — this is the
    // regression the P17 fix (comparing resolved repo root vs resolved
    // file) most easily causes if only one side were resolved.
    const dir = await makeRepo();
    await writeFile(join(dir, "new.txt"), "alpha\nbeta\n", "utf8");

    const outcome = await createGitProvider().diff(dir, "new.txt");
    if (!outcome.ok) throw new Error("expected ok, got failure");
    expect(outcome.value.hunks[0]?.lines.map((line) => line.text)).toEqual(["alpha", "beta"]);
  });

  it("returns an empty diff, not a failure, for an unchanged file", async () => {
    const dir = await makeRepo();
    const outcome = await createGitProvider().diff(dir, "kept.txt");
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.value.hunks).toEqual([]);
  });

  it("returns an empty diff for a path git has never heard of", async () => {
    const dir = await makeRepo();
    const outcome = await createGitProvider().diff(dir, "never-existed.txt");
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.value.hunks).toEqual([]);
    expect(outcome.value.binary).toBe(false);
  });

  it("reports a deleted file as an all-removed diff", async () => {
    const dir = await makeRepo();
    await rm(join(dir, "kept.txt"));

    const outcome = await createGitProvider().diff(dir, "kept.txt");
    if (!outcome.ok) throw new Error("expected ok");
    const kinds = outcome.value.hunks.flatMap((hunk) => hunk.lines.map((line) => line.kind));
    expect(kinds.every((kind) => kind === "removed")).toBe(true);
    expect(kinds.length).toBeGreaterThan(0);
  });

  it("shows a pure rename as no content delta, agreeing with changes()'s 0/0", async () => {
    const dir = await makeRepo();
    await simpleGit(dir).mv("kept.txt", "renamed.txt");

    const provider = createGitProvider();
    const changesOutcome = await provider.changes(dir);
    if (!changesOutcome.ok) throw new Error("expected ok");
    const row = changesOutcome.value.files.find((file) => file.path === "renamed.txt");
    expect(row).toMatchObject({ insertions: 0, deletions: 0 });

    const outcome = await provider.diff(dir, "renamed.txt");
    if (!outcome.ok) throw new Error("expected ok");
    // A pure rename has no content delta at all — no `git diff` hunks — so
    // the diff pane must agree with the file list's 0/0, not report the
    // whole file as newly added just because the new path never existed at
    // HEAD under its own name alone.
    expect(outcome.value.hunks).toEqual([]);
    expect(outcome.value.binary).toBe(false);
  });

  it("shows a rename with edits as only the edited lines, not the whole file", async () => {
    const dir = await makeRepo();
    const git = simpleGit(dir);
    await git.mv("kept.txt", "renamed.txt");
    await writeFile(join(dir, "renamed.txt"), "one\nTWO\nthree\n", "utf8");

    const outcome = await createGitProvider().diff(dir, "renamed.txt");
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.value.path).toBe("renamed.txt");
    expect(outcome.value.binary).toBe(false);
    expect(outcome.value.hunks).toHaveLength(1);
    const lines = outcome.value.hunks[0]?.lines ?? [];
    // Only the one edited line changes; "one" and "three" survive as
    // context, not as removed+added noise for the whole file.
    expect(lines.filter((line) => line.kind === "removed").map((line) => line.text)).toEqual([
      "two",
    ]);
    expect(lines.filter((line) => line.kind === "added").map((line) => line.text)).toEqual([
      "TWO",
    ]);
    expect(lines.some((line) => line.kind === "context" && line.text === "one")).toBe(true);
    expect(lines.some((line) => line.kind === "context" && line.text === "three")).toBe(true);
  });

  it("detects a binary file instead of returning empty hunks", async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, "kept.txt"), Buffer.from([0, 1, 2, 3, 0, 255]));

    const outcome = await createGitProvider().diff(dir, "kept.txt");
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.value.binary).toBe(true);
    expect(outcome.value.hunks).toEqual([]);
  });

  it("treats a binary untracked file as binary, not as text with a NUL byte in it", async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, "new.bin"), Buffer.from([0, 1, 2, 3]));

    const outcome = await createGitProvider().diff(dir, "new.bin");
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.value.binary).toBe(true);
    expect(outcome.value.hunks).toEqual([]);
  });

  it("caps a large untracked file as too-large rather than reading it whole or calling it binary", async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, "huge.txt"), "x".repeat(2_000_001), "utf8");

    const outcome = await createGitProvider().diff(dir, "huge.txt");
    if (!outcome.ok) throw new Error("expected ok");
    // A large text file is not binary — reporting it as such would be a lie
    // the UI has no way to catch. `tooLarge` says "not shown", `binary`
    // stays false because the content was never read to know either way.
    expect(outcome.value.binary).toBe(false);
    expect(outcome.value.tooLarge).toBe(true);
    expect(outcome.value.hunks).toEqual([]);
  });

  it("caps a large tracked diff as too-large rather than parsing it whole or calling it binary", async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, "kept.txt"), "x\n".repeat(1_500_000), "utf8");

    const outcome = await createGitProvider().diff(dir, "kept.txt");
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.value.binary).toBe(false);
    expect(outcome.value.tooLarge).toBe(true);
    expect(outcome.value.hunks).toEqual([]);
  });

  it("returns a not-a-repo failure instead of throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-plain-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));

    const outcome = await createGitProvider().diff(dir, "whatever.txt");
    expect(outcome.ok).toBe(false);
  });

  it("matches a captured real `git diff` fixture for a modified file", async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, "kept.txt"), "one\nTWO\nthree\nfour\n", "utf8");

    const outcome = await createGitProvider().diff(dir, "kept.txt");
    if (!outcome.ok) throw new Error("expected ok");

    const rawFixture = await readFile(join(FIXTURES, "diff-modified.txt"), "utf8");
    const expected = parseUnifiedDiff("kept.txt", rawFixture);

    // Confirms two independent things at once: the fixture is genuine `git
    // diff` output (captured once with the real git binary, committed so a
    // reviewer can re-run this), and the live provider — talking to its own
    // temp repo — produces the exact same hunks the parser derives from it.
    expect(outcome.value).toEqual(expected);
    expect(outcome.value.hunks).toEqual([
      {
        header: "@@ -1,3 +1,4 @@",
        lines: [
          { kind: "context", text: "one", beforeLine: 1, afterLine: 1 },
          { kind: "removed", text: "two", beforeLine: 2, afterLine: undefined },
          { kind: "added", text: "TWO", beforeLine: undefined, afterLine: 2 },
          { kind: "context", text: "three", beforeLine: 3, afterLine: 3 },
          { kind: "added", text: "four", beforeLine: undefined, afterLine: 4 },
        ],
      },
    ]);
  });

  it("matches a captured real file's content for an added file", async () => {
    const dir = await makeRepo();
    const content = await readFile(join(FIXTURES, "diff-added-content.txt"), "utf8");
    await writeFile(join(dir, "new.txt"), content, "utf8");

    const outcome = await createGitProvider().diff(dir, "new.txt");
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.value.hunks[0]?.lines.map((line) => line.text)).toEqual(["alpha", "beta"]);
  });
});

describe("createGitProvider() staging and commit", () => {
  it("stages a file and reports it as staged", async () => {
    const dir = await makeRepo();
    const provider = createGitProvider();
    await writeFile(join(dir, "kept.txt"), "one\nTWO\nthree\n", "utf8");

    expect(await provider.stage(dir, ["kept.txt"])).toEqual({ ok: true, value: null });

    const after = await provider.changes(dir);
    if (!after.ok) throw new Error("expected ok");
    expect(after.value.files[0]?.staged).toBe(true);
  });

  it("unstages a file again", async () => {
    const dir = await makeRepo();
    const provider = createGitProvider();
    await writeFile(join(dir, "kept.txt"), "one\nTWO\nthree\n", "utf8");
    await provider.stage(dir, ["kept.txt"]);

    expect(await provider.unstage(dir, ["kept.txt"])).toEqual({ ok: true, value: null });

    const after = await provider.changes(dir);
    if (!after.ok) throw new Error("expected ok");
    expect(after.value.files[0]?.staged).toBe(false);
  });

  it("commits what is staged and returns the short sha", async () => {
    const dir = await makeRepo();
    const provider = createGitProvider();
    await writeFile(join(dir, "kept.txt"), "one\nTWO\nthree\n", "utf8");
    await provider.stage(dir, ["kept.txt"]);

    const outcome = await provider.commit(dir, "تعديل الاختبارات");
    if (!outcome.ok) throw new Error(`expected ok, got ${outcome.error.code}`);
    expect(outcome.value.sha.length).toBeGreaterThan(0);
    expect(outcome.value.filesChanged).toBe(1);

    const log = await simpleGit(dir).log();
    expect(log.latest?.message).toBe("تعديل الاختبارات");

    const after = await provider.changes(dir);
    if (!after.ok) throw new Error("expected ok");
    expect(after.value.files).toEqual([]);
  });

  it("commits an Arabic message and the real sha appears at HEAD via git log", async () => {
    const dir = await makeRepo();
    const provider = createGitProvider();
    await writeFile(join(dir, "kept.txt"), "one\nTWO\nthree\n", "utf8");
    await provider.stage(dir, ["kept.txt"]);

    const outcome = await provider.commit(dir, "إصلاح خطأ في الاختبارات");
    if (!outcome.ok) throw new Error(`expected ok, got ${outcome.error.code}`);

    const head = (await simpleGit(dir).revparse(["--short", "HEAD"])).trim();
    expect(outcome.value.sha).toBe(head);
  });

  it("refuses to commit with nothing staged", async () => {
    const dir = await makeRepo();
    const outcome = await createGitProvider().commit(dir, "nothing here");
    expect(outcome).toMatchObject({ ok: false, error: { code: "nothing-staged" } });
  });

  it("refuses an empty or whitespace-only commit message", async () => {
    const dir = await makeRepo();
    const provider = createGitProvider();
    await writeFile(join(dir, "kept.txt"), "changed\n", "utf8");
    await provider.stage(dir, ["kept.txt"]);

    const outcome = await provider.commit(dir, "   ");
    expect(outcome).toMatchObject({ ok: false, error: { code: "empty-message" } });
  });

  it("refuses an empty message even though something is staged, without committing it", async () => {
    const dir = await makeRepo();
    const provider = createGitProvider();
    await writeFile(join(dir, "kept.txt"), "changed\n", "utf8");
    await provider.stage(dir, ["kept.txt"]);
    const before = (await simpleGit(dir).revparse(["HEAD"])).trim();

    await provider.commit(dir, "");

    const after = (await simpleGit(dir).revparse(["HEAD"])).trim();
    expect(after).toBe(before);
  });

  it("commits a multi-line message (subject + body) intact", async () => {
    const dir = await makeRepo();
    const provider = createGitProvider();
    await writeFile(join(dir, "kept.txt"), "changed\n", "utf8");
    await provider.stage(dir, ["kept.txt"]);

    const message = "subject line\n\nbody line one\nbody line two";
    const outcome = await provider.commit(dir, message);
    if (!outcome.ok) throw new Error(`expected ok, got ${outcome.error.code}`);

    const raw = (await simpleGit(dir).raw(["log", "-1", "--format=%B"])).trimEnd();
    expect(raw).toBe(message);
  });

  it("commits a message containing quotes intact", async () => {
    const dir = await makeRepo();
    const provider = createGitProvider();
    await writeFile(join(dir, "kept.txt"), "changed\n", "utf8");
    await provider.stage(dir, ["kept.txt"]);

    const message = `fix: handle "quoted" and 'single' text`;
    const outcome = await provider.commit(dir, message);
    if (!outcome.ok) throw new Error(`expected ok, got ${outcome.error.code}`);

    const subject = (await simpleGit(dir).raw(["log", "-1", "--format=%s"])).trim();
    expect(subject).toBe(message);
  });

  it("commits a message starting with a leading dash intact, not as a flag", async () => {
    const dir = await makeRepo();
    const provider = createGitProvider();
    await writeFile(join(dir, "kept.txt"), "changed\n", "utf8");
    await provider.stage(dir, ["kept.txt"]);

    const message = "-force cleanup of stale entries";
    const outcome = await provider.commit(dir, message);
    if (!outcome.ok) throw new Error(`expected ok, got ${outcome.error.code}`);

    const subject = (await simpleGit(dir).raw(["log", "-1", "--format=%s"])).trim();
    expect(subject).toBe(message);
  });

  it("reports a conflict instead of committing over an unresolved merge", async () => {
    const dir = await makeRepo();
    const git = simpleGit(dir);

    await git.checkoutLocalBranch("feature");
    await writeFile(join(dir, "kept.txt"), "one\ntwo\nFEATURE\n", "utf8");
    await git.add(["kept.txt"]);
    await git.commit("feature change");

    await git.checkout("main");
    await writeFile(join(dir, "kept.txt"), "one\ntwo\nMAIN\n", "utf8");
    await git.add(["kept.txt"]);
    await git.commit("main change");

    await git.merge(["feature"]).catch(() => undefined);

    const outcome = await createGitProvider().commit(dir, "resolve merge");
    expect(outcome).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("reports a failure, not a false success, when a pre-commit hook rejects the commit", async () => {
    const dir = await makeRepo();
    const provider = createGitProvider();
    const hooksDir = join(dir, ".git", "hooks");
    await mkdir(hooksDir, { recursive: true });
    await writeFile(join(hooksDir, "pre-commit"), "#!/bin/sh\nexit 1\n", "utf8");
    await chmod(join(hooksDir, "pre-commit"), 0o755);

    await writeFile(join(dir, "kept.txt"), "changed\n", "utf8");
    await provider.stage(dir, ["kept.txt"]);
    const before = (await simpleGit(dir).revparse(["HEAD"])).trim();

    const outcome = await provider.commit(dir, "should not land");

    expect(outcome.ok).toBe(false);
    const after = (await simpleGit(dir).revparse(["HEAD"])).trim();
    expect(after).toBe(before);
  });

  it("reports the real sha and files-changed count from git, not counted optimistically", async () => {
    const dir = await makeRepo();
    const provider = createGitProvider();
    await writeFile(join(dir, "kept.txt"), "changed one\n", "utf8");
    await writeFile(join(dir, "second.txt"), "second\n", "utf8");
    await provider.stage(dir, ["kept.txt", "second.txt"]);

    const outcome = await provider.commit(dir, "two files");
    if (!outcome.ok) throw new Error(`expected ok, got ${outcome.error.code}`);

    expect(outcome.value.filesChanged).toBe(2);
    const realSha = (await simpleGit(dir).revparse(["--short", "HEAD"])).trim();
    expect(outcome.value.sha).toBe(realSha);
  });

  it("commits successfully on an unborn HEAD (a repository with no commits yet)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-git-unborn-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const git = simpleGit(dir);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.name", "Jarvis Test");
    await git.addConfig("user.email", "test@example.invalid");
    await git.addConfig("commit.gpgsign", "false");

    const provider = createGitProvider();
    await writeFile(join(dir, "first.txt"), "hello\n", "utf8");

    const staged = await provider.stage(dir, ["first.txt"]);
    expect(staged).toEqual({ ok: true, value: null });

    const outcome = await provider.commit(dir, "first commit");
    if (!outcome.ok) throw new Error(`expected ok, got ${outcome.error.code}`);
    expect(outcome.value.filesChanged).toBe(1);

    const log = await git.log();
    expect(log.latest?.message).toBe("first commit");
  });

  it("refuses to commit on an unborn HEAD with nothing staged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-git-unborn-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const git = simpleGit(dir);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.name", "Jarvis Test");
    await git.addConfig("user.email", "test@example.invalid");
    await git.addConfig("commit.gpgsign", "false");

    const outcome = await createGitProvider().commit(dir, "nothing staged yet");
    expect(outcome).toMatchObject({ ok: false, error: { code: "nothing-staged" } });
  });

  it("unstages on an unborn HEAD (git reset against a nonexistent HEAD) without throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-git-unborn-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const git = simpleGit(dir);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.name", "Jarvis Test");
    await git.addConfig("user.email", "test@example.invalid");
    await git.addConfig("commit.gpgsign", "false");

    const provider = createGitProvider();
    await writeFile(join(dir, "first.txt"), "hello\n", "utf8");
    await provider.stage(dir, ["first.txt"]);

    const outcome = await provider.unstage(dir, ["first.txt"]);
    expect(outcome.ok).toBe(true);

    const status = await git.status();
    expect(status.staged).toEqual([]);
    expect(status.not_added).toEqual(["first.txt"]);
  });

  it("refuses to stage a path outside the repository", async () => {
    const dir = await makeRepo();
    const outcome = await createGitProvider().stage(dir, ["../escape.txt"]);
    expect(outcome.ok).toBe(false);
  });

  it("refuses to unstage a path outside the repository", async () => {
    const dir = await makeRepo();
    const outcome = await createGitProvider().unstage(dir, ["../escape.txt"]);
    expect(outcome.ok).toBe(false);
  });

  it("returns a failure, not a throw, staging a path that does not exist", async () => {
    const dir = await makeRepo();
    const outcome = await createGitProvider().stage(dir, ["does-not-exist.txt"]);
    expect(outcome.ok).toBe(false);
  });

  it("is a no-op staging an already-staged file", async () => {
    const dir = await makeRepo();
    const provider = createGitProvider();
    await writeFile(join(dir, "kept.txt"), "changed\n", "utf8");
    await provider.stage(dir, ["kept.txt"]);

    const outcome = await provider.stage(dir, ["kept.txt"]);
    expect(outcome).toEqual({ ok: true, value: null });

    const after = await provider.changes(dir);
    if (!after.ok) throw new Error("expected ok");
    expect(after.value.files[0]?.staged).toBe(true);
  });

  it("stages an untracked file", async () => {
    const dir = await makeRepo();
    const provider = createGitProvider();
    await writeFile(join(dir, "brand-new.txt"), "content\n", "utf8");

    const outcome = await provider.stage(dir, ["brand-new.txt"]);
    expect(outcome).toEqual({ ok: true, value: null });

    const after = await provider.changes(dir);
    if (!after.ok) throw new Error("expected ok");
    expect(after.value.files[0]).toMatchObject({ path: "brand-new.txt", staged: true });
  });

  it("stages a deleted file", async () => {
    const dir = await makeRepo();
    const provider = createGitProvider();
    await rm(join(dir, "kept.txt"));

    const outcome = await provider.stage(dir, ["kept.txt"]);
    expect(outcome).toEqual({ ok: true, value: null });

    const after = await provider.changes(dir);
    if (!after.ok) throw new Error("expected ok");
    expect(after.value.files[0]).toMatchObject({ path: "kept.txt", status: "D", staged: true });
  });

  it("stages a renamed file", async () => {
    const dir = await makeRepo();
    const provider = createGitProvider();
    const git = simpleGit(dir);
    await git.raw(["mv", "kept.txt", "renamed.txt"]);

    const outcome = await provider.stage(dir, ["renamed.txt"]);
    expect(outcome).toEqual({ ok: true, value: null });

    const after = await provider.changes(dir);
    if (!after.ok) throw new Error("expected ok");
    expect(after.value.files[0]).toMatchObject({ status: "R", staged: true });
  });

  it("treats an empty path list as a no-op rather than staging everything", async () => {
    const dir = await makeRepo();
    const provider = createGitProvider();
    await writeFile(join(dir, "kept.txt"), "changed\n", "utf8");

    expect(await provider.stage(dir, [])).toEqual({ ok: true, value: null });

    const after = await provider.changes(dir);
    if (!after.ok) throw new Error("expected ok");
    expect(after.value.files[0]?.staged).toBe(false);
  });

  it("treats an empty path list on unstage as a no-op", async () => {
    const dir = await makeRepo();
    const provider = createGitProvider();
    await writeFile(join(dir, "kept.txt"), "changed\n", "utf8");
    await provider.stage(dir, ["kept.txt"]);

    expect(await provider.unstage(dir, [])).toEqual({ ok: true, value: null });

    const after = await provider.changes(dir);
    if (!after.ok) throw new Error("expected ok");
    expect(after.value.files[0]?.staged).toBe(true);
  });
});
