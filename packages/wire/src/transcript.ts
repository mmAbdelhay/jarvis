// Mirrors platform's `TranscriptEntry` (packages/platform/src/session-import.ts)
// field for field. Wire stays Node-free and workspace-package-free, so it
// cannot import that type to check itself — the structural assignability
// check lives in packages/desktop/src/wire-transcript-dto.test.ts, where both
// @jarvis/wire and @jarvis/platform are legitimately importable. Keep this
// declaration in sync by hand if platform's shape changes.
export type TranscriptEntry = {
  role: "user" | "assistant";
  text: string;
  tools: string[];
};
