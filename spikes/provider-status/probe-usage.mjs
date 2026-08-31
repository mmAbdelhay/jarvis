import { query } from "@anthropic-ai/claude-agent-sdk";

const q = query({
  prompt: "Reply with exactly: ok",
  options: { maxTurns: 1 },
});

const usagePromise = (async () => {
  // fire early, race it against the whole conversation
  try {
    return await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
  } catch (e) {
    return { error: e && e.message };
  }
})();

const drain = (async () => {
  for await (const msg of q) {
    // just drain
  }
})();

const [usageOut] = await Promise.all([usagePromise, drain]);

console.log("=== usage() result ===");
console.log(JSON.stringify(usageOut && {
  subscription_type: usageOut.subscription_type,
  rate_limits_available: usageOut.rate_limits_available,
  rate_limits: usageOut.rate_limits,
  error: usageOut.error,
}, null, 2));
