import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "./transcript.js";

// This package must stay Node-free and workspace-package-free
// (no-node-imports.test.ts), so it cannot import platform's TranscriptEntry
// here to check the shapes match. That structural assignability check lives
// in packages/desktop/src/wire-transcript-dto.test.ts instead, where both
// @jarvis/wire and @jarvis/platform are legitimately importable.
describe("transcript DTO", () => {
  it("declares the read-only conversation shape mobile can render", () => {
    const entry: TranscriptEntry = {
      role: "assistant",
      text: "<script>alert(1)</script>",
      tools: ["apply_patch"],
    };

    expect(Object.keys(entry).sort()).toEqual(["role", "text", "tools"]);
  });
});
