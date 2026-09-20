// @jarvis/wire declares its own `TranscriptEntry` (packages/wire/src/transcript.ts)
// rather than importing platform's, because wire must stay Node-free and
// workspace-package-free (packages/wire/src/no-node-imports.test.ts). That
// leaves the two declarations able to drift apart silently. desktop already
// depends on both @jarvis/wire and @jarvis/platform (package.json), so this
// is the legitimate place to assert, at compile time, that the two types
// describe exactly the same shape: each is structurally assignable to the
// other, in both directions.
import type { TranscriptEntry as PlatformTranscriptEntry } from "@jarvis/platform";
import type { TranscriptEntry as WireTranscriptEntry } from "@jarvis/wire";
import { describe, expect, it } from "vitest";

type AssertTrue<T extends true> = T;

// [bite-proof: add a required field to either type (e.g. a required
// `extraField: string` on TranscriptEntry) and `tsc -b` stops compiling,
// naming this file and transcript.test.ts's own literal. Verified by hand;
// a mutual-`extends` check is structural, so an *optional* extra field on
// either side is still (rightly) considered compatible and would not fail
// here — only a genuine shape mismatch does.]
type WireMatchesPlatform = AssertTrue<
  WireTranscriptEntry extends PlatformTranscriptEntry
    ? PlatformTranscriptEntry extends WireTranscriptEntry
      ? true
      : false
    : false
>;

const _wireMatchesPlatform: WireMatchesPlatform = true;

describe("wire TranscriptEntry mirrors platform's TranscriptEntry", () => {
  it("is the same shape in both directions (compile-time check above; this just keeps the file from being vacuous)", () => {
    const entry: WireTranscriptEntry & PlatformTranscriptEntry = {
      role: "user",
      text: "hello",
      tools: [],
    };
    expect(Object.keys(entry).sort()).toEqual(["role", "text", "tools"]);
  });
});
