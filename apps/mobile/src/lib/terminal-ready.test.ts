import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTerminalReadyGate } from "./terminal-ready";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Extracts the body of the brace(s) opened by `marker` (the text up to,
 * but not including, whichever `}` brings the depth back to zero) by
 * brace counting — a plain substring/regex can't stop at the right `}`
 * once the body itself contains nested braces (an `if` block, an object
 * literal, ...). `marker`'s own unclosed `{`s (it may open more than
 * one, e.g. a JSX prop's `{` plus an arrow function's `{`) seed the
 * starting depth, so the walk closes all of them, not just one. Shared by
 * both source-scan describe blocks below (onLoadStart wiring and the
 * `ready`-case flush guard). */
function extractBraceBody(text: string, marker: string): string {
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`marker not found: ${marker}`);
  }
  const markerOpens = (marker.match(/\{/g) ?? []).length;
  const markerCloses = (marker.match(/\}/g) ?? []).length;
  let depth = markerOpens - markerCloses;
  if (depth < 1) {
    throw new Error(`marker doesn't leave an open brace to close: ${marker}`);
  }
  let i = markerIndex + marker.length;
  const bodyStart = i;
  while (depth > 0 && i < text.length) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") depth -= 1;
    i += 1;
  }
  if (depth !== 0) {
    throw new Error(`unbalanced braces after marker: ${marker}`);
  }
  return text.slice(bodyStart, i - 1);
}

describe("terminal ready gate", () => {
  it("accepts one ready per observed load and counts duplicates", () => {
    const gate = createTerminalReadyGate();
    gate.arm();
    expect(gate.accept()).toBe("initial");
    for (let i = 0; i < 100; i++) expect(gate.accept()).toBe("duplicate");
    expect(gate.dropped()).toBe(100);
    gate.arm();
    expect(gate.accept()).toBe("replay");
    expect(gate.accept()).toBe("duplicate");
    expect(gate.dropped()).toBe(101);
  });

  // Final review I2: a second `arm()` before the first `ready` ever
  // arrived (a crash during the initial load) must disposition the
  // eventual `ready` as "replay", not "initial" — the disposition tracks
  // the *last* arm() kind, not whether a ready was ever accepted before.
  // "replay" drives onNeedsReplay() and a full host resnapshot, which is
  // the only way the initial output isn't silently lost: the page that
  // answers this `ready` is not the one whose in-flight writes were
  // buffered under the first "initial" arm.
  it(
    "a crash before first ready is dispositioned as a replay, not lost " +
      "[bite-proof: base accept() on `everReady` instead of `lastArmKind` and this fails]",
    () => {
      const gate = createTerminalReadyGate();
      gate.arm();
      gate.arm();
      expect(gate.accept()).toBe("replay");
    },
  );

  // Fix round 3, N-r2-4: the gate starts disarmed. A `ready` the page
  // somehow posts before any native load event was ever observed is
  // dropped like a duplicate, not accepted as "initial".
  it(
    "starts disarmed: a ready before any observed load is dropped, not accepted " +
      "[bite-proof: change `!armed || accepted` to `accepted` in accept() and this fails]",
    () => {
      const gate = createTerminalReadyGate();
      expect(gate.accept()).toBe("duplicate");
      expect(gate.dropped()).toBe(1);
    },
  );

  // Fix round 3, N-r2-1: the very first `arm()` a gate ever sees reports
  // "initial" — the caller must preserve whatever it buffered before this
  // point, since it survives to be flushed on the `ready` that follows.
  // Every later `arm()` (a reload, or a crash remount's own load) reports
  // "reattach" — the caller may safely drop stale attach state, because
  // the `ready` that follows is dispositioned "replay" and drives a full
  // host resnapshot instead.
  it(
    "arm() reports the first load as initial and every later load as reattach " +
      '[bite-proof: always return "initial" from arm() and this fails]',
    () => {
      const gate = createTerminalReadyGate();
      expect(gate.arm()).toBe("initial");
      expect(gate.arm()).toBe("reattach");
      expect(gate.arm()).toBe("reattach");
    },
  );
});

