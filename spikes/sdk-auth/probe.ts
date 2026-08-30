// spikes/sdk-auth/probe.ts
import { query } from "@anthropic-ai/claude-agent-sdk";

async function main() {
  console.log("ANTHROPIC_API_KEY set:", Boolean(process.env.ANTHROPIC_API_KEY));
  console.log("CLAUDE_CONFIG_DIR:", process.env.CLAUDE_CONFIG_DIR ?? "(unset)");

  try {
    for await (const message of query({
      prompt: "Reply with exactly the word: ok",
      options: { maxTurns: 1 },
    })) {
      console.log("MESSAGE:", JSON.stringify(message).slice(0, 400));
    }
    console.log("RESULT: SDK ran without an API key");
  } catch (error) {
    console.log("RESULT: SDK failed:", (error as Error).message);
  }
}

main();
