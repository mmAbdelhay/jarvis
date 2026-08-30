export type Turn = {
  role: "user" | "assistant";
  text: string;
  language: "ar" | "en";
  sessionId?: string;
  agentId?: string;
  model?: string;
  at: number;
};

export type ToolSpec = { name: string; description: string };

export type BrainReply = {
  text: string;
  toolCalls: { name: string; input: Record<string, unknown> }[];
};

export type Brain = {
  ask(input: { text: string; tools: ToolSpec[] }): Promise<BrainReply>;
};
