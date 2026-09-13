import { describe, expect, it } from "vitest";
import { addedFileDiff, parseUnifiedDiff } from "./parse.js";

const SAMPLE = [
  "diff --git a/CheckoutService.php b/CheckoutService.php",
  "index 1111111..2222222 100644",
  "--- a/CheckoutService.php",
  "+++ b/CheckoutService.php",
  "@@ -41,9 +41,9 @@ class CheckoutService",
  " public function charge(Order $order)",
  " {",
  "-    $res = $this->gateway->pay($order);",
  "-    if (! $res->ok) {",
  "+    $policy = RetryPolicy::exponential(3);",
  "+",
  " ",
  "     return $res;",
  " }",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("keeps the hunk header verbatim", () => {
    const diff = parseUnifiedDiff("CheckoutService.php", SAMPLE);
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]?.header).toBe("@@ -41,9 +41,9 @@ class CheckoutService");
  });

  it("drops the file header lines and never mistakes --- / +++ for content", () => {
    const diff = parseUnifiedDiff("CheckoutService.php", SAMPLE);
    const texts = diff.hunks[0]?.lines.map((line) => line.text) ?? [];
    expect(texts).not.toContain("- a/CheckoutService.php");
    expect(texts[0]).toBe("public function charge(Order $order)");
  });

  it("classifies context, removed and added lines", () => {
    const kinds = parseUnifiedDiff("f", SAMPLE).hunks[0]?.lines.map((l) => l.kind);
    expect(kinds).toEqual([
      "context",
      "context",
      "removed",
      "removed",
      "added",
      "added",
      "context",
      "context",
      "context",
    ]);
  });

  it("numbers before-lines and after-lines independently from the hunk start", () => {
    const lines = parseUnifiedDiff("f", SAMPLE).hunks[0]?.lines ?? [];
    expect(lines[0]).toMatchObject({ beforeLine: 41, afterLine: 41 });
    expect(lines[2]).toMatchObject({ kind: "removed", beforeLine: 43, afterLine: undefined });
    expect(lines[4]).toMatchObject({ kind: "added", beforeLine: undefined, afterLine: 43 });
    expect(lines[6]).toMatchObject({ kind: "context", beforeLine: 45, afterLine: 45 });
  });

  it("handles multiple hunks", () => {
    const raw = ["@@ -1,2 +1,2 @@", "-a", "+b", " c", "@@ -40,1 +40,2 @@", " d", "+e"].join("\n");
    const diff = parseUnifiedDiff("f", raw);
    expect(diff.hunks).toHaveLength(2);
    expect(diff.hunks[1]?.lines[1]).toMatchObject({ kind: "added", afterLine: 41 });
  });

  it("marks binary diffs and produces no hunks", () => {
    const raw = "diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ";
    const diff = parseUnifiedDiff("logo.png", raw);
    expect(diff.binary).toBe(true);
    expect(diff.hunks).toEqual([]);
  });

  it("ignores the no-newline marker and strips CR from CRLF input", () => {
    const raw = "@@ -1,1 +1,1 @@\r\n-old\r\n+new\r\n\\ No newline at end of file\r\n";
    const lines = parseUnifiedDiff("f", raw).hunks[0]?.lines ?? [];
    expect(lines).toHaveLength(2);
    expect(lines[1]?.text).toBe("new");
  });

  it("preserves Arabic content and leading whitespace exactly", () => {
    const raw = "@@ -1,1 +1,1 @@\n-    // القديم\n+    // الجديد\n";
    const lines = parseUnifiedDiff("f", raw).hunks[0]?.lines ?? [];
    expect(lines[0]?.text).toBe("    // القديم");
    expect(lines[1]?.text).toBe("    // الجديد");
  });

  it("returns an empty diff for empty input rather than throwing", () => {
    expect(parseUnifiedDiff("f", "")).toEqual({ path: "f", binary: false, hunks: [] });
  });

  // --- additional adversarial / malformed-input coverage ---

  it("returns no hunks for a diff with file headers but no @@ hunk (e.g. a pure rename or mode change)", () => {
    const raw = [
      "diff --git a/old.txt b/new.txt",
      "similarity index 100%",
      "rename from old.txt",
      "rename to new.txt",
    ].join("\n");
    const diff = parseUnifiedDiff("new.txt", raw);
    expect(diff.binary).toBe(false);
    expect(diff.hunks).toEqual([]);
  });

  it("does not validate the hunk header's declared counts against the lines that actually follow", () => {
    // Header claims 9 before-lines and 9 after-lines; only 3 lines follow.
    // The parser trusts the starting line numbers and classifies whatever
    // it finds rather than throwing or truncating on a mismatch.
    const raw = ["@@ -10,9 +10,9 @@", " x", "-y", "+z"].join("\n");
    const lines = parseUnifiedDiff("f", raw).hunks[0]?.lines ?? [];
    expect(lines).toEqual([
      { kind: "context", text: "x", beforeLine: 10, afterLine: 10 },
      { kind: "removed", text: "y", beforeLine: 11, afterLine: undefined },
      { kind: "added", text: "z", beforeLine: undefined, afterLine: 11 },
    ]);
  });

  it("treats a bare '+' or '-' as a genuinely empty added/removed line, not a truncated one", () => {
    const raw = ["@@ -1,2 +1,2 @@", "-", "+"].join("\n");
    const lines = parseUnifiedDiff("f", raw).hunks[0]?.lines ?? [];
    expect(lines).toEqual([
      { kind: "removed", text: "", beforeLine: 1, afterLine: undefined },
      { kind: "added", text: "", beforeLine: undefined, afterLine: 1 },
    ]);
  });

  it("handles a very long single line without truncating or throwing", () => {
    const longText = "x".repeat(50_000);
    const raw = `@@ -1,1 +1,1 @@\n+${longText}`;
    const lines = parseUnifiedDiff("f", raw).hunks[0]?.lines ?? [];
    expect(lines[0]?.text).toHaveLength(50_000);
    expect(lines[0]?.text).toBe(longText);
  });

  it("preserves RTL Arabic text and does not reorder or corrupt it", () => {
    const rtl = "هذا نص عربي من اليمين إلى اليسار مع أرقام 123 وأقواس (test)";
    const raw = `@@ -1,1 +1,1 @@\n+${rtl}`;
    const lines = parseUnifiedDiff("f", raw).hunks[0]?.lines ?? [];
    expect(lines[0]?.text).toBe(rtl);
  });

  it("does not misclassify a binary marker line appearing without a leading diff --git header", () => {
    const raw = "Binary files a/x.bin and b/x.bin differ";
    const diff = parseUnifiedDiff("x.bin", raw);
    expect(diff.binary).toBe(true);
    expect(diff.hunks).toEqual([]);
  });
});

