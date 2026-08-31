import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";
import { createGitProvider } from "./git.js";

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
