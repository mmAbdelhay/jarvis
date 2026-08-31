export type Turn = {
  role: "user" | "assistant";
  text: string;
  language: "ar" | "en";
  sessionId?: string;
  agentId?: string;
  model?: string;
  // Set when a turn's tool call means "and show me this": the renderer
  // switches to the Changes view for `sessionId`, selecting `path` when
  // present. This is what makes the git view reachable by voice — without
  // it, a spoken "وريني التغييرات" would answer in words only.
  view?: "changes";
  path?: string;
  at: number;
};

// `inputSchema` maps each input field name to a one-line description the
// brain can use to fill it in correctly (e.g. that `project` must come
// from the known-projects list, or that `sessionId` must come from the
// running-sessions list) — without it the model has no way to know a
// tool's input shape beyond guessing from its name.
export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: Record<string, string>;
};

// A live snapshot of what the brain is allowed to reference by name: the
// project names it may resolve "project" input to, and the sessions it may
// resolve "sessionId" input to. Without this the model has never seen
// these strings and must guess them, which is exactly how "افتح سعودي
// سيل" fails to match a project keyed as "acme".
export type BrainSessionSummary = {
  id: string;
  project: string;
  agentId: string;
  state: string;
  summary: string;
};

export type BrainContext = {
  projects: string[];
  sessions: BrainSessionSummary[];
};

export type BrainReply = {
  text: string;
  toolCalls: { name: string; input: Record<string, unknown> }[];
};

export type Brain = {
  ask(input: {
    text: string;
    tools: readonly ToolSpec[];
    context: BrainContext;
  }): Promise<BrainReply>;
};