// Fix round 3, N-r2-1 / N-r2-3: TerminalWebView.tsx cannot be unit tested
// directly (no React Native renderer — global-constraints.md), so the
// wiring invariant that keeps the pre-ready attach buffer alive across the
// initial load is proven by scanning its source instead, the same pattern
// terminal-webview-config.test.ts already uses for the navigation lock.
describe("TerminalWebView.tsx onLoadStart wiring", () => {
  const source = readFileSync(join(HERE, "..", "components", "TerminalWebView.tsx"), "utf8");

  it("arms the ready gate exactly from onLoadStart and remount, never elsewhere", () => {
    const armCalls = source.match(/readyGateRef\.current\?\.arm\(\)/g) ?? [];
    expect(armCalls.length).toBe(2);
    expect(source).not.toContain(".beginLoad(");
  });

  // Final review M2: the attach buffer cap has one source of truth
  // (session-stream.ts's export) so the two caps can't drift apart.
  it(
    "imports ATTACH_BUFFER_MAX_CHARS from session-stream.ts instead of re-declaring it " +
      "[bite-proof: add back `const ATTACH_BUFFER_MAX_CHARS = 1_048_576;` and this fails]",
    () => {
      expect(source).toMatch(/import \{ ATTACH_BUFFER_MAX_CHARS \} from "@\/lib\/session-stream";/);
      expect(source).not.toMatch(/const ATTACH_BUFFER_MAX_CHARS\s*=/);
    },
  );

  // Final review M3: reset() must also clear the pre-ready attach buffer,
  // not just the batcher, so a reset that lands on a not-yet-ready page
  // doesn't leave stale buffered writes to flush later.
  it(
    "reset() clears the pre-ready attach buffer as well as the batcher " +
      "[bite-proof: drop resetAttachState() from the reset() callback and this fails]",
    () => {
      const resetCallback = extractBraceBody(source, "const reset = useCallback(() => {");
      expect(resetCallback).toMatch(/getBatcher\(\)\.clear\(\)/);
      expect(resetCallback).toMatch(/resetAttachState\(\)/);
      expect(resetCallback).toMatch(/postToPage\(\{ t: "reset" \}\)/);
    },
  );

  it(
    "onLoadStart only clears the pre-ready attach buffer on a reattach, never " +
      "unconditionally, so writes before the first ready survive to be flushed on it " +
      "[bite-proof: move resetAttachState()/batcherRef.current?.clear() out of the " +
      '"reattach" branch in onLoadStart and this test fails]',
    () => {
      const onLoadStart = extractBraceBody(source, "onLoadStart={() => {");
      expect(onLoadStart).toMatch(/readyGateRef\.current\?\.arm\(\)/);

      const reattachBody = extractBraceBody(onLoadStart, '=== "reattach") {');
      expect(reattachBody).toMatch(/batcherRef\.current\?\.clear\(\)/);
      expect(reattachBody).toMatch(/resetAttachState\(\)/);

      // Outside that guarded block, onLoadStart never clears the buffer —
      // if it did, an initial-load write arriving before the first
      // `ready` would be silently lost (N-r2-1).
      const outsideReattachBlock = onLoadStart.replace(reattachBody, "");
      expect(outsideReattachBlock).not.toMatch(/batcherRef\.current\?\.clear\(\)/);
      expect(outsideReattachBlock).not.toMatch(/resetAttachState\(\)/);
    },
  );
});

// Final review I1: on a reattach `ready`, the pre-ready attach buffer must
// not be flushed straight into the page before onNeedsReplay() — restart()
// re-snapshots from offset 0, so a flush first would duplicate that tail.
// TerminalWebView.tsx can't be unit tested directly (no React Native
// renderer), so this scans its "ready" case the same way the onLoadStart
// block above is scanned.
describe("TerminalWebView.tsx ready-case flush guard (final review I1)", () => {
  const source = readFileSync(join(HERE, "..", "components", "TerminalWebView.tsx"), "utf8");

  it(
    "flushes the buffered attach text only when neither isReattach nor overflowed " +
      "[bite-proof: change the flush condition back to `if (buffered.length > 0) {` and this fails]",
    () => {
      const readyCase = extractBraceBody(source, 'case "ready": {');

      const isReattachAssignment = readyCase.match(/const isReattach = disposition === "replay";/);
      expect(isReattachAssignment).not.toBeNull();

      const flushGuard = readyCase.match(
        /if \(buffered\.length > 0 && !isReattach && !overflowed\) \{/,
      );
      expect(flushGuard).not.toBeNull();

      const flushBody = extractBraceBody(
        readyCase,
        "if (buffered.length > 0 && !isReattach && !overflowed) {",
      );
      expect(flushBody).toMatch(/getBatcher\(\)\.write\(buffered\)/);

      // Outside that guarded block, the ready case never flushes the
      // buffer unconditionally — if it did, a reattach's snapshot (which
      // re-covers the same bytes from offset 0) would duplicate the tail.
      const outsideFlushGuard = readyCase.replace(flushBody, "");
      expect(outsideFlushGuard).not.toMatch(/getBatcher\(\)\.write\(buffered\)/);
    },
  );

  it(
    "resetAttachState() runs before the guarded flush, so a reattach's buffer is already " +
      "empty by the time isReattach/overflowed are read " +
      "[bite-proof: move resetAttachState() after the flush guard and this fails]",
    () => {
      const readyCase = extractBraceBody(source, 'case "ready": {');
      const resetIndex = readyCase.indexOf("resetAttachState();");
      const flushIndex = readyCase.indexOf(
        "if (buffered.length > 0 && !isReattach && !overflowed) {",
      );
      expect(resetIndex).toBeGreaterThan(-1);
      expect(flushIndex).toBeGreaterThan(-1);
      expect(resetIndex).toBeLessThan(flushIndex);
    },
  );
});
