import type { GitDiffLine } from "@jarvis/core";

export type SideBySideRow = {
  before: GitDiffLine | undefined;
  after: GitDiffLine | undefined;
};

/**
 * Pairs a hunk's lines into before/after rows. A run of removed lines is
 * zipped against the run of added lines that follows it, which is what makes
 * a replacement read as one row per changed line rather than as a block of
 * deletions above a block of insertions. Pure — no DOM, so it is unit-tested
 * without a jsdom environment.
 */
export function toSideBySide(lines: readonly GitDiffLine[]): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let removed: GitDiffLine[] = [];
  let added: GitDiffLine[] = [];

  function flush(): void {
    const length = Math.max(removed.length, added.length);
    for (let index = 0; index < length; index += 1) {
      rows.push({ before: removed[index], after: added[index] });
    }
    removed = [];
    added = [];
  }

  for (const line of lines) {
    if (line.kind === "removed") {
      removed.push(line);
      continue;
    }
    if (line.kind === "added") {
      added.push(line);
      continue;
    }
    flush();
    rows.push({ before: line, after: line });
  }
  flush();

  return rows;
}
