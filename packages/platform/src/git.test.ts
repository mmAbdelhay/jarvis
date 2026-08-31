import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseUnifiedDiff } from "@jarvis/core";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";
import { createGitProvider } from "./git.js";

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

  it("diffs a renamed file by its new path, against HEAD, as newly added content", async () => {
    const dir = await makeRepo();
    await simpleGit(dir).mv("kept.txt", "renamed.txt");

    const outcome = await createGitProvider().diff(dir, "renamed.txt");
    if (!outcome.ok) throw new Error("expected ok");
    // renamed.txt does not exist at HEAD under this path, so a HEAD-relative
    // diff shows its whole content as added — consistent with diffing
    // against HEAD everywhere else, and it must not fail or come back empty.
    expect(outcome.value.hunks).toHaveLength(1);
    const kinds = outcome.value.hunks[0]?.lines.map((line) => line.kind);
    expect(kinds?.every((kind) => kind === "added")).toBe(true);
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

  it("caps a large untracked file as binary instead of reading it whole", async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, "huge.txt"), "x".repeat(2_000_001), "utf8");

    const outcome = await createGitProvider().diff(dir, "huge.txt");
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.value.binary).toBe(true);
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
