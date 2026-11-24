// The types the chat's parts share.
import type { AgentChatView } from "../../src/agent-chat-doc.js";

export type AgentOf = Extract<AgentChatView, { kind: "agent" }>;
export type { AgentChatView };

/** The part of Storage the chat uses; removeItem is optional for a test double. */
export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
};
