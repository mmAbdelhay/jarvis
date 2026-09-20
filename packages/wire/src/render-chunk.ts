// Ruling 10's client rule: `offset` and `end` count UTF-16 code units
// emitted since the pane/session started. A push whose whole chunk lies at
// or before `end` (already rendered, or a pure replay) is dropped
// entirely; otherwise only the unseen tail is rendered. Shared by the
// laptop probe (@jarvis/remote's probe-client.ts) and the phone's
// terminal view (M7+).
export function renderChunk(end: number, offset: number, chunk: string): string {
  if (offset + chunk.length <= end) return "";
  return chunk.slice(Math.max(0, end - offset));
}
