import type { AccountId } from "@jarvis/core";
import { createClaudeStream } from "./stream-claude.js";
import { createCodexStream } from "./stream-codex.js";
import { createCopilotStream } from "./stream-copilot.js";
import { createGeminiStream } from "./stream-gemini.js";
import type { CliStreamParser } from "./stream-types.js";

export function streamFor(account: AccountId): CliStreamParser {
  switch (account) {
    case "claude":
      return createClaudeStream();
    case "chatgpt":
      return createCodexStream();
    case "gemini":
      return createGeminiStream();
    case "copilot":
      return createCopilotStream();
  }
}