describe("addedFileDiff", () => {
  it("renders a whole file as one all-added hunk numbered from 1", () => {
    const diff = addedFileDiff("RetryPolicy.php", "<?php\nclass RetryPolicy {}\n");
    expect(diff.binary).toBe(false);
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]?.header).toBe("@@ -0,0 +1,2 @@");
    expect(diff.hunks[0]?.lines).toEqual([
      { kind: "added", text: "<?php", beforeLine: undefined, afterLine: 1 },
      { kind: "added", text: "class RetryPolicy {}", beforeLine: undefined, afterLine: 2 },
    ]);
  });

  it("treats content containing a NUL byte as binary", () => {
    const diff = addedFileDiff("blob.bin", `abc${String.fromCharCode(0)}def`);
    expect(diff.binary).toBe(true);
    expect(diff.hunks).toEqual([]);
  });

  it("returns no hunks for an empty file", () => {
    expect(addedFileDiff("empty.txt", "")).toEqual({
      path: "empty.txt",
      binary: false,
      hunks: [],
    });
  });

  it("strips CR from a CRLF-authored new file", () => {
    const diff = addedFileDiff("f.txt", "line1\r\nline2\r\n");
    expect(diff.hunks[0]?.lines.map((l) => l.text)).toEqual(["line1", "line2"]);
  });

  it("preserves Arabic content in a newly added file", () => {
    const diff = addedFileDiff("رسالة.txt", "مرحبا\nبالعالم\n");
    expect(diff.hunks[0]?.lines.map((l) => l.text)).toEqual(["مرحبا", "بالعالم"]);
  });
});
