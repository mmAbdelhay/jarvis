import type { GitDiffHunk, GitDiffLine, GitFileDiff } from "./types.js";

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parses one file's `git diff` output into hunks. Deliberately tolerant:
 * this text comes from a repository the user does not control, so anything
 * unrecognised is skipped rather than thrown on — the spec requires a git
 * problem to be *shown*, never to block the assistant.
 *
 * Line classification only ever looks at the first character of a hunk-body
 * line, so a hunk header's own `,b`/`,d` counts are never trusted or
 * cross-checked against how many lines actually follow — if git (or an
 * attacker-controlled diff) prints a header whose counts disagree with the
 * following lines, every line is still classified and numbered from the
 * header's starting line, and parsing simply continues to the next `@@` or
 * end of input rather than validating a count.
 */
export function parseUnifiedDiff(path: string, raw: string): GitFileDiff {
  if (raw.includes("\nBinary files ") || raw.startsWith("Binary files ")) {
    return { path, binary: true, hunks: [] };
  }

  const hunks: GitDiffHunk[] = [];
  let current: GitDiffHunk | undefined;
  let beforeLine = 0;
  let afterLine = 0;

  // git always terminates its own output with a trailing "\n". Splitting on
  // "\n" without removing that one trailing newline first would leave a
  // spurious empty final element, which the "line === ''" context fallback
  // below would misread as a genuine blank context line appended to the
  // last hunk. Strip exactly one trailing newline (never more — a real
  // blank line at the end of a hunk still starts with its own " " marker
  // and must survive).
  const normalized = raw.endsWith("\n") ? raw.slice(0, -1) : raw;

  for (const rawLine of normalized.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    const header = HUNK_HEADER.exec(line);
    if (header !== null) {
      const beforeStart = header[1];
      const afterStart = header[2];
      current = { header: line, lines: [] };
      hunks.push(current);
      beforeLine = beforeStart === undefined ? 0 : Number(beforeStart);
      afterLine = afterStart === undefined ? 0 : Number(afterStart);
      continue;
    }

    if (current === undefined) continue;
    // "\ No newline at end of file" is metadata about the previous line,
    // not a line of the file.
    if (line.startsWith("\\")) continue;

    const marker = line.slice(0, 1);
    const text = line.slice(1);

    if (marker === "+") {
      current.lines.push({ kind: "added", text, beforeLine: undefined, afterLine });
      afterLine += 1;
      continue;
    }
    if (marker === "-") {
      current.lines.push({ kind: "removed", text, beforeLine, afterLine: undefined });
      beforeLine += 1;
      continue;
    }
    if (marker === " " || line === "") {
      current.lines.push({ kind: "context", text, beforeLine, afterLine });
      beforeLine += 1;
      afterLine += 1;
    }
    // Anything else (a stray "diff --git" from a combined diff, an "index"
    // line, a "--- a/..."/"+++ b/..." file header) is not part of a hunk
    // body and is skipped.
  }

  return { path, binary: false, hunks };
}

/**
 * An untracked file has no git diff at all — git has never seen it. Rather
 * than shell out to `--no-index` (which exits non-zero on difference and
 * makes error handling ambiguous), the provider reads the file and this
 * function renders it as a single all-added hunk.
 */
export function addedFileDiff(path: string, content: string): GitFileDiff {
  if (content.includes(String.fromCharCode(0))) return { path, binary: true, hunks: [] };
  if (content === "") return { path, binary: false, hunks: [] };

  const withoutTrailingNewline = content.endsWith("\n") ? content.slice(0, -1) : content;
  const lines: GitDiffLine[] = withoutTrailingNewline.split("\n").map((text, index) => ({
    kind: "added",
    text: text.endsWith("\r") ? text.slice(0, -1) : text,
    beforeLine: undefined,
    afterLine: index + 1,
  }));

  return {
    path,
    binary: false,
    hunks: [{ header: `@@ -0,0 +1,${lines.length} @@`, lines }],
  };
}
