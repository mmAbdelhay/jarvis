// @jarvis/wire declares its own ChatTurn/ChatTool/ClaudePrompt/ClaudeMode
// (packages/wire/src/claude-view.ts) because wire must stay Node-free and
// workspace-package-free. desktop depends on wire, platform and core, so it
// is where the compile-time check lives that each pair describes the same
// shape, in both directions — the same check wire-transcript-dto.test.ts
// makes for TranscriptEntry.
import type { ClaudeMode as CoreClaudeMode, PendingPrompt } from "@jarvis/core";
import type { ChatTool as PlatformChatTool, ChatTurn as PlatformChatTurn } from "@jarvis/platform";
import type {
  ChatTool as WireChatTool,
  ChatTurn as WireChatTurn,
  ClaudeMode as WireClaudeMode,
  ClaudePrompt,
} from "@jarvis/wire";
import { describe, expect, it } from "vitest";

type AssertTrue<T extends true> = T;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// [bite-proof: add a required field to either side of any pair and `tsc -b`
// stops compiling here.]
export type ChatToolMatches = AssertTrue<Same<WireChatTool, PlatformChatTool>>;
export type ChatTurnMatches = AssertTrue<Same<WireChatTurn, PlatformChatTurn>>;
export type PromptMatches = AssertTrue<Same<ClaudePrompt, PendingPrompt>>;
export type ModeMatches = AssertTrue<Same<WireClaudeMode, CoreClaudeMode>>;

describe("wire's Claude view types mirror platform's and core's", () => {
  it("is the same shape in both directions (compile-time checks above)", () => {
    const turn: WireChatTurn & PlatformChatTurn = {
      role: "assistant",
      text: "done",
      tools: [{ name: "Edit", target: "a.ts", added: 1, removed: 0 }],
    };
    expect(Object.keys(turn).sort()).toEqual(["role", "text", "tools"]);
  });
});
