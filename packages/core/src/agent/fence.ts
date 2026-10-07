// Tool output is untrusted (spec §5, contracts §1): package descriptions,
// log lines and file contents can carry text written by anyone. It reaches
// the model only inside one <untrusted-data> fence, with any attempt to
// close or reopen the fence inside it neutralised, and capped in size.

export const MAX_TOOL_RESULT_CHARS = 32_000;

const FENCE_TAG = /<\s*(\/?)\s*untrusted-data/gi;

export function fenceToolOutput(tool: string, text: string): string {
  const source = tool.replace(/[^A-Za-z0-9._-]/g, "_");
  let body = text.replace(FENCE_TAG, (_match, slash: string) => `‹${slash}untrusted_data`);
  if (body.length > MAX_TOOL_RESULT_CHARS) {
    const cut = body.length - MAX_TOOL_RESULT_CHARS;
    body = `${body.slice(0, MAX_TOOL_RESULT_CHARS)}\n[truncated ${cut} characters]`;
  }
  return `<untrusted-data source="${source}">\n${body}\n</untrusted-data>`;
}
